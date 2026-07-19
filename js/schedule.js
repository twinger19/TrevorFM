// The week's programming grid. Blocks carry a name, a plain-language brief
// that gets handed to the DJ as the show's remit, and which DJ hosts the
// show ("fred" — the Fitter Happier robot — or "lotus" — the calm,
// philosophical ElevenLabs voice). Stored in localStorage.
import { settings } from "./config.js";

const KEY = "tfm_schedule";

export const DJS = ["fred", "lotus"];
export const DJ_LABELS = { fred: "Fred", lotus: "Lotus" };

// Instant blocks: one-tap moods that override the schedule until the next
// scheduled block boundary (or until cleared). Each is an ad-hoc show brief.
export const INSTANT_BLOCKS = [
  { id: "workout", name: "Workout", icon: "⚡", dj: "fred",
    desc: "High-energy, driving, relentless. Uptempo electronic, hip-hop, rock — big beats and momentum for training. Nothing slow or mellow." },
  { id: "focus", name: "Focus", icon: "◎", dj: "fred",
    desc: "Deep focus music. Instrumental, minimal, steady — ambient, post-rock, modern classical, lo-fi. No vocals up front, nothing distracting." },
  { id: "walk", name: "Walk", icon: "→", dj: "lotus",
    desc: "Easy, warm, mid-tempo companionship for a walk. Indie, folk-adjacent, melodic — pleasant and rolling, matching a steady stride." },
  { id: "winddown", name: "Wind Down", icon: "☾", dj: "lotus",
    desc: "Slow, spacious, calming. Ambient, gentle acoustic, quiet electronica. Lowering the heart rate toward the end of the day." },
  { id: "party", name: "Party", icon: "✷", dj: "fred",
    desc: "Loud, fun, crowd-pleasing. Dance, pop, big hooks, guilty pleasures welcome. Keep the energy up and the floor moving." },
  { id: "deepcuts", name: "Deep Cuts", icon: "❋", dj: "lotus",
    desc: "The adventurous shelf. B-sides, rarities, long-form pieces, the strange and beautiful. Reward close listening." },
];

const INSTANT_KEY = "tfm_instant"; // { id, brief, startedAt } | null

// Set the active instant block (or clear with null). It overrides the
// schedule's brief until the next scheduled block boundary.
export function setInstantBlock(block) {
  if (!block) { localStorage.removeItem(INSTANT_KEY); return; }
  const now = new Date();
  localStorage.setItem(INSTANT_KEY, JSON.stringify({
    id: block.id, name: block.name, desc: block.desc, dj: block.dj,
    startedAt: now.getTime(),
    // Expires when the current schedule block would hand over to the next one.
    expiresAt: nextBlockBoundary(now).getTime(),
  }));
}

export function activeInstantBlock() {
  try {
    const b = JSON.parse(localStorage.getItem(INSTANT_KEY));
    if (!b) return null;
    if (Date.now() >= b.expiresAt) { localStorage.removeItem(INSTANT_KEY); return null; }
    return b;
  } catch { return null; }
}

// The clock time at which the current schedule block ends (the instant
// block's natural expiry — "until the next block time comes up").
function nextBlockBoundary(date = new Date()) {
  const block = currentBlock(loadSchedule(), date);
  const end = block ? block.end : Math.ceil(date.getHours() + 0.001);
  const b = new Date(date);
  b.setMinutes(0, 0, 0);
  let h = end % 24;
  b.setHours(h);
  if (b <= date) b.setDate(b.getDate() + 1); // wrapped past midnight
  return b;
}

export const DAYS = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"];
export const DAY_LABELS = { mon: "Mon", tue: "Tue", wed: "Wed", thu: "Thu", fri: "Fri", sat: "Sat", sun: "Sun" };

const WEEKDAY = [
  { start: 6, end: 10, name: "Morning Frequency", desc: "Gentle wake-up. Warm acoustic, soft electronica, nothing abrasive. Tempo rises slowly toward the end of the show." },
  { start: 10, end: 14, name: "The Midday Modulation", desc: "Melodic focus music. Indie and art rock, steady energy, good for working. Familiar artists with the occasional discovery." },
  { start: 14, end: 16, name: "Static & Coffee", desc: "Eclectic afternoon shelf: B-sides, deep cuts, covers, things the listener probably hasn't heard. The most adventurous show of the day." },
  { start: 16, end: 19, name: "Drivetime Circuit", desc: "Upbeat and confident. Big hooks, anthems, singalongs. The energy peak of the weekday." },
  { start: 19, end: 22, name: "Evening Frequencies", desc: "Rich and moody. Full-album energy, layered production, emotional range. Let songs breathe." },
  { start: 22, end: 6, name: "Late Static", desc: "Ambient, slow, mostly instrumental. Space and quiet. Nothing that demands attention." },
];

