// Apple Music playback in the browser, via MusicKit JS v3.
//
// Two tokens are involved and they're easy to confuse:
//  • DEVELOPER token — proves the APP is allowed to use Apple Music. It's a
//    JWT signed with a private .p8 key. That key must never reach the
//    browser, so the Cloudflare Worker signs tokens for us (see
//    cloudflare-sync/worker.js) and we just fetch one.
//  • USER token — proves THIS LISTENER has an Apple Music subscription.
//    MusicKit handles it through an Apple sign-in popup on authorize().
import { settings } from "./config.js";

const CDN = "https://js-cdn.music.apple.com/musickit/v3/musickit.js";

let instance = null;

function loadScript() {
  if (window.MusicKit) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const existing = document.querySelector(`script[src="${CDN}"]`);
    if (existing) {
      existing.addEventListener("load", () => resolve());
      existing.addEventListener("error", () => reject(new Error("MusicKit failed to load")));
      return;
    }
    const el = document.createElement("script");
    el.src = CDN;
    el.async = true;
    el.addEventListener("load", () => resolve());
    el.addEventListener("error", () => reject(new Error("MusicKit failed to load")));
    document.head.appendChild(el);
  });
}

// Ask the Worker to mint a developer token. The Worker holds the .p8 as a
// secret and signs an ES256 JWT; nothing sensitive ends up in this repo.
async function fetchDeveloperToken() {
  if (!settings.syncUrl || !settings.syncSecret) {
    throw new Error("Add the Sync URL and secret in Settings — the token comes from your Worker.");
  }
  const url = settings.syncUrl.replace(/\/+$/, "") + "/musickit-token";
  const res = await fetch(url, { headers: { "x-sync-secret": settings.syncSecret } });
  if (res.status === 404) {
    throw new Error("Your Worker doesn't have /musickit-token yet — redeploy it from cloudflare-sync/.");
  }
  if (!res.ok) throw new Error(`Token request failed (HTTP ${res.status}).`);
  const { token } = await res.json();
  if (!token) throw new Error("Worker returned no token — check the MusicKit key is set.");
  return token;
}

export const music = {
  get ready() { return !!instance; },
  get authorized() { return !!instance?.isAuthorized; },
  get instance() { return instance; },

  async configure() {
    if (instance) return instance;
    await loadScript();
    const developerToken = await fetchDeveloperToken();
    // v3's configure resolves with the configured instance.
    instance = await window.MusicKit.configure({
      developerToken,
      app: { name: settings.stationName || "Frediohead FM", build: "2.0" },
    });
    return instance;
  },

  // Apple sign-in popup. Must be called from a real user gesture.
  async authorize() {
    if (!instance) await this.configure();
    await instance.authorize();
    return instance.isAuthorized;
  },

  async unauthorize() {
    if (instance) await instance.unauthorize();
  },

  storefront() {
    return instance?.storefrontId || "us";
  },

  // MARK: playback

  async playSongs(ids) {
    if (!ids.length) return false;
    await instance.setQueue({ songs: ids, startPlaying: true });
    return true;
  },

  // `next: true` slots straight after the current song (a listener request);
  // otherwise the tracks go on the end of the queue (a block top-up).
  async appendSongs(ids, { next = false } = {}) {
    if (!ids.length) return false;
    if (next) {
      await instance.playNext({ songs: ids });
    } else {
      await instance.playLater({ songs: ids });
    }
    return true;
  },

  async play() { await instance.play(); },
  async pause() { instance.pause(); },
  async skipNext() { await instance.skipToNextItem(); },
  async skipPrevious() { await instance.skipToPreviousItem(); },

  isPlaying() {
    return instance?.playbackState === window.MusicKit?.PlaybackStates?.playing;
  },

  nowPlaying() {
    const item = instance?.nowPlayingItem;
    if (!item) return null;
    return {
      id: item.id,
      uri: item.id,
      name: item.title,
      artist: item.artistName || "",
      durationMs: (item.playbackDuration ?? 0),
      artworkUrl: item.artwork ? window.MusicKit.formatArtworkURL(item.artwork, 600, 600) : null,
    };
  },

  progressMs() { return (instance?.currentPlaybackTime ?? 0) * 1000; },
  durationMs() {
    const d = instance?.currentPlaybackDuration ?? 0;
    return d * 1000;
  },

  on(event, handler) {
    instance?.addEventListener(event, handler);
  },

  // MARK: catalog

  async searchTrack(term) {
    const cached = searchCache.get(term);
    if (cached) return cached;
    const res = await instance.api.music(`/v1/catalog/${this.storefront()}/search`, {
      term,
      types: ["songs"],
      limit: 1,
    });
    const song = res?.data?.results?.songs?.data?.[0];
    if (!song) return null;
    const track = {
      uri: song.id,
      id: song.id,
      name: song.attributes?.name || "",
      artist: song.attributes?.artistName || "",
      genres: song.attributes?.genreNames || [],
    };
    searchCache.set(term, track);
    saveSearchCache();
    return track;
  },

  // MARK: taste + library

  async recentlyPlayed(limit = 30) {
    try {
      const res = await instance.api.music("/v1/me/recent/played/tracks", { limit });
      return (res?.data?.data || []).map((s) => ({
        name: s.attributes?.name || "",
        artist: s.attributes?.artistName || "",
        genres: s.attributes?.genreNames || [],
      }));
    } catch {
      return [];
    }
  },

  async addToLibrary(id) {
    await instance.api.music("/v1/me/library", { "ids[songs]": id }, { fetchOptions: { method: "POST" } });
  },

  // value: 1 loves it, -1 dislikes it. Shapes Apple Music's own recommendations.
  async rate(id, value) {
    await instance.api.music(
      `/v1/me/ratings/songs/${id}`,
      {},
      { fetchOptions: { method: "PUT", body: JSON.stringify({ type: "rating", attributes: { value } }) } }
    );
  },
};

// Resolved searches persist — the DJ's picks overlap heavily day to day.
const CACHE_KEY = "tfm_catalog_cache_v1";
const searchCache = new Map(Object.entries(JSON.parse(localStorage.getItem(CACHE_KEY) || "{}")));

function saveSearchCache() {
  const obj = {};
  let n = 0;
  for (const [k, v] of searchCache) {
    if (n++ > 600) break;
    obj[k] = v;
  }
  localStorage.setItem(CACHE_KEY, JSON.stringify(obj));
}
