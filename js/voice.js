// DJ voices, with Spotify volume ducked while they talk.
// Two engines:
// - Fred: browser speech synthesis (the classic robot).
// - Lotus: ElevenLabs TTS (low, steady, unhurried). Pre-fetched before the duck so
//   there's no dead air; any failure falls back to Fred so the show goes on.
//   NOTE: ElevenLabs does not allow direct browser calls (no CORS), so Lotus
//   cannot speak on the WEB app — she works in the native iOS app. On web she
//   always falls back to Fred; the reason is logged once so it isn't silent.
import { settings } from "./config.js";
import { spotify } from "./spotify.js";

// The station wires this to the booth log so voice fallbacks are visible.
let voiceLogger = (msg) => console.warn(msg);
export function setVoiceLogger(fn) { voiceLogger = fn; }
let warnedLotusWeb = false;

export function availableVoices() {
  return speechSynthesis.getVoices().filter((v) => v.lang.startsWith("en"));
}

function pickVoice() {
  const voices = availableVoices();
  const chosen = voices.find((v) => v.name === settings.voiceName);
  return chosen || voices.find((v) => /premium|enhanced|siri/i.test(v.name)) || voices[0] || null;
}

export function estimateSpeechSeconds(text) {
  return text.split(/\s+/).length * 0.42 + 0.8;
}

// --- Fred engine (speechSynthesis) ---

function speakFred(text, onNearEnd) {
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
    setTimeout(done, 30000); // never hang the station on a stuck utterance
  });
}

// --- Lotus engine (ElevenLabs) ---

async function fetchLotusAudio(text) {
  const key = settings.elevenKey;
  if (!key) throw new Error("No ElevenLabs key in Settings");
  const res = await fetch(
    `https://api.elevenlabs.io/v1/text-to-speech/${settings.elevenVoiceId}?output_format=mp3_44100_64`,
    {
      method: "POST",
      headers: { "xi-api-key": key, "Content-Type": "application/json" },
      body: JSON.stringify({
        text,
        model_id: "eleven_turbo_v2_5",
        // High stability = the low, steady, unhurried delivery Lotus calls for.
        voice_settings: { stability: 0.7, similarity_boost: 0.8 },
      }),
    }
  );
  if (!res.ok) throw new Error(`ElevenLabs ${res.status}`);
  return URL.createObjectURL(await res.blob());
}

function playAudioUrl(url, onNearEnd) {
  return new Promise((resolve) => {
    const audio = new Audio(url);
    let cued = !onNearEnd;
    const cue = () => { if (!cued) { cued = true; onNearEnd(); } };
    const done = () => { cue(); URL.revokeObjectURL(url); resolve(); };
    audio.ontimeupdate = () => {
      if (audio.duration && audio.currentTime / audio.duration >= 0.8) cue();
    };
    audio.onended = done;
    audio.onerror = done;
    audio.play().catch(done);
    setTimeout(done, 60000);
  });
}

// Prepare a speaker BEFORE ducking: for Lotus the audio is fetched up front
// (network latency happens over full-volume music, not over silence). The
// returned play() runs the right engine; Lotus's failures fall back to Fred
// at prepare time.
async function prepareSpeaker(dj, text) {
  if (dj === "lotus") {
    if (!settings.elevenKey) {
      voiceLogger("Lotus needs an ElevenLabs key in Settings — Fred is covering.");
    } else {
      try {
        const url = await fetchLotusAudio(text);
        return { play: (onNearEnd) => playAudioUrl(url, onNearEnd) };
      } catch (e) {
        // A thrown TypeError with no HTTP status is the browser's CORS block.
        if (!warnedLotusWeb) {
          warnedLotusWeb = true;
          voiceLogger(
            /ElevenLabs \d/.test(e.message)
              ? `Lotus voice error: ${e.message}. Fred is covering.`
              : "Lotus's voice can't run in a web browser (ElevenLabs blocks browser calls). She works in the iOS app; on web, Fred covers her shows."
          );
        }
      }
    }
  }
  return { play: (onNearEnd) => speakFred(text, onNearEnd) };
}

async function readCurrentVolume() {
  let before = settings.playVolume;
  try {
    const state = await spotify.playerState();
    if (typeof state?.device?.volume_percent === "number") before = state.device.volume_percent;
  } catch {}
  if (before < 5) before = settings.playVolume || 60; // never "restore" to silence
  return before;
}

// Duck the music, say the line, bring it back to EXACTLY where it was.
export async function announceOverMusic(deviceId, text, dj = "fred") {
  const speaker = await prepareSpeaker(dj, text);
  const before = await readCurrentVolume();
  try { await spotify.setVolume(deviceId, Math.min(settings.duckVolume, before)); } catch {}
  await new Promise((r) => setTimeout(r, 250));
  await speaker.play();
  await new Promise((r) => setTimeout(r, 150));
  try { await spotify.setVolume(deviceId, before); } catch {}
}

// Real-radio talk-up: the DJ speaks over the outro of the current song, the
// next one starts under the last words (via startSong at ~80% spoken), and
// the volume fades back up on the sign-off.
export async function talkThenStart(deviceId, text, startSong, dj = "fred") {
  const speaker = await prepareSpeaker(dj, text);
  const before = await readCurrentVolume();
  let started = false;
  const kick = () => {
    if (started) return;
    started = true;
    try { startSong(); } catch {}
  };
  try { await spotify.setVolume(deviceId, Math.min(settings.duckVolume, before)); } catch {}
  await new Promise((r) => setTimeout(r, 200));
  await speaker.play(kick);
  kick(); // guarantee the song starts even if the cue never fired
  await new Promise((r) => setTimeout(r, 150));
  try { await spotify.setVolume(deviceId, before); } catch {}
}
