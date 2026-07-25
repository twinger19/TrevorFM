// Cross-device sync for the whole station, via the Cloudflare Worker.
// One JSON blob shared by the iOS app and this page.
//
// Three rules make it safe with more than one writer:
//  1. SECTIONS ARE INDEPENDENT — each carries its own timestamp, so a mood
//     edit here can't roll back a schedule edit made on the phone.
//  2. A MISSING SECTION IS NEVER A DELETE — an older writer that omits a
//     section is saying "no opinion", not "throw it away".
//  3. VETOES MERGE — thumbs-down bans and loves are unioned, because
//     "never play this again" should survive whichever device heard it.
import { settings } from "./config.js";
import {
  loadSchedule, adoptSchedule, scheduleUpdatedAt,
  customMoods, replaceCustomMoods,
} from "./schedule.js";
import { bannedTracks, banArtistCounts, likedLabels, mergeTaste } from "./taste.js";

function configured() {
  return !!settings.syncUrl && !!settings.syncSecret;
}

const stamp = (k) => Number(localStorage.getItem(k) || 0);
const setStamp = (k, v) => localStorage.setItem(k, String(v));

const MOODS_AT = "tfm_moods_updated";
const TASTE_AT = "tfm_taste_updated";
const SETTINGS_AT = "tfm_settings_updated";

export function markMoodsChanged() { setStamp(MOODS_AT, Date.now()); pushSoon(); }
export function markTasteChanged() { setStamp(TASTE_AT, Date.now()); pushSoon(); }
export function markSettingsChanged() { setStamp(SETTINGS_AT, Date.now()); pushSoon(); }

// Coalesce: a thumbs-down shouldn't fire its own round-trip.
let pushTimer = null;
export function pushSoon() {
  if (!configured()) return;
  clearTimeout(pushTimer);
  pushTimer = setTimeout(() => pushAll().catch(() => {}), 3000);
}

async function readBlob() {
  const res = await fetch(settings.syncUrl, { headers: { "x-sync-secret": settings.syncSecret } });
  if (!res.ok) return null;
  return (await res.json()) || null;
}

// Returns "adopted" if anything remote was taken on, "current" if we were
// already up to date, or null if not configured / the request failed.
export async function pullSchedule() {
  if (!configured()) return null;
  try {
    const blob = await readBlob();
    if (!blob) return null;
    let adopted = false;

    if (blob.week && Number(blob.updatedAt) > scheduleUpdatedAt()) {
      adoptSchedule(blob.week, Number(blob.updatedAt));
      adopted = true;
    }
    if (blob.moods && Number(blob.moodsUpdatedAt || 0) > stamp(MOODS_AT)) {
      replaceCustomMoods(blob.moods);
      setStamp(MOODS_AT, Number(blob.moodsUpdatedAt || Date.now()));
      adopted = true;
    }
    // Vetoes merge regardless of clock — merging can only ever add.
    if (blob.taste && mergeTaste({
      bans: blob.taste.bans || [],
      banArtists: blob.taste.banArtists || {},
      likes: blob.taste.likes || [],
    })) {
      setStamp(TASTE_AT, Math.max(stamp(TASTE_AT), Number(blob.tasteUpdatedAt || Date.now())));
      adopted = true;
    }
    if (blob.djOverride && Number(blob.settingsUpdatedAt || 0) > stamp(SETTINGS_AT)) {
      settings.djOverride = blob.djOverride;
      setStamp(SETTINGS_AT, Number(blob.settingsUpdatedAt || Date.now()));
      adopted = true;
    }
    return adopted ? "adopted" : "current";
  } catch {
    return null;
  }
}

// Read-modify-write, so a concurrent writer's sections survive and vetoes
// from another device get folded in rather than overwritten.
export async function pushAll() {
  if (!configured()) return false;
  try {
    let existing = {};
    try { existing = (await readBlob()) || {}; } catch {}
    if (existing.taste) {
      mergeTaste({
        bans: existing.taste.bans || [],
        banArtists: existing.taste.banArtists || {},
        likes: existing.taste.likes || [],
      });
    }
    const blob = {
      ...existing,
      week: loadSchedule(),
      updatedAt: scheduleUpdatedAt(),
      moods: customMoods(),
      moodsUpdatedAt: stamp(MOODS_AT),
      taste: { bans: bannedTracks(), banArtists: banArtistCounts(), likes: likedLabels() },
      tasteUpdatedAt: Math.max(stamp(TASTE_AT), Number(existing.tasteUpdatedAt || 0)),
      djOverride: settings.djOverride,
      settingsUpdatedAt: stamp(SETTINGS_AT),
    };
    const res = await fetch(settings.syncUrl, {
      method: "PUT",
      headers: { "x-sync-secret": settings.syncSecret, "content-type": "application/json" },
      body: JSON.stringify(blob),
    });
    return res.ok;
  } catch {
    return false;
  }
}

// Kept for the schedule editor's save hook.
export const pushSchedule = pushAll;

export async function testSync() {
  if (!configured()) return "Add the Sync URL and secret first.";
  try {
    const res = await fetch(settings.syncUrl, { headers: { "x-sync-secret": settings.syncSecret } });
    if (res.status === 403) return "Connected, but the secret is wrong.";
    if (!res.ok) return `Sync error: HTTP ${res.status}.`;
    return "Sync is working.";
  } catch (e) {
    return `Couldn't reach the sync URL: ${e.message}`;
  }
}
