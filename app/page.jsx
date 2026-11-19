"use client";

import { useCallback, useEffect, useState } from "react";

const clock = value => value ? new Date(value).toLocaleTimeString() : "—";

function CameraPreview({ credential, camera }) {
  const [image, setImage] = useState("");
  const [error, setError] = useState("");
  useEffect(() => {
    if (!camera?.online) return;
    let cancelled = false;
    let objectUrl = "";
    fetch("/api/camera", {
      headers: { Authorization: `Bearer ${credential}` },
      cache: "no-store",
    }).then(async response => {
      if (!response.ok) throw new Error("Snapshot unavailable");
      const blob = await response.blob();
      if (cancelled) return;
      objectUrl = URL.createObjectURL(blob);
      setImage(objectUrl);
      setError("");
    }).catch(failure => {
      if (!cancelled) { setImage(""); setError(failure.message); }
    });
    return () => { cancelled = true; if (objectUrl) URL.revokeObjectURL(objectUrl); };
  }, [credential, camera?.online, camera?.lastSeen]);
  return <section className="commands">
    <div className="section-title"><h2>Camera preview</h2>
      <span>{camera?.online ? "Online" : "Offline"}</span></div>
    {camera?.online && image
      ? <img className="camera-preview" src={image} alt="Latest ORBI camera snapshot" />
      : <p>{error || "Waiting for a camera snapshot."}</p>}
    <small>Snapshots update about every 10 seconds. Last received {clock(camera?.lastSeen)}</small>
  </section>;
}

function Device({ name, connection, status }) {
  return <article className="device">
    <div><h2>{name}</h2><p>{connection}</p></div>
    <span className={status.online ? "online" : "offline"}>{status.online ? "Online" : "Offline"}</span>
    <small>Last seen {clock(status.lastSeen)}</small>
  </article>;
}

export default function Dashboard() {
  const [password, setPassword] = useState("");
  const [credential, setCredential] = useState("");
  const [status, setStatus] = useState(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const request = useCallback(async (path, token, method = "GET") => {
    const response = await fetch(`/api/${path}`, {
      method, headers: { Authorization: `Bearer ${token}` }, cache: "no-store",
    });
    const body = await response.json();
    if (!response.ok) throw new Error(body.error ?? "Request failed");
    return body;
  }, []);

  useEffect(() => {
    if (!credential) return;
    let cancelled = false;
    const timer = setInterval(async () => {
      try {
        const updated = await request("status", credential);
        if (!cancelled) { setStatus(updated); setError(""); }
      } catch (failure) {
        if (!cancelled) setError(failure.message);
      }
    }, 3000);
    return () => { cancelled = true; clearInterval(timer); };
  }, [credential, request]);

  async function signIn(event) {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      setStatus(await request("status", password));
      setCredential(password);
      setPassword("");
    } catch (failure) {
      setError(failure.message);
    } finally {
      setBusy(false);
    }
  }

  async function sendPing() {
    setBusy(true);
    setError("");
    try {
      await request("commands", credential, "POST");
      setStatus(await request("status", credential));
    } catch (failure) {
      setError(failure.message);
    } finally {
      setBusy(false);
    }
  }

  return <main>
    <header><div className="brand">ORBI</div>{credential && <button className="quiet" onClick={() => {
      setCredential(""); setStatus(null); setError("");
    }}>Sign out</button>}</header>
    <h1>Device dashboard</h1>
    {!status ? <form onSubmit={signIn}>
      <label htmlFor="password">Owner password</label>
      <input id="password" type="password" autoComplete="current-password" required value={password}
        onChange={event => setPassword(event.target.value)} />
      <button disabled={busy}>Sign in</button>
    </form> : <>
      <section className="devices" aria-label="Device status">
        <Device name="Raspberry Pi" connection="Cloud connection" status={status.pi} />
        <Device name="ESP32" connection="USB serial via Raspberry Pi" status={status.esp32} />
      </section>
      <CameraPreview credential={credential} camera={status.camera} />
      <section className="commands">
        <div className="section-title"><h2>Connection test</h2>
          <button disabled={busy || !status.esp32.online} onClick={sendPing}>Ping ESP32</button></div>
        {status.commands.length ? <ul>{status.commands.map(command => <li key={command.id}>
          <span>ESP32 ping <small>{clock(command.createdAt)}</small></span><span>{command.status}</span>
        </li>)}</ul> : <p>Test results will appear here.</p>}
      </section>
    </>}
    {error && <p className="error" role="alert">{error}</p>}
  </main>;
}
