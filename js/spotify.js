// Thin Spotify Web API wrapper. Playback control targets a chosen device
// (the desktop app), so the browser tab is just the control room.
import { getAccessToken } from "./auth.js";

async function api(method, path, body) {
  const token = await getAccessToken();
  const res = await fetch(`https://api.spotify.com/v1${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (res.status === 429) {
    const wait = Number(res.headers.get("Retry-After") || 2);
    await new Promise((r) => setTimeout(r, wait * 1000));
    return api(method, path, body);
  }
  if (!res.ok) throw new Error(`Spotify ${method} ${path} -> ${res.status}: ${await res.text()}`);
  if (res.status === 204) return null;
  // Some control endpoints (play/queue/volume) return 200 with a non-JSON
  // body; nothing we need is in there, so parse failures are not errors.
  const text = await res.text();
  if (!text) return null;
  try { return JSON.parse(text); } catch { return null; }
}

export const spotify = {
  me: () => api("GET", "/me"),
  devices: async () => (await api("GET", "/me/player/devices")).devices,
  topArtists: async (range = "medium_term", limit = 20) =>
    (await api("GET", `/me/top/artists?time_range=${range}&limit=${limit}`)).items,
  topTracks: async (range = "short_term", limit = 20) =>
    (await api("GET", `/me/top/tracks?time_range=${range}&limit=${limit}`)).items,
  recentlyPlayed: async (limit = 30) =>
    (await api("GET", `/me/player/recently-played?limit=${limit}`)).items,
  searchTrack: async (query) => {
    const q = encodeURIComponent(query);
    const json = await api("GET", `/search?q=${q}&type=track&limit=1`);
    return json.tracks.items[0] || null;
  },
  artist: (id) => api("GET", `/artists/${id}`),
  isTrackSaved: async (id) => (await api("GET", `/me/tracks/contains?ids=${id}`))[0],
  saveTrack: (id) => api("PUT", `/me/tracks?ids=${id}`),
  unsaveTrack: (id) => api("DELETE", `/me/tracks?ids=${id}`),
  containsTracks: (ids) => api("GET", `/me/tracks/contains?ids=${ids.join(",")}`),
  playerState: () => api("GET", "/me/player"),
  transferTo: (deviceId) => api("PUT", "/me/player", { device_ids: [deviceId], play: false }),
  play: (deviceId, uris) => api("PUT", `/me/player/play?device_id=${deviceId}`, { uris }),
  queue: (deviceId, uri) =>
    api("POST", `/me/player/queue?uri=${encodeURIComponent(uri)}&device_id=${deviceId}`),
  pause: (deviceId) => api("PUT", `/me/player/pause?device_id=${deviceId}`),
  next: (deviceId) => api("POST", `/me/player/next?device_id=${deviceId}`),
  setVolume: (deviceId, percent) =>
    api("PUT", `/me/player/volume?volume_percent=${Math.round(percent)}&device_id=${deviceId}`),
};
