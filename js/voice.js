// DJ voice: browser speech synthesis, with Spotify volume ducked while talking.
import { settings } from "./config.js";
import { spotify } from "./spotify.js";

export function availableVoices() {
  return speechSynthesis.getVoices().filter((v) => v.lang.startsWith("en"));
}

function pickVoice() {
  const voices = availableVoices();
  const chosen = voices.find((v) => v.name === settings.voiceName);
  // Prefer higher-quality local voices when none chosen.
  return chosen || voices.find((v) => /premium|enhanced|siri/i.test(v.name)) || voices[0] || null;
}

export function estimateSpeechSeconds(text) {
  return text.split(/\s+/).length * 0.42 + 0.8;
}

// onNearEnd (optional) fires when ~80% of the text has been spoken — the
// radio "hit the post" moment. Word-boundary events drive it, with a timer
// fallback for voices that don't emit boundaries.
function speak(text, onNearEnd) {
  return new Promise((resolve) => {
    const u = new SpeechSynthesisUtterance(text);
    const voice = pickVoice();
    if (voice) u.voice = voice;
    u.rate = 1.0;
    u.pitch = 1.0;
    let cued = !onNearEnd;
    const cue = () => { if (!cued) { cued = true; onNearEnd(); } };
    const cueAt = text.length * 0.8;
    u.onboundary = (e) => { if (e.charIndex >= cueAt) cue(); };
    const cueTimer = onNearEnd ? setTimeout(cue, estimateSpeechSeconds(text) * 800) : null;
    const done = () => { clearTimeout(cueTimer); resolve(); };
    u.onend = done;
    u.onerror = done;
    speechSynthesis.speak(u);
    // Safety: never hang the station on a stuck utterance.
    setTimeout(done, 30000);
  });
}

// Duck the music, say the line, bring it back to EXACTLY where it was.
// The pre-speech volume is read live from the player (not from settings,
// which can be stale) so the music always resumes at the listener's level.
export async function announceOverMusic(deviceId, text) {
  let before = settings.playVolume;
  try {
    const state = await spotify.playerState();
    if (typeof state?.device?.volume_percent === "number") before = state.device.volume_percent;
  } catch {}
  if (before < 5) before = settings.playVolume || 60; // never "restore" to silence
  try { await spotify.setVolume(deviceId, Math.min(settings.duckVolume, before)); } catch {}
  await new Promise((r) => setTimeout(r, 250));
  await speak(text);
  await new Promise((r) => setTimeout(r, 150));
  try { await spotify.setVolume(deviceId, before); } catch {}
}

// Real-radio talk-up: Fred speaks over the outro of the current song, the
// next one starts under his last words (via startSong at ~80% spoken), and
// the volume fades back up as he signs off.
export async function talkThenStart(deviceId, text, startSong) {
  let before = settings.playVolume;
  try {
    const state = await spotify.playerState();
    if (typeof state?.device?.volume_percent === "number") before = state.device.volume_percent;
  } catch {}
  if (before < 5) before = settings.playVolume || 60;
  let started = false;
  const kick = () => {
    if (started) return;
    started = true;
    try { startSong(); } catch {}
  };
  try { await spotify.setVolume(deviceId, Math.min(settings.duckVolume, before)); } catch {}
  await new Promise((r) => setTimeout(r, 200));
  await speak(text, kick);
  kick(); // guarantee the song starts even if the cue never fired
  await new Promise((r) => setTimeout(r, 150));
  try { await spotify.setVolume(deviceId, before); } catch {}
}
