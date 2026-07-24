// Console settings live in localStorage so the repo holds no secrets.
// The playback-era keys (Spotify client id, Gemini, ElevenLabs, volumes)
// are gone — the station itself runs on the iOS app via Apple Music; this
// console only needs its name and the schedule-sync credentials.

const KEYS = {
  stationName: "tfm_station_name",
  syncUrl: "tfm_sync_url",
  syncSecret: "tfm_sync_secret",
};

export const settings = {
  get stationName() { return localStorage.getItem(KEYS.stationName) || "FREDIOHEAD FM"; },
  set stationName(v) { localStorage.setItem(KEYS.stationName, v.trim() || "FREDIOHEAD FM"); },
  // Cross-device schedule sync (Cloudflare Worker URL + shared secret).
  get syncUrl() { return localStorage.getItem(KEYS.syncUrl) || ""; },
  set syncUrl(v) { localStorage.setItem(KEYS.syncUrl, v.trim()); },
  get syncSecret() { return localStorage.getItem(KEYS.syncSecret) || ""; },
  set syncSecret(v) { localStorage.setItem(KEYS.syncSecret, v.trim()); },
};
