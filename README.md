# TREVOR FM

A personal AI radio station in the spirit of [Subwave](https://github.com/perminder-klair/subwave),
but with Spotify as the player. A Gemini DJ reads your Spotify taste, programs blocks of tracks
from the full catalog, queues them on your Spotify desktop app (which plays in the background),
and announces each track with a spoken intro while the music ducks.

No build step, no dependencies, no backend beyond a static file server. All keys stay in
your browser's localStorage.

## Run

```
node server.js
```

Then open http://127.0.0.1:8888 in Chrome or Safari.

## One-time setup

1. **Spotify app registration** (free): at developer.spotify.com/dashboard create an app,
   check "Web API", copy the Client ID into Settings (gear icon). Add a Redirect URI —
   Settings shows the exact string to use for wherever you're running the app (local vs.
   deployed); both can be registered on the same Spotify app at once.
2. **Connect Spotify** button, approve the permissions.
3. **Gemini key** from aistudio.google.com into Settings.
4. Open the Spotify desktop app once so it shows up as a device, pick it in the dropdown,
   hit **Start station**.

## Deploy (GitHub Pages)

The app is fully static (no backend), so it hosts as-is:

1. Push this repo to GitHub, enable Pages under Settings → Pages → Deploy from a branch
   (`main`, `/root`).
2. Open the site once, open Settings, copy the "Redirect URI to register in Spotify" value.
3. Add that exact URI as a second Redirect URI on the same Spotify app (alongside the
   local one) in the Spotify dashboard.
4. Paste your Client ID and Gemini key into Settings on the deployed site (each browser's
   localStorage is separate, so this is a one-time step per device/browser) and connect.

## Requirements

- Spotify Premium (the play/queue API and in-page playback require it)
- The tab must stay open: it runs the DJ loop and the voice

## Playback device

Two options in the device dropdown:
- **Play in this tab** (default): the page itself is the player, via the Web Playback SDK.
  Audio stops if the tab closes.
- **Spotify desktop app**: music plays in the app in the background and keeps playing
  even if the tab dies (though the DJ stops topping up the queue).

## Files

- `server.js` — static server, also serves the OAuth callback route
- `js/auth.js` — Spotify OAuth (PKCE, client-side, no secret)
- `js/spotify.js` — Web API wrapper (taste, search, playback control)
- `js/dj.js` — Gemini DJ: track picks + spoken intros, time-of-day aware
- `js/voice.js` — speech synthesis + volume ducking
- `js/station.js` — the station loop (poll, announce, top up the queue)
- `js/main.js`, `index.html`, `style.css` — the control-room UI
