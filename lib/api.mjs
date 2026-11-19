import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { readState, updateState } from "./store.mjs";

const heartbeatTimeout = 30_000;
const commandLifetime = 60_000;

function json(value, status = 200) {
  return Response.json(value, { status, headers: { "Cache-Control": "no-store" } });
}

function validToken(header, secret) {
  if (!secret || !header?.startsWith("Bearer ")) return false;
  const digest = value => createHash("sha256").update(value).digest();
  return timingSafeEqual(digest(header.slice(7)), digest(secret));
}

function commandStatus(command, now) {
  return command.status === "pending" && command.expiresAt <= now ? "expired" : command.status;
}

function deviceStatus(lastSeen, now) {
  return { lastSeen, online: lastSeen !== null && now - lastSeen < heartbeatTimeout };
}

async function route(request, path) {
  const deviceOperation = path.startsWith("device/");
  const key = deviceOperation ? process.env.ORBI_DEVICE_TOKEN : process.env.ORBI_OWNER_PASSWORD;
  if (!key) return json({ error: "Server credentials are missing" }, 503);
  if (!validToken(request.headers.get("authorization"), key)) {
    return json({ error: deviceOperation ? "Invalid device token" : "Invalid owner password" }, 401);
  }

  const now = Date.now();
  if (request.method === "GET" && path === "status") {
    const state = await readState();
    const pi = deviceStatus(state.piAt, now);
    const esp32 = deviceStatus(state.esp32At, now);
    return json({
      pi,
      esp32: { ...esp32, online: pi.online && esp32.online },
      camera: {
        online: pi.online && state.camera?.online === true && now - state.camera.at < 30_000,
        lastSeen: state.camera?.at ?? null,
      },
      commands: state.commands.map(command => ({ ...command, status: commandStatus(command, now) })),
    });
  }

  if (request.method === "POST" && path === "device/camera") {
    const reader = request.body?.getReader();
    if (!reader) return json({ error: "JPEG required" }, 400);
    const chunks = [];
    let length = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > 160_000) {
        await reader.cancel();
        return json({ error: "Image exceeds 160 KB" }, 413);
      }
      chunks.push(Buffer.from(value));
    }
    const jpeg = Buffer.concat(chunks);
    if (request.headers.get("content-type") !== "image/jpeg" ||
        jpeg.length < 4 || jpeg[0] !== 255 || jpeg[1] !== 216 ||
        jpeg.at(-2) !== 255 || jpeg.at(-1) !== 217) {
      return json({ error: "JPEG required" }, 400);
    }
    const state = await updateState(current => {
      if (now - (current.camera?.imageAt ?? 0) < 8_000) return current;
      return { ...current, camera: {
        online: true, at: now, imageAt: now, jpeg: jpeg.toString("base64"),
      } };
    });
    if (state.camera.imageAt !== now) return json({ error: "Wait before uploading another snapshot" }, 429);
    return json({ accepted: true });
  }

  if (request.method === "POST" && path === "device/camera/offline") {
    await updateState(current => ({ ...current, camera: {
      ...current.camera, online: false, at: now, jpeg: null,
    } }));
    return json({ accepted: true });
  }

  if (request.method === "GET" && path === "camera") {
    const state = await readState();
    if (!state.camera?.jpeg || !state.camera.online ||
        now - state.camera.at >= 30_000 || now - (state.piAt ?? 0) >= 30_000) {
      return json({ error: "No recent camera snapshot" }, 404);
    }
    return new Response(Buffer.from(state.camera.jpeg, "base64"), {
      headers: {
        "Content-Type": "image/jpeg",
        "Cache-Control": "private, no-store",
        "X-Content-Type-Options": "nosniff",
        "Content-Security-Policy": "default-src 'none'; sandbox",
      },
    });
  }

  if (request.method === "POST" && path === "device/heartbeat") {
    const body = await request.json().catch(() => null);
    if (typeof body?.esp32Connected !== "boolean") {
      return json({ error: "esp32Connected must be a boolean" }, 400);
    }
    await updateState(state => now < (state.piAt ?? 0) ? state : ({
      ...state, piAt: now, esp32At: body.esp32Connected ? now : null,
    }));
    return json({ accepted: true });
  }

  if (request.method === "POST" && path === "commands") {
    const command = {
      id: randomUUID(), type: "ping", status: "pending", createdAt: now, expiresAt: now + commandLifetime,
    };
    await updateState(state => {
      const pending = state.commands.filter(item => commandStatus(item, now) === "pending");
      if (pending.length >= 20) return state;
      const history = state.commands.filter(item => commandStatus(item, now) !== "pending");
      return { ...state, commands: [command, ...pending, ...history].slice(0, 20) };
    }).then(state => {
      if (!state.commands.some(item => item.id === command.id)) throw new QueueFull();
    });
    return json(command, 201);
  }

  if (request.method === "GET" && path === "device/commands") {
    const state = await readState();
    return json({ commands: state.commands.filter(item => commandStatus(item, now) === "pending").reverse() });
  }

  const result = /^device\/commands\/([0-9a-f-]+)\/result$/.exec(path);
  if (request.method === "POST" && result) {
    const body = await request.json().catch(() => null);
    if (typeof body?.ok !== "boolean") return json({ error: "ok must be a boolean" }, 400);
    const status = body.ok ? "succeeded" : "failed";
    const state = await updateState(current => ({
      ...current,
      commands: current.commands.map(command => command.id === result[1] &&
        commandStatus(command, now) === "pending" ? { ...command, status, finishedAt: now } : command),
    }));
    const command = state.commands.find(item => item.id === result[1]);
    if (!command) return json({ error: "Command not found" }, 404);
    if (command.status !== status) return json({ error: "Command is expired or already resolved" }, 409);
    return json(command);
  }

  return json({ error: "Route not found" }, 404);
}

class QueueFull extends Error {}

export async function handleRequest(request, path) {
  try {
    return await route(request, path);
  } catch (error) {
    if (error instanceof QueueFull) return json({ error: "Command queue is full" }, 429);
    console.error("ORBI API:", error.message);
    return json({ error: "ORBI backend is unavailable" }, 503);
  }
}
