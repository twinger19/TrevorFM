// The week's programming grid. Blocks carry a name, a plain-language brief
// handed to the DJ as the show's remit, and which host presents it — see
// djs.js for the roster. Stored in localStorage, synced across devices.
import { settings } from "./config.js";
import { DJ_IDS, DJ_LABELS as REGISTRY_LABELS } from "./djs.js";

const KEY = "tfm_schedule";

export const DJS = DJ_IDS;
export const DJ_LABELS = REGISTRY_LABELS;

export const DAYS = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"];
export const DAY_LABELS = { mon: "Mon", tue: "Tue", wed: "Wed", thu: "Thu", fri: "Fri", sat: "Sat", sun: "Sun" };

const WEEKDAY = [
  { start: 6, end: 10, name: "Morning Frequency", desc: "Gentle wake-up. Warm acoustic, soft electronica, nothing abrasive. Tempo rises slowly toward the end of the show.", dj: "marlowe" },
  { start: 10, end: 14, name: "The Midday Modulation", desc: "Melodic focus music. Indie and art rock, steady energy, good for working. Familiar artists with the occasional discovery.", dj: "fred" },
  { start: 14, end: 16, name: "Static & Coffee", desc: "Eclectic afternoon shelf: B-sides, deep cuts, covers, things the listener probably hasn't heard. The most adventurous show of the day.", dj: "fred" },
  { start: 16, end: 19, name: "Drivetime Circuit", desc: "Upbeat and confident. Big hooks, anthems, singalongs. The energy peak of the weekday.", dj: "marlowe" },
  { start: 19, end: 22, name: "Evening Frequencies", desc: "Rich and moody. Full-album energy, layered production, emotional range. Let songs breathe.", dj: "lotus" },
  { start: 22, end: 6, name: "Late Static", desc: "Ambient, slow, mostly instrumental. Space and quiet. Nothing that demands attention.", dj: "lotus" },
];

const SATURDAY = [
  { start: 8, end: 12, name: "Weekend Warm-Up", desc: "Feel-good and unhurried. Sunshine tracks, old favourites, easy classics.", dj: "marlowe" },
  { start: 12, end: 17, name: "The Big Saturday Show", desc: "Loud and fun. Rock, dance, crowd-pleasers, guilty pleasures welcome. Peak weekend energy.", dj: "marlowe" },
  { start: 17, end: 21, name: "Golden Hour", desc: "Smooth grooves: soul, funk, disco edges, warm basslines. Cooking-dinner music.", dj: "lotus" },
  { start: 21, end: 2, name: "Night Transmission", desc: "Electronic and hypnotic. Club-adjacent but living-room volume. Builds, loops, momentum.", dj: "lotus" },
  { start: 2, end: 8, name: "Late Static", desc: "Ambient, slow, mostly instrumental. Space and quiet.", dj: "lotus" },
];

