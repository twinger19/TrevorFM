// The DJ voices, with the music ducked underneath while they talk.
//
// Two engines, chosen per host from the registry:
//  • "system" — the browser's speech synthesis (Fred's flat robot). Free,
//    instant, always available.
//  • "eleven" — ElevenLabs (Lotus, Marlowe). Routed through the Cloudflare
//    Worker: browsers can't call ElevenLabs directly (no CORS), and the key
//    stays server-side. Audio is fetched BEFORE the duck, so the network
//    latency happens over full-volume music instead of over silence.
//
// Any ElevenLabs failure falls back to the browser voice, so the show never
// goes silent — and the reason is logged once rather than swallowed.
import { settings } from "./config.js";
import { music } from "./musickit.js";
import { findDJ } from "./djs.js";

let voiceLogger = (msg) => console.warn(msg);
export function setVoiceLogger(fn) { voiceLogger = fn; }
let warnedProxy = false;

export function availableVoices() {
  return speechSynthesis.getVoices().filter((v) => v.lang.startsWith("en"));
}

function pickVoice(match) {
  const voices = availableVoices();
  if (settings.voiceName) {
    const named = voices.find((v) => v.name === settings.voiceName);
    if (named) return named;
  }
  return (
    (match && voices.find((v) => match.test(v.name))) ||
    voices.find((v) => /premium|enhanced|siri/i.test(v.name)) ||
    voices[0] ||
    null
  );
}

export function estimateSpeechSeconds(text) {
  return text.split(/\s+/).length * 0.42 + 0.8;
}

// --- browser speech ---

function speakSystem(text, match, onNearEnd) {
  return new Promise((resolve) => {
    const u = new SpeechSynthesisUtterance(text);
    const voice = pickVoice(match);
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
    setTimeout(done, 30000); // never hang the station on a stuck utterance
  });
}

// --- ElevenLabs, via the Worker ---

const audioCache = new Map(); // "voiceId|text" -> object URL

async function fetchVoiceAudio(text, voiceId) {
  const cacheKey = `${voiceId}|${text}`;
  if (audioCache.has(cacheKey)) return audioCache.get(cacheKey);
  if (!settings.syncUrl || !settings.syncSecret) {
    throw new Error("no Worker configured");
  }
  const url = settings.syncUrl.replace(/\/+$/, "") + "/speak";
  const res = await fetch(url, {
    method: "PUT",
    headers: { "x-sync-secret": settings.syncSecret, "content-type": "application/json" },
    body: JSON.stringify({ text, voiceId }),
  });
  if (!res.ok) {
    let detail = `HTTP ${res.status}`;
    try { detail = (await res.json()).error || detail; } catch {}
    throw new Error(detail);
  }
  const objectUrl = URL.createObjectURL(await res.blob());
  audioCache.set(cacheKey, objectUrl);
  if (audioCache.size > 8) {
    const oldest = audioCache.keys().next().value;
    URL.revokeObjectURL(audioCache.get(oldest));
    audioCache.delete(oldest);
  }
  return objectUrl;
}

function playAudioUrl(url, onNearEnd) {
  return new Promise((resolve) => {
    const audio = new Audio(url);
    let cued = !onNearEnd;
    const cue = () => { if (!cued) { cued = true; onNearEnd(); } };
    const done = () => { cue(); resolve(); };
    audio.ontimeupdate = () => {
      if (audio.duration && audio.currentTime / audio.duration >= 0.8) cue();
    };
    audio.onended = done;
    audio.onerror = done;
    audio.play().catch(done);
    setTimeout(done, 60000);
  });
}

// Warm a line up before it's needed, so the talk-up starts on the beat.
export function prefetchLine(text, djId) {
  const host = findDJ(djId);
  if (host.voice.kind !== "eleven") return;
  fetchVoiceAudio(text, host.voice.voiceId).catch(() => {});
}

// Prepare a speaker BEFORE ducking. A network voice that fails here quietly
// hands the mic to the browser voice.
async function prepareSpeaker(djId, text) {
  const host = findDJ(djId);
  if (host.voice.kind === "eleven") {
    try {
      const url = await fetchVoiceAudio(text, host.voice.voiceId);
      return { play: (onNearEnd) => playAudioUrl(url, onNearEnd) };
    } catch (e) {
      if (!warnedProxy) {
        warnedProxy = true;
        voiceLogger(`${host.name}'s voice is unavailable (${e.message}) — Fred is covering.`);
      }
    }
  }
  return { play: (onNearEnd) => speakSystem(text, host.voice.match, onNearEnd) };
}

// MusicKit's volume is 0–1; settings store 0–100.
function currentVolume() {
  const v = music.instance?.volume;
  return typeof v === "number" ? v : (settings.playVolume ?? 70) / 100;
}
function setVolume(v) {
  if (music.instance) music.instance.volume = Math.max(0, Math.min(1, v));
}

// Duck the music, say the line, bring it back to exactly where it was.
export async function announceOverMusic(text, djId = "fred") {
  const speaker = await prepareSpeaker(djId, text);
  const before = currentVolume();
  setVolume(Math.min((settings.duckVolume ?? 20) / 100, before));
  await new Promise((r) => setTimeout(r, 250));
  await speaker.play();
  await new Promise((r) => setTimeout(r, 150));
  setVolume(before);
}

// Real-radio talk-up: the DJ speaks over the outro, the next song starts
// under the last words (startSong fires at ~80% spoken), and the volume
// comes back up on the sign-off.
export async function talkThenStart(text, startSong, djId = "fred") {
  const speaker = await prepareSpeaker(djId, text);
  const before = currentVolume();
  let started = false;
  const kick = () => {
    if (started) return;
    started = true;
    try { startSong(); } catch {}
  };
  setVolume(Math.min((settings.duckVolume ?? 20) / 100, before));
  await new Promise((r) => setTimeout(r, 200));
  await speaker.play(kick);
  kick(); // guarantee the song starts even if the cue never fired
  await new Promise((r) => setTimeout(r, 150));
  setVolume(before);
}
