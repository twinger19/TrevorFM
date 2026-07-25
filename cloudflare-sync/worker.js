// Frediohead FM Worker — two jobs, both tiny.
//
// 1. SYNC STORE. One JSON blob in KV under "schedule", shared by the iOS app
//    and the web station: the weekly grid, custom moods, thumbs-down vetoes,
//    and the DJ override.
//      GET  /  -> the blob (or null if nothing stored yet)
//      PUT  /  -> overwrite it (body is the full JSON)
//
// 2. MUSICKIT DEVELOPER TOKEN. MusicKit JS needs a JWT signed with your
//    Apple private key. That key must never reach a browser — especially not
//    from a public repo — so it lives here as a Worker secret and this
//    endpoint hands out short-lived signed tokens.
//      GET  /musickit-token -> { token, expiresAt }
//
// Every request must carry the shared secret in the `x-sync-secret` header.
// CORS is open so the browser app (a different origin) can call it.
//
// ── SETUP ───────────────────────────────────────────────────────────────
// Requires a KV namespace bound as `KV`, plus — for the token endpoint —
// three Worker settings (Worker ▸ Settings ▸ Variables):
//   MUSICKIT_TEAM_ID     your 10-char Apple Team ID          (plaintext ok)
//   MUSICKIT_KEY_ID      the 10-char Key ID from the .p8     (plaintext ok)
//   MUSICKIT_PRIVATE_KEY the .p8 file's FULL contents        (SECRET — encrypt)
//   ELEVENLABS_KEY       your ElevenLabs API key             (SECRET — encrypt)
// Paste the .p8 including the -----BEGIN PRIVATE KEY----- lines.
//
// 3. VOICE PROXY. Browsers can't call ElevenLabs directly (no CORS), so
//    Lotus and Marlowe speak through here — which also keeps that key off
//    the page.
//      PUT  /speak  { text, voiceId } -> audio/mpeg

const SECRET = "tfm_99fdf2ec98f6b336c30e1301547d307a2f5ac5ee";
const KEY = "schedule";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, PUT, OPTIONS",
  "Access-Control-Allow-Headers": "content-type, x-sync-secret",
};

const TOKEN_TTL_SECONDS = 60 * 60 * 12; // short-lived; the app refetches freely

export default {
  async fetch(request, env) {
    if (request.method === "OPTIONS") {
      return new Response(null, { headers: CORS });
    }
    if (request.headers.get("x-sync-secret") !== SECRET) {
      return new Response("forbidden", { status: 403, headers: CORS });
    }

    const url = new URL(request.url);

    if (url.pathname.endsWith("/musickit-token")) {
      try {
        const token = await mintDeveloperToken(env);
        return json({ token, expiresAt: Date.now() + TOKEN_TTL_SECONDS * 1000 });
      } catch (e) {
        return json({ error: e.message }, 500);
      }
    }

    // ElevenLabs speaks through here rather than from the page: browsers
    // can't call their API directly (no CORS headers), and this keeps the
    // API key server-side instead of shipping it to every visitor.
    if (url.pathname.endsWith("/speak") && request.method === "PUT") {
      if (!env.ELEVENLABS_KEY) {
        return json({ error: "ELEVENLABS_KEY isn't set on the Worker." }, 500);
      }
      const { text, voiceId } = await request.json();
      if (!text || !voiceId) return json({ error: "text and voiceId are required" }, 400);
      const upstream = await fetch(
        `https://api.elevenlabs.io/v1/text-to-speech/${voiceId}?output_format=mp3_44100_64`,
        {
          method: "POST",
          headers: { "xi-api-key": env.ELEVENLABS_KEY, "content-type": "application/json" },
          body: JSON.stringify({
            text,
            model_id: "eleven_turbo_v2_5",
            voice_settings: { stability: 0.7, similarity_boost: 0.8 },
          }),
        }
      );
      if (!upstream.ok) {
        return json({ error: `ElevenLabs ${upstream.status}: ${await upstream.text()}` }, upstream.status);
      }
      return new Response(upstream.body, {
        headers: { ...CORS, "content-type": "audio/mpeg" },
      });
    }

    if (request.method === "GET") {
      const value = await env.KV.get(KEY);
      return new Response(value || "null", {
        headers: { ...CORS, "content-type": "application/json" },
      });
    }
    if (request.method === "PUT") {
      await env.KV.put(KEY, await request.text());
      return new Response("ok", { headers: CORS });
    }
    return new Response("method not allowed", { status: 405, headers: CORS });
  },
};

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { ...CORS, "content-type": "application/json" },
  });
}

// MARK: - The developer token
//
// Apple wants ES256 (ECDSA P-256 + SHA-256), the Team ID as issuer, and the
// Key ID in the header. Workers ship WebCrypto, so no libraries are needed.

async function mintDeveloperToken(env) {
  const teamId = env.MUSICKIT_TEAM_ID;
  const keyId = env.MUSICKIT_KEY_ID;
  const pem = env.MUSICKIT_PRIVATE_KEY;
  if (!teamId || !keyId || !pem) {
    throw new Error("Missing MUSICKIT_TEAM_ID / MUSICKIT_KEY_ID / MUSICKIT_PRIVATE_KEY in the Worker's variables.");
  }

  const now = Math.floor(Date.now() / 1000);
  const header = { alg: "ES256", kid: keyId, typ: "JWT" };
  const payload = { iss: teamId, iat: now, exp: now + TOKEN_TTL_SECONDS };

  const signingInput = `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(payload))}`;
  const key = await importPrivateKey(pem);
  const signature = await crypto.subtle.sign(
    { name: "ECDSA", hash: "SHA-256" },
    key,
    new TextEncoder().encode(signingInput)
  );
  return `${signingInput}.${b64urlBytes(new Uint8Array(signature))}`;
}

async function importPrivateKey(pem) {
  const body = pem
    .replace(/-----BEGIN PRIVATE KEY-----/, "")
    .replace(/-----END PRIVATE KEY-----/, "")
    .replace(/\s+/g, "");
  const der = Uint8Array.from(atob(body), (c) => c.charCodeAt(0));
  return crypto.subtle.importKey(
    "pkcs8",
    der,
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["sign"]
  );
}

function b64url(str) {
  return b64urlBytes(new TextEncoder().encode(str));
}

function b64urlBytes(bytes) {
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