const SUNDAY = [
  { start: 8, end: 12, name: "Sunday Papers", desc: "Quiet and civilised: jazz, folk, strings, coffee music. Nothing above a simmer.", dj: "marlowe" },
  { start: 12, end: 16, name: "Vinyl Hours", desc: "Deep catalog appreciation. Classic albums, era pieces, the canon and its neighbours.", dj: "lotus" },
  { start: 16, end: 20, name: "The Comedown", desc: "Mellow favourites and nostalgia. Songs the listener knows every word of.", dj: "lotus" },
  { start: 20, end: 24, name: "Drift", desc: "Ambient into sleep. Slow fades, long tails, low light.", dj: "lotus" },
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

const UPDATED_KEY = "tfm_schedule_updated";

export function scheduleUpdatedAt() {
  return Number(localStorage.getItem(UPDATED_KEY) || 0);
}

// A save hook so main.js can push to the cloud without schedule.js importing
// the sync module (avoids a circular import).
let onScheduleSaved = null;
export function setOnScheduleSaved(fn) { onScheduleSaved = fn; }

// Adopt a schedule pulled from the cloud WITHOUT re-pushing it (and stamp the
// remote's timestamp so we don't bounce it back).
export function adoptSchedule(week, updatedAt) {
  localStorage.setItem(KEY, JSON.stringify(week));
  localStorage.setItem(UPDATED_KEY, String(updatedAt));
}

export function saveSchedule(week) {
  localStorage.setItem(KEY, JSON.stringify(week));
  localStorage.setItem(UPDATED_KEY, String(Date.now()));
  onScheduleSaved?.();
}

export function resetSchedule() {
  localStorage.removeItem(KEY);
  localStorage.setItem(UPDATED_KEY, String(Date.now()));
  onScheduleSaved?.();
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

// ── Instant moods ───────────────────────────────────────────────────────
// One-tap vibes that override the schedule until the next show boundary.
// The shipped set, plus any the listener writes themselves.

export const BUILTIN_MOODS = [
  { id: "workout", name: "Workout", icon: "bolt.fill", dj: "fred",
    desc: "High-energy, driving, relentless. Uptempo electronic, hip-hop, rock — big beats and momentum for training. Nothing slow or mellow." },
  { id: "focus", name: "Focus", icon: "scope", dj: "fred",
    desc: "Deep focus music. Instrumental, minimal, steady — ambient, post-rock, modern classical, lo-fi. No vocals up front, nothing distracting." },
  { id: "walk", name: "Walk", icon: "figure.walk", dj: "marlowe",
    desc: "Easy, warm, mid-tempo companionship for a walk. Indie, folk-adjacent, melodic — pleasant and rolling, matching a steady stride." },
  { id: "winddown", name: "Wind Down", icon: "moon.fill", dj: "lotus",
    desc: "Slow, spacious, calming. Ambient, gentle acoustic, quiet electronica. Lowering the heart rate toward the end of the day." },
  { id: "party", name: "Party", icon: "sparkles", dj: "marlowe",
    desc: "Loud, fun, crowd-pleasing. Dance, pop, big hooks, guilty pleasures welcome. Keep the energy up and the floor moving." },
  { id: "deepcuts", name: "Deep Cuts", icon: "asterisk", dj: "lotus",
    desc: "The adventurous shelf. B-sides, rarities, long-form pieces, the strange and beautiful. Reward close listening." },
];

const CUSTOM_MOODS_KEY = "tfm_custom_moods";
let onMoodsSaved = null;
export function setOnMoodsSaved(fn) { onMoodsSaved = fn; }

export function customMoods() {
  try { return JSON.parse(localStorage.getItem(CUSTOM_MOODS_KEY)) || []; } catch { return []; }
}
export function allMoods() { return [...BUILTIN_MOODS, ...customMoods()]; }

function saveCustomMoods(list) {
  localStorage.setItem(CUSTOM_MOODS_KEY, JSON.stringify(list));
}

export function upsertMood(mood) {
  const list = customMoods();
  const i = list.findIndex((m) => m.id === mood.id);
  if (i >= 0) list[i] = { ...mood, isCustom: true };
  else list.push({ ...mood, isCustom: true });
  saveCustomMoods(list);
  onMoodsSaved?.();
}

export function deleteMood(id) {
  saveCustomMoods(customMoods().filter((m) => m.id !== id));
  const active = activeInstantBlock();
  if (active?.id === id) setInstantBlock(null);
  onMoodsSaved?.();
}

// Adopt another device's moods (sync pull) without pushing them back.
export function replaceCustomMoods(list) {
  saveCustomMoods((list || []).map((m) => ({ ...m, isCustom: true })));
}

export function newMoodId() {
  return "custom_" + Math.random().toString(36).slice(2, 10);
}

// A tray of icons that read at a glance. Names match the iOS SF Symbols so
// a mood made on the phone shows the same glyph here.
export const MOOD_ICONS = [
  "bolt.fill", "scope", "figure.walk", "moon.fill", "sparkles", "asterisk",
  "sun.max.fill", "cloud.rain.fill", "snowflake", "flame.fill", "leaf.fill", "drop.fill",
  "car.fill", "airplane", "tram.fill", "bicycle", "figure.run", "dumbbell.fill",
  "book.fill", "briefcase.fill", "desktopcomputer", "paintpalette.fill", "camera.fill", "fork.knife",
  "cup.and.saucer.fill", "wineglass.fill", "house.fill", "bed.double.fill", "guitars.fill", "pianokeys",
  "headphones", "radio.fill", "waveform", "heart.fill", "star.fill", "brain.head.profile",
  "globe.americas.fill", "map.fill", "mountain.2.fill", "beach.umbrella.fill", "tree.fill", "binoculars.fill",
  "clock.fill", "hourglass", "sunrise.fill", "sunset.fill", "shuffle", "infinity",
];


// ── The mood in force, and who's on the mic ─────────────────────────────

const INSTANT_KEY = "tfm_instant"; // { id, name, desc, dj, expiresAt } | null

// Set the active mood (or clear with null). It overrides the schedule until
// the current show would have handed over to the next one.
export function setInstantBlock(block) {
  if (!block) { localStorage.removeItem(INSTANT_KEY); return; }
  localStorage.setItem(INSTANT_KEY, JSON.stringify({
    id: block.id, name: block.name, desc: block.desc, dj: block.dj,
    startedAt: Date.now(),
    expiresAt: nextBlockBoundary(new Date()).getTime(),
  }));
}

export function activeInstantBlock() {
  try {
    const b = JSON.parse(localStorage.getItem(INSTANT_KEY));
    if (!b) return null;
    if (Date.now() >= b.expiresAt) { localStorage.removeItem(INSTANT_KEY); return null; }
    // Re-read from the live list so an edited mood takes effect immediately.
    const live = allMoods().find((m) => m.id === b.id);
    return live ? { ...live, expiresAt: b.expiresAt } : b;
  } catch { return null; }
}

// The clock time the current schedule block ends — a mood's natural expiry.
function nextBlockBoundary(date = new Date()) {
  const block = currentBlock(loadSchedule(), date);
  const end = block ? block.end : Math.ceil(date.getHours() + 0.001);
  const b = new Date(date);
  b.setMinutes(0, 0, 0);
  b.setHours(end % 24);
  if (b <= date) b.setDate(b.getDate() + 1); // wrapped past midnight
  return b;
}

// The brief the DJ programs from: an active mood outranks the schedule.
export function effectiveBlock(date = new Date()) {
  return activeInstantBlock() || currentBlock(loadSchedule(), date);
}

// Who is on the mic: the Settings override, then the mood/show's host,
// then the fallback. Unknown ids resolve safely so a retired host never
// leaves the booth empty.
export function currentDJ(date = new Date()) {
  if (DJ_IDS.includes(settings.djOverride)) return settings.djOverride;
  const block = effectiveBlock(date);
  const raw = block?.dj === "ellen" ? "lotus" : block?.dj;
  return DJ_IDS.includes(raw) ? raw : "fred";
}
