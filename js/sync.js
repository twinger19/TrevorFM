// Cross-device schedule sync via the Cloudflare Worker (see cloudflare-sync/).
// The Worker holds one JSON blob { week, updatedAt }; last edit wins by
// timestamp. Pull on open, push on edit.
import { settings } from "./config.js";
import { loadSchedule, adoptSchedule, scheduleUpdatedAt } from "./schedule.js";

function configured() {
  return !!settings.syncUrl && !!settings.syncSecret;
}

// Returns "adopted" if a newer remote schedule replaced the local one,
// "current" if local was already up to date, or null if not configured/failed.
export async function pullSchedule() {
  if (!configured()) return null;
  try {
    const res = await fetch(settings.syncUrl, {
      headers: { "x-sync-secret": settings.syncSecret },
    });
    if (!res.ok) return null;
    const blob = await res.json();
    if (blob && blob.week && Number(blob.updatedAt) > scheduleUpdatedAt()) {
      adoptSchedule(blob.week, Number(blob.updatedAt));
      return "adopted";
    }
    return "current";
  } catch {
    return null;
  }
}

// The blob carries more than the schedule now — the iOS app also stores its
// custom moods, thumbs-down vetoes, and DJ override in it. This console only
// owns `week`/`updatedAt`, so it must READ FIRST and hand everything else
// back untouched. Blindly PUTting a schedule-only blob would delete the
// phone's moods and un-ban every rejected track.
export async function pushSchedule() {
  if (!configured()) return false;
  try {
    let existing = {};
    try {
      const current = await fetch(settings.syncUrl, {
        headers: { "x-sync-secret": settings.syncSecret },
      });
      if (current.ok) existing = (await current.json()) || {};
    } catch {
      /* first write, or offline — fall through with an empty base */
    }
    const blob = { ...existing, week: loadSchedule(), updatedAt: scheduleUpdatedAt() };
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

// Quick check for the Settings "Test sync" button.
export async function testSync() {
  if (!configured()) return "Add the Sync URL and secret first.";
  try {
    const res = await fetch(settings.syncUrl, {
      headers: { "x-sync-secret": settings.syncSecret },
    });
    if (res.status === 403) return "Connected, but the secret is wrong.";
    if (!res.ok) return `Sync error: HTTP ${res.status}.`;
    return "Sync is working.";
  } catch (e) {
    return `Couldn't reach the sync URL: ${e.message}`;
  }
}
