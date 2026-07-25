// Synced lyrics from LRCLIB (lrclib.net) — free, open, no key, CORS-friendly.
// Returns [{ t: ms, text }] sorted by time, or null when nothing synced exists.

function cleanTitle(name) {
  return name.replace(/\s*[([](feat\.?|with|ft\.?)[^)\]]*[)\]]/gi, "").trim();
}

function parseLRC(lrc) {
  const lines = [];
  for (const raw of lrc.split("\n")) {
    const stamps = [...raw.matchAll(/\[(\d+):(\d+(?:\.\d+)?)\]/g)];
    if (!stamps.length) continue;
    const text = raw.replace(/\[[^\]]*\]/g, "").trim();
    for (const m of stamps) {
      lines.push({ t: (Number(m[1]) * 60 + Number(m[2])) * 1000, text });
    }
  }
  lines.sort((a, b) => a.t - b.t);
  return lines.length ? lines : null;
}

export async function fetchSyncedLyrics({ artist, track, album, durationSec }) {
  const title = cleanTitle(track);
  let rec = null;
  try {
    const params = new URLSearchParams({ track_name: title, artist_name: artist });
    if (album) params.set("album_name", album);
    if (durationSec) params.set("duration", String(Math.round(durationSec)));
    const r = await fetch(`https://lrclib.net/api/get?${params}`);
    if (r.ok) rec = await r.json();
  } catch {}
  if (!rec?.syncedLyrics) {
    try {
      const params = new URLSearchParams({ track_name: title, artist_name: artist });
      const r = await fetch(`https://lrclib.net/api/search?${params}`);
      if (r.ok) {
        const list = await r.json();
        rec = (list || []).find((x) => x.syncedLyrics) || null;
      }
    } catch {}
  }
  return rec?.syncedLyrics ? parseLRC(rec.syncedLyrics) : null;
}
