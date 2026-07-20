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

## Put it in both apps

In **each** app's Settings, paste:
- **Sync URL**: your Worker URL from step 6
- **Sync secret**: `tfm_99fdf2ec98f6b336c30e1301547d307a2f5ac5ee`
  (this is already baked into `worker.js` — the apps just need the same value)

That's it. Edit the schedule on either app; the other picks it up next time it
opens. Last edit wins.

## Notes

- The secret is the only thing guarding read/write. It's in the Worker code
  (private to your Cloudflare account) and in each app's local settings — never
  in the public web repo.
- To rotate the secret later: change `SECRET` in `worker.js`, redeploy, and
  update both apps' Settings.
