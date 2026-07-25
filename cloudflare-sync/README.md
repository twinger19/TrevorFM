# Frediohead FM — schedule sync Worker

A ~30-line Cloudflare Worker that stores your schedule JSON so the web app and
the iOS app stay in sync. Free tier, data lives only on your Cloudflare account.

## One-time setup (~10 min, dashboard, no CLI needed)

1. Create a free account at **dash.cloudflare.com**.
2. In the sidebar: **Storage & Databases → KV → Create a namespace**. Name it
   `frediradio` (anything). You'll see it listed.
3. In the sidebar: **Workers & Pages → Create → Create Worker**. Give it a name
   like `frediradio-sync` and **Deploy** (the default hello-world is fine for now).
4. Open the new Worker → **Edit code**. Delete everything, paste the full
   contents of `worker.js` from this folder, then **Deploy**.
5. Bind the KV namespace: Worker → **Settings → Bindings → Add → KV namespace**.
   - Variable name: **`KV`** (must be exactly this)
   - KV namespace: pick the `frediradio` one from step 2
   - Save, then **Deploy** once more.
6. Copy your Worker's URL from the top of the Worker page — it looks like
   `https://frediradio-sync.YOURNAME.workers.dev`.

7. Add the Worker's settings: Worker → **Settings → Variables**. Add
   **`SYNC_SECRET`** and click **Encrypt**. Generate a value with:

   ```
   openssl rand -hex 20
   ```

   Then **Deploy**. (The token and voice endpoints need `MUSICKIT_TEAM_ID`,
   `MUSICKIT_KEY_ID`, `MUSICKIT_PRIVATE_KEY` and `ELEVENLABS_KEY` here too —
   see the header comment in `worker.js`.)

## Put it in both apps

In **each** app's Settings, paste:
- **Sync URL**: your Worker URL from step 6
- **Sync secret**: the same `SYNC_SECRET` value you set in step 7

That's it. Edit the schedule on either app; the other picks it up next time it
opens. Last edit wins.

## About the secret

The secret is the only thing guarding read/write on your Worker, and the only
thing stopping a stranger from running up your ElevenLabs bill through the
`/speak` proxy.

**It must never be written in `worker.js`.** This repo is public, so a literal
there is published to everyone. It lives in the Worker's encrypted variables
and in each app's local settings instead — three places, same value, none of
them in git.

### Rotating it

Do this if the value was ever committed, pasted into a chat, or shared.

1. Generate a new one: `openssl rand -hex 20`
2. Worker → **Settings → Variables** → update `SYNC_SECRET` → **Deploy**.
3. Paste the same value into **iOS Settings → Schedule sync → Sync secret**.
4. Paste it into **web Settings → Schedule sync secret**.

Sync is down between steps 2 and 4 — the apps get a `403` until their secret
matches again. Nothing is lost; the schedule sits in KV the whole time.
