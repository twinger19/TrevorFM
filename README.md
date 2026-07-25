# Frediohead FM — web

The station in a browser: Apple Music playback, an AI DJ that programs real
shows, three hosts with their own voices, a weekly schedule, one-tap moods,
and requests. Shares its programming with the iOS app through a Cloudflare
Worker.

## What runs where

- **This page** — playback (MusicKit JS), the booth, the drawers.
- **Your Cloudflare Worker** (`cloudflare-sync/`) — the sync blob, the
  MusicKit developer token, and the ElevenLabs voice proxy. Credentials live
  there, never in this repo or the browser.

## Setup

1. Deploy the Worker in `cloudflare-sync/` (its README has the steps) and set
   its variables: `MUSICKIT_TEAM_ID`, `MUSICKIT_KEY_ID`, `MUSICKIT_PRIVATE_KEY`
   (the `.p8` contents), and `ELEVENLABS_KEY`.
2. Open the site, hit the gear, and paste the **Worker URL + secret** and a
   **Gemini API key** (aistudio.google.com).
3. **Sign in to Apple Music**. An active subscription is required to play.

Then press power. The DJ reads your listening history, programs a block, and
goes on air.

## Run locally

```
node server.js     # http://127.0.0.1:8888
```

## The hosts

- **Fred** — the flat synthetic console voice, on-device speech synthesis.
- **Lotus** — quiet and philosophical, late nights (ElevenLabs).
- **Marlowe** — warm and human, mornings and drivetime (ElevenLabs).

Voices, personalities, and the schedule all sync with the iOS app.
