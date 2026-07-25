// Settings live in localStorage so the repo holds no secrets.
//
// The Apple developer key never appears here — it signs MusicKit tokens on
// the Cloudflare Worker and must not reach a browser at all.
//
// The ElevenLabs key normally lives on the Worker too. The optional field
// here is an override for when that stored key stops working (rotated,
// revoked, expired): rather than being locked out until the Worker is
// edited, the key can be set in this browser and is forwarded to the
// Worker per request. Same posture as the Gemini key — this browser only,
// never the repo.

const KEYS = {
  geminiKey: "tfm_gemini_key",
  elevenKey: "tfm_eleven_key",
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
  // Blank means "use whatever key the Worker holds" — the normal case.
  get elevenKey() { return localStorage.getItem(KEYS.elevenKey) || ""; },
  set elevenKey(v) { localStorage.setItem(KEYS.elevenKey, v.trim()); },
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

  // Which on-device voice covers a host when ElevenLabs is unreachable.
  // Deliberately NOT synced, unlike the schedule and moods: installed voices
  // differ per machine, so a name that works here can silently resolve to
  // nothing on another device — a setting that looks applied but isn't.
  coverVoice(djId) { return localStorage.getItem(`tfm_cover_${djId}`) || ""; },
  setCoverVoice(djId, name) {
    const v = (name || "").trim();
    if (v) localStorage.setItem(`tfm_cover_${djId}`, v);
    else localStorage.removeItem(`tfm_cover_${djId}`);
  },
};
