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
// Requires a KV namespace bound as `KV`, plus these Worker settings
// (Worker ▸ Settings ▸ Variables):
//   SYNC_SECRET          the shared secret, same as the apps (SECRET — encrypt)
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

// The shared secret lives in the Worker's own settings, NOT in this file.
// It used to be a literal here — which meant publishing it to anyone who
// read the repo, since this is public. Set SYNC_SECRET under
// Worker ▸ Settings ▸ Variables (encrypt it), using the same value the iOS
// app and the web Settings page carry.
const KEY = "schedule";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, PUT, OPTIONS",
  "Access-Control-Allow-Headers": "content-type, x-sync-secret, x-eleven-key",
};

const TOKEN_TTL_SECONDS = 60 * 60 * 12; // short-lived; the app refetches freely

export default {
  async fetch(request, env) {
    if (request.method === "OPTIONS") {
      return new Response(null, { headers: CORS });
    }
    // No secret configured means this Worker cannot authenticate anyone —
    // fail loudly rather than falling open, and say exactly what's missing.
    const secret = env.SYNC_SECRET;
    if (!secret) {
      return json(
        { error: "SYNC_SECRET isn't set on this Worker. Add it under Settings ▸ Variables (encrypted), then Deploy." },
        500
      );
    }
    if (request.headers.get("x-sync-secret") !== secret) {
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
      // A key sent by the client wins over the stored one. That's the escape
      // hatch for a rotated/revoked ELEVENLABS_KEY: the listener can fix it
      // from Settings instead of being mute until this Worker is edited.
      const clientKey = request.headers.get("x-eleven-key");
      const apiKey = clientKey || env.ELEVENLABS_KEY;
      if (!apiKey) {
        return json({ error: "No ElevenLabs key — set ELEVENLABS_KEY on the Worker, or paste one in Settings." }, 500);
      }
      const { text, voiceId } = await request.json();
      if (!text || !voiceId) return json({ error: "text and voiceId are required" }, 400);
      const upstream = await fetch(
        `https://api.elevenlabs.io/v1/text-to-speech/${voiceId}?output_format=mp3_44100_64`,
        {
          method: "POST",
          headers: { "xi-api-key": apiKey, "content-type": "application/json" },
          body: JSON.stringify({
            text,
            model_id: "eleven_turbo_v2_5",
            voice_settings: { stability: 0.7, similarity_boost: 0.8 },
          }),
        }
      );
      if (!upstream.ok) {
        // Name the failure mode, and say which key actually failed — the
        // stored one and a pasted one need different fixes.
        const whose = clientKey ? "The key in Settings" : "The Worker's stored ELEVENLABS_KEY";
        const body = await upstream.text();
        const error =
          upstream.status === 401
            ? `${whose} was rejected by ElevenLabs (401). If you rotated it, paste the current key in Settings.`
            : upstream.status === 402
              ? `ElevenLabs won't serve this voice on the current plan (402) — Voice Library voices need a paid plan.`
              : `ElevenLabs ${upstream.status}: ${body}`;
        return json({ error }, upstream.status);
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
