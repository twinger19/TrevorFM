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

export async function pushSchedule() {
  if (!configured()) return false;
  try {
    const blob = { week: loadSchedule(), updatedAt: scheduleUpdatedAt() };
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
