// What the station has learned locally — the web mirror of iOS LocalTaste.
//
// Two kinds of memory:
//  • Soft: artist/genre tallies from everything that plays. Rebuilds itself,
//    stays on this device.
//  • Hard: the listener's explicit verdicts — loves, and thumbs-down vetoes.
//    These SYNC, because "never play this again" should hold everywhere.
import { markTasteChanged } from "./sync.js";

const ARTIST_KEY = "tfm_taste_artists";
const GENRE_KEY = "tfm_taste_genres";
const LIKES_KEY = "tfm_taste_likes";
const BANS_KEY = "tfm_taste_bans";
const BAN_ARTIST_KEY = "tfm_taste_ban_artists";

const readObj = (k) => { try { return JSON.parse(localStorage.getItem(k)) || {}; } catch { return {}; } };
const readArr = (k) => { try { return JSON.parse(localStorage.getItem(k)) || []; } catch { return []; } };
const write = (k, v) => localStorage.setItem(k, JSON.stringify(v));

export function recordPlay(artist, genre) {
  if (!artist) return;
  const artists = readObj(ARTIST_KEY);
  artists[artist] = (artists[artist] || 0) + 1;
  write(ARTIST_KEY, artists);
  if (genre) {
    const genres = readObj(GENRE_KEY);
    genres[genre] = (genres[genre] || 0) + 1;
    write(GENRE_KEY, genres);
  }
}

export function recordLike(label) {
  const likes = readArr(LIKES_KEY).filter((l) => l !== label);
  likes.push(label);
  write(LIKES_KEY, likes.slice(-40));
  markTasteChanged();
}

// A veto: the track never returns, and an artist rejected twice drops out
// of the DJ's world entirely.
export function recordBan(label, artist) {
  const bans = readArr(BANS_KEY).filter((b) => b !== label);
  bans.push(label);
  write(BANS_KEY, bans.slice(-100));

  if (artist) {
    const banned = readObj(BAN_ARTIST_KEY);
    banned[artist] = (banned[artist] || 0) + 1;
    write(BAN_ARTIST_KEY, banned);
    // A banned artist shouldn't keep counting as a favourite.
    const artists = readObj(ARTIST_KEY);
    if (artists[artist]) {
      artists[artist] = Math.max(0, artists[artist] - 2);
      write(ARTIST_KEY, artists);
    }
  }
  markTasteChanged();
}

export const bannedTracks = () => readArr(BANS_KEY);
export const banArtistCounts = () => readObj(BAN_ARTIST_KEY);
export const likedLabels = () => readArr(LIKES_KEY);
export const bannedArtists = () =>
  Object.entries(banArtistCounts()).filter(([, n]) => n >= 2).map(([a]) => a);

// Fold in another device's verdicts. Union only — a device that hasn't
// synced recently must never be able to un-ban something.
export function mergeTaste({ bans = [], banArtists = {}, likes = [] }) {
  let changed = false;

  const current = readArr(BANS_KEY);
  const newBans = bans.filter((b) => !current.includes(b));
  if (newBans.length) {
    write(BANS_KEY, [...current, ...newBans].slice(-100));
    changed = true;
  }

  const artists = readObj(BAN_ARTIST_KEY);
  for (const [artist, count] of Object.entries(banArtists)) {
    if ((artists[artist] || 0) < count) { artists[artist] = count; changed = true; }
  }
  if (changed) write(BAN_ARTIST_KEY, artists);

  const currentLikes = readArr(LIKES_KEY);
  const newLikes = likes.filter((l) => !currentLikes.includes(l));
  if (newLikes.length) {
    write(LIKES_KEY, [...currentLikes, ...newLikes].slice(-40));
    changed = true;
  }
  return changed;
}

// The profile handed to the DJ: the listener's real Apple Music history
// blended with what this station has been doing.
export function tasteProfile(recentFromAppleMusic = []) {
  const artistCounts = {};
  const genreCounts = {};
  const favorites = [];

  for (const song of recentFromAppleMusic.slice(0, 30)) {
    artistCounts[song.artist] = (artistCounts[song.artist] || 0) + 2;
    for (const g of song.genres || []) genreCounts[g] = (genreCounts[g] || 0) + 1;
    if (favorites.length < 15) favorites.push(`${song.artist} – ${song.name}`);
  }
  for (const [a, n] of Object.entries(readObj(ARTIST_KEY))) artistCounts[a] = (artistCounts[a] || 0) + n;
  for (const [g, n] of Object.entries(readObj(GENRE_KEY))) genreCounts[g] = (genreCounts[g] || 0) + n;

  const top = (obj, n) => Object.entries(obj).sort((a, b) => b[1] - a[1]).slice(0, n).map(([k]) => k);
  return {
    top_artists: top(artistCounts, 20),
    genres: top(genreCounts, 15),
    recent_favorites: favorites.length ? favorites : likedLabels().slice(-15).reverse(),
    played_last_days: [],
  };
}
