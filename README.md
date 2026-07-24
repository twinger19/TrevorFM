# Frediohead FM — Program Director console

The web console for Frediohead FM. It does ONE job now: edit the station's
weekly programming grid (shows, hours, briefs, hosts) and keep it in sync
with the iOS app through the Cloudflare Worker in `cloudflare-sync/`.

Playback, the AI DJ, voices, and everything on-air live in the iOS app,
which plays through Apple Music. This page is the desk with the big
keyboard where the week gets programmed.

## Run locally

```
node server.js
```

Then open http://127.0.0.1:8888. Or host the folder as any static site.

## Setup

Open Settings (gear icon) and paste the same Sync URL + secret the iOS app
uses (iOS: Settings ▸ Schedule Sync). Edits push on save; the console also
pulls once a minute, so changes made on the phone appear here on their own.
