const empty = { piAt: null, esp32At: null, commands: [] };
const local = globalThis.orbiDevelopmentStore ??= { snapshot: empty };

async function databaseRequest(method, query, body) {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SECRET_KEY;
  if (!url || !key) throw new Error("Supabase configuration is incomplete");
  const response = await fetch(`${url.replace(/\/$/, "")}/rest/v1/orbi_state?${query}`, {
    method,
    headers: { apikey: key, "Content-Type": "application/json", Prefer: "return=representation" },
    body: body === undefined ? undefined : JSON.stringify(body),
    cache: "no-store",
  });
  if (!response.ok) throw new Error(`State store returned HTTP ${response.status}`);
  return response.json();
}

const useLocalStore = () =>
  process.env.NODE_ENV !== "production" && !process.env.SUPABASE_URL && !process.env.SUPABASE_SECRET_KEY;

export async function readState() {
  if (useLocalStore()) return local.snapshot;
  const [row] = await databaseRequest("GET", "id=eq.1&select=snapshot");
  if (!row) throw new Error("Apply schema.sql before using the backend");
  return row.snapshot;
}

export async function updateState(update) {
  if (useLocalStore()) {
    local.snapshot = update(local.snapshot);
    return local.snapshot;
  }
  for (let attempt = 0; attempt < 6; attempt++) {
    const [row] = await databaseRequest("GET", "id=eq.1&select=revision,snapshot");
    if (!row) throw new Error("Apply schema.sql before using the backend");
    const snapshot = update(row.snapshot);
    const rows = await databaseRequest("PATCH", `id=eq.1&revision=eq.${row.revision}`, {
      revision: row.revision + 1,
      snapshot,
    });
    if (rows.length) return snapshot;
  }
  throw new Error("State changed concurrently");
}
