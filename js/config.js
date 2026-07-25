// Settings live in localStorage so the repo holds no secrets.
//
// Note what is NOT here: the Apple developer key, the ElevenLabs key, and
// the Gemini key on a hosted deployment. Those live on the Cloudflare
// Worker, which signs MusicKit tokens and proxies voice audio — a public
// repo can't hold credentials, and a browser shouldn't either.

const KEYS = {
  geminiKey: "tfm_gemini_key",
  duckVolume: "tfm_duck_volume",
  playVolume: "tfm_play_volume",
  voiceName: "tfm_voice_name",
  stationName: "tfm_station_name",
  djOverride: "tfm_dj_override",
  syncUrl: "tfm_sync_url",
  syncSecret: "tfm_sync_secret",
};

export const settings = {
  get geminiKey() { return localStorage.getItem(KEYS.geminiKey) || ""; },
  set geminiKey(v) { localStorage.setItem(KEYS.geminiKey, v.trim()); },
  get duckVolume() { return Number(localStorage.getItem(KEYS.duckVolume) || 20); },
  set duckVolume(v) { localStorage.setItem(KEYS.duckVolume, String(v)); },
  get playVolume() { return Number(localStorage.getItem(KEYS.playVolume) || 70); },
  set playVolume(v) { localStorage.setItem(KEYS.playVolume, String(v)); },
  get voiceName() { return localStorage.getItem(KEYS.voiceName) || ""; },
  set voiceName(v) { localStorage.setItem(KEYS.voiceName, v); },
  get stationName() { return localStorage.getItem(KEYS.stationName) || "FREDIOHEAD FM"; },
  set stationName(v) { localStorage.setItem(KEYS.stationName, v.trim() || "FREDIOHEAD FM"); },
  // "schedule" (follow each show's host) or any DJ id from djs.js
  get djOverride() {
    const v = localStorage.getItem(KEYS.djOverride) || "schedule";
    return v === "ellen" ? "lotus" : v; // pre-rename saves
  },
  set djOverride(v) { localStorage.setItem(KEYS.djOverride, v); },
  get syncUrl() { return localStorage.getItem(KEYS.syncUrl) || ""; },
  set syncUrl(v) { localStorage.setItem(KEYS.syncUrl, v.trim()); },
  get syncSecret() { return localStorage.getItem(KEYS.syncSecret) || ""; },
  set syncSecret(v) { localStorage.setItem(KEYS.syncSecret, v.trim()); },
};
