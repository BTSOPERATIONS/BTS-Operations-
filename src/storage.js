// Storage adapter. The app calls window.storage.get/set.
//  - Default: saves in this browser (localStorage) -> works with zero setup,
//    but each person/computer sees only its own data.
//  - If VITE_SUPABASE_URL + VITE_SUPABASE_ANON_KEY are set at build time:
//    saves to a shared Supabase table so the whole team sees the same data.

const url = import.meta.env.VITE_SUPABASE_URL;
const anon = import.meta.env.VITE_SUPABASE_ANON_KEY;
const PREFIX = "bts:";

const local = {
  async get(key) {
    const v = localStorage.getItem(PREFIX + key);
    if (v === null) throw new Error("not found");
    return { key, value: v, shared: false };
  },
  async set(key, value) {
    localStorage.setItem(PREFIX + key, value);
    return { key, value, shared: false };
  },
  async delete(key) {
    localStorage.removeItem(PREFIX + key);
    return { key, deleted: true, shared: false };
  },
};

// New "sb_publishable_..." keys go in the apikey header only.
// Old "eyJ..." (legacy anon) keys are JWTs and are also sent as a Bearer token.
const headers = {
  apikey: anon,
  "Content-Type": "application/json",
};
if (anon && anon.startsWith("eyJ")) headers.Authorization = "Bearer " + anon;

const remote = {
  async get(key) {
    const r = await fetch(`${url}/rest/v1/kv?key=eq.${encodeURIComponent(key)}&select=value`, { headers });
    if (!r.ok) throw new Error("fetch failed");
    const rows = await r.json();
    if (!rows.length) throw new Error("not found");
    return { key, value: rows[0].value, shared: true };
  },
  async set(key, value) {
    const r = await fetch(`${url}/rest/v1/kv`, {
      method: "POST",
      headers: { ...headers, Prefer: "resolution=merge-duplicates,return=minimal" },
      body: JSON.stringify({ key, value }),
    });
    if (!r.ok) throw new Error("save failed");
    return { key, value, shared: true };
  },
  async delete(key) {
    const r = await fetch(`${url}/rest/v1/kv?key=eq.${encodeURIComponent(key)}`, {
      method: "DELETE",
      headers,
    });
    if (!r.ok) throw new Error("delete failed");
    return { key, deleted: true, shared: true };
  },
};

window.storage = url && anon ? remote : local;