const SATURDAY = [
  { start: 8, end: 12, name: "Weekend Warm-Up", desc: "Feel-good and unhurried. Sunshine tracks, old favourites, easy classics." },
  { start: 12, end: 17, name: "The Big Saturday Show", desc: "Loud and fun. Rock, dance, crowd-pleasers, guilty pleasures welcome. Peak weekend energy." },
  { start: 17, end: 21, name: "Golden Hour", desc: "Smooth grooves: soul, funk, disco edges, warm basslines. Cooking-dinner music." },
  { start: 21, end: 2, name: "Night Transmission", desc: "Electronic and hypnotic. Club-adjacent but living-room volume. Builds, loops, momentum." },
  { start: 2, end: 8, name: "Late Static", desc: "Ambient, slow, mostly instrumental. Space and quiet." },
];

const SUNDAY = [
  { start: 8, end: 12, name: "Sunday Papers", desc: "Quiet and civilised: jazz, folk, strings, coffee music. Nothing above a simmer." },
  { start: 12, end: 16, name: "Vinyl Hours", desc: "Deep catalog appreciation. Classic albums, era pieces, the canon and its neighbours." },
  { start: 16, end: 20, name: "The Comedown", desc: "Mellow favourites and nostalgia. Songs the listener knows every word of." },
  { start: 20, end: 24, name: "Drift", desc: "Ambient into sleep. Slow fades, long tails, low light." },
];

function defaults() {
  const week = {};
  for (const d of ["mon", "tue", "wed", "thu", "fri"]) week[d] = structuredClone(WEEKDAY);
  week.sat = structuredClone(SATURDAY);
  week.sun = structuredClone(SUNDAY);
  return week;
}

export function loadSchedule() {
  try {
    const saved = JSON.parse(localStorage.getItem(KEY));
    if (saved && DAYS.every((d) => Array.isArray(saved[d]))) {
      // Older saved schedules predate the dj field.
      for (const d of DAYS) for (const b of saved[d]) {
        if (b.dj === "ellen") b.dj = "lotus"; // pre-rename saves
        if (!DJS.includes(b.dj)) b.dj = "fred";
      }
      return saved;
    }
  } catch {}
  return defaults();
}

// The show brief in force right now: an active instant block overrides the
// scheduled one. This is what the DJ programs from.
export function effectiveBlock(date = new Date()) {
  return activeInstantBlock() || currentBlock(loadSchedule(), date);
}

// Who is on the mic right now, in priority order: the Settings override,
// then the active instant block, then the scheduled show, then Fred.
export function currentDJ(date = new Date()) {
  if (DJS.includes(settings.djOverride)) return settings.djOverride;
  const block = effectiveBlock(date);
  return DJS.includes(block?.dj) ? block.dj : "fred";
}

export function saveSchedule(week) {
  localStorage.setItem(KEY, JSON.stringify(week));
}

export function resetSchedule() {
  localStorage.removeItem(KEY);
  return defaults();
}

export function dayKey(date = new Date()) {
  return DAYS[(date.getDay() + 6) % 7]; // JS Sunday=0 -> our Monday-first keys
}

// A block like 22-6 wraps midnight; hour 23 and hour 3 both belong to it
// (hour 3 matches the PREVIOUS day's wrapping block).
export function currentBlock(week = loadSchedule(), date = new Date()) {
  const hour = date.getHours() + date.getMinutes() / 60;
  const today = week[dayKey(date)] || [];
  for (const b of today) {
    if (b.start < b.end ? hour >= b.start && hour < b.end : hour >= b.start) return b;
  }
  const yesterday = week[DAYS[(DAYS.indexOf(dayKey(date)) + 6) % 7]] || [];
  for (const b of yesterday) {
    if (b.start > b.end && hour < b.end) return b;
  }
  return null;
}

export function fmtHour(h) {
  return `${String(Math.floor(h)).padStart(2, "0")}:00`;
}
