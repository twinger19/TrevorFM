// Frediohead FM sync Worker — a tiny key/value store for the schedule so the
// web app and the iOS app share one source of truth.
//
// It holds a single JSON blob in Cloudflare KV under the key "schedule".
// - GET  -> returns the blob (or null if nothing stored yet)
// - PUT  -> overwrites the blob (body is the full JSON)
// Every request must carry the shared secret in the `x-sync-secret` header.
// CORS is open so the browser app (a different origin) can call it.
//
// Requires a KV namespace bound to this Worker as `KV` (see README).

const SECRET = "tfm_99fdf2ec98f6b336c30e1301547d307a2f5ac5ee";
const KEY = "schedule";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, PUT, OPTIONS",
  "Access-Control-Allow-Headers": "content-type, x-sync-secret",
};

export default {
  async fetch(request, env) {
    if (request.method === "OPTIONS") {
      return new Response(null, { headers: CORS });
    }
    if (request.headers.get("x-sync-secret") !== SECRET) {
      return new Response("forbidden", { status: 403, headers: CORS });
    }
    if (request.method === "GET") {
      const value = await env.KV.get(KEY);
      return new Response(value || "null", {
        headers: { ...CORS, "content-type": "application/json" },
      });
    }
    if (request.method === "PUT") {
      const body = await request.text();
      await env.KV.put(KEY, body);
      return new Response("ok", { headers: CORS });
    }
    return new Response("method not allowed", { status: 405, headers: CORS });
  },
};
