// Settings live in localStorage so the repo holds no secrets.

// The redirect URI Spotify sends the login back to. Computed from wherever
// the app is actually running, so the same code works locally and once
// deployed (e.g. GitHub Pages) — each origin just needs to be registered as
// its own Redirect URI in the Spotify dashboard; both can coexist.
export function computeRedirectUri() {
  if (location.hostname === "127.0.0.1") return "http://127.0.0.1:8888/callback";
  return location.origin + location.pathname;
}

export const SCOPES = [
  "user-top-read",
  "user-read-recently-played",
  "user-read-playback-state",
  "user-modify-playback-state",
  "user-read-currently-playing",
  // Like heart -> real Liked Songs:
  "user-library-read",
  "user-library-modify",
  // Required by the Web Playback SDK (in-page player):
  "streaming",
  "user-read-email",
  "user-read-private",
].join(" ");

const KEYS = {
  clientId: "tfm_spotify_client_id",
  geminiKey: "tfm_gemini_key",
  duckVolume: "tfm_duck_volume",
  playVolume: "tfm_play_volume",
  voiceName: "tfm_voice_name",
  stationName: "tfm_station_name",
};

export const settings = {
  get clientId() { return localStorage.getItem(KEYS.clientId) || ""; },
  set clientId(v) { localStorage.setItem(KEYS.clientId, v.trim()); },
  get geminiKey() { return localStorage.getItem(KEYS.geminiKey) || ""; },
  set geminiKey(v) { localStorage.setItem(KEYS.geminiKey, v.trim()); },
  get duckVolume() { return Number(localStorage.getItem(KEYS.duckVolume) || 20); },
  set duckVolume(v) { localStorage.setItem(KEYS.duckVolume, String(v)); },
  get playVolume() { return Number(localStorage.getItem(KEYS.playVolume) || 70); },
  set playVolume(v) { localStorage.setItem(KEYS.playVolume, String(v)); },
  get voiceName() { return localStorage.getItem(KEYS.voiceName) || ""; },
  set voiceName(v) { localStorage.setItem(KEYS.voiceName, v); },
  get stationName() { return localStorage.getItem(KEYS.stationName) || "TREVOR FM"; },
  set stationName(v) { localStorage.setItem(KEYS.stationName, v.trim() || "TREVOR FM"); },
};
