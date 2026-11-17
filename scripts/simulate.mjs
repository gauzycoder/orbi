import { setTimeout } from "node:timers/promises";

const base = process.env.ORBI_URL || "http://localhost:3000";
const token = process.env.ORBI_DEVICE_TOKEN;
const esp32Connected = !process.argv.includes("--esp32-offline");
if (!token) throw new Error("Set ORBI_DEVICE_TOKEN before starting the simulator");

async function request(path, body) {
  const response = await fetch(`${base}/api/device/${path}`, {
    method: body ? "POST" : "GET",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: body && JSON.stringify(body),
    signal: AbortSignal.timeout(5000),
  });
  if (!response.ok) throw new Error(`${path} returned HTTP ${response.status}`);
  return response.json();
}

while (true) {
  try {
    await request("heartbeat", { esp32Connected });
    if (esp32Connected) {
      const { commands } = await request("commands");
      for (const command of commands) {
        await request(`commands/${command.id}/result`, { ok: true });
        console.log(`Acknowledged ${command.id}`);
      }
    }
  } catch (error) {
    console.error(error.message);
  }
  await setTimeout(3000);
}
