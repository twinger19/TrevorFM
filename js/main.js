// The station, wired together: Apple Music playback, the DJ, the drawers.
import { settings } from "./config.js";
import { music } from "./musickit.js";
import { Station } from "./station.js";
import { setVoiceLogger, availableVoices } from "./voice.js";
import { createWaveform } from "./waveform.js";
import { createBuddy } from "./buddy.js";
import { fetchSyncedLyrics } from "./lyrics.js";
import { DJS, DJ_LABELS, findDJ } from "./djs.js";
import {
  DAYS, DAY_LABELS, loadSchedule, saveSchedule, resetSchedule, setOnScheduleSaved,
  currentBlock, dayKey, fmtHour, effectiveBlock, currentDJ,
  allMoods, customMoods, upsertMood, deleteMood, newMoodId, MOOD_ICONS,
  setInstantBlock, activeInstantBlock, setOnMoodsSaved,
} from "./schedule.js";
import { pullSchedule, pushAll, testSync, markMoodsChanged, markSettingsChanged } from "./sync.js";

const $ = (id) => document.getElementById(id);

let live = false;
let waveform = null;
let buddy = null;
let openDrawerName = null;
let scheduleDay = dayKey();
let editingBlock = null;
let editingMood = null;
let boothFilter = "all";
const boothFeed = [];
let sessionPlayed = [];
let lyricsLines = null;
let lyricsIndex = -1;

setOnScheduleSaved(() => pushAll().catch(() => {}));
setOnMoodsSaved(() => markMoodsChanged());

// ── booth feed ──────────────────────────────────────────────────────────

const FEED_LABEL = { play: "Play", dj: "DJ", warn: "System", info: "System", system: "System" };

function pushFeed(kind, title, sub) {
  boothFeed.unshift({ time: new Date(), kind, title, sub });
  if (boothFeed.length > 100) boothFeed.pop();
  if (openDrawerName === "booth") renderBooth();
}

function renderBooth() {
  const list = $("log");
  if (!list) return;
  const rows = boothFeed.filter((e) =>
    boothFilter === "all" ? true : boothFilter === "dj" ? e.kind === "dj" : e.kind === "play"
  );
  list.innerHTML = rows.length
    ? rows.map((e) => `
        <li>
          <span class="mono log-time">${e.time.toLocaleTimeString()}</span>
          <span class="mono log-kind ${e.kind === "dj" ? "is-dj" : ""}">${FEED_LABEL[e.kind] || "System"}</span>
          <span class="log-title">${escapeHTML(e.title)}</span>
          ${e.sub ? `<span class="mono log-sub">${escapeHTML(e.sub)}</span>` : ""}
        </li>`).join("")
    : `<li class="empty">Nothing here yet.</li>`;
}

// ── now playing ─────────────────────────────────────────────────────────

function showDJLine(text, kind) {
  const row = $("djLine");
  if (!row) return;
  row.hidden = false;
  $("djText").textContent = text;
  buddy?.react(kind === "voice" ? "talking" : "content");
}

function displayTrack(item) {
  $("trackTitle").textContent = (item.name || "").toLowerCase();
  $("trackTitle").classList.remove("idle");
  $("trackArtist").textContent = item.artist || "";
  $("likeBtn").hidden = false;
  $("banBtn").hidden = false;
  const art = $("art");
  if (item.artworkUrl) { art.src = item.artworkUrl; art.hidden = false; }
  else { art.hidden = true; }
  sessionPlayed.unshift({ name: item.name, artist: item.artist, time: new Date() });
  if (sessionPlayed.length > 200) sessionPlayed.pop();
  loadLyrics(item);
}

function idleDisplay() {
  $("trackTitle").textContent = "scanning the dial";
  $("trackTitle").classList.add("idle");
  $("trackArtist").textContent = "press power to tune in";
  $("likeBtn").hidden = true;
  $("banBtn").hidden = true;
  $("art").hidden = true;
  $("djLine").hidden = true;
  lyricsLines = null;
  $("lyricsBox").hidden = true;
}

async function loadLyrics(item) {
  lyricsLines = null;
  lyricsIndex = -1;
  $("lyricsBox").hidden = true;
  const lines = await fetchSyncedLyrics({
    artist: item.artist,
    track: item.name,
    album: null,
    durationSec: (item.durationMs || 0) / 1000,
  });
  if (lines?.length && music.nowPlaying()?.uri === item.uri) {
    lyricsLines = lines;
    $("lyricsBox").hidden = false;
  }
}

function paintLyrics(ms) {
  if (!lyricsLines) return;
  let idx = -1;
  for (let i = 0; i < lyricsLines.length; i++) if (lyricsLines[i].tMs <= ms) idx = i;
  if (idx === lyricsIndex) return;
  lyricsIndex = idx;
  waveform?.pulse();
  const at = (o) => lyricsLines[idx + o]?.text || "";
  $("lyricsScroll").innerHTML = [-1, 0, 1]
    .map((o) => `<div class="lyric ${o === 0 ? "is-current" : ""}">${escapeHTML(at(o) || " ")}</div>`)
    .join("");
}

function setAirVisuals(playing, mode) {
  $("onairChip").hidden = !playing;
  waveform?.setOnAir(playing);
  if (mode === "off") buddy?.sleep();
  $("signalState").textContent = mode === "onair" ? "On air" : mode === "tuning" ? "Tuning…" : "Standby";
  $("skipBtn").disabled = !playing;
}

// ── the station ─────────────────────────────────────────────────────────

const station = new Station({
  onLog: (text, kind = "info") => pushFeed(kind, text),
  onNowPlaying: (item) => {
    displayTrack(item);
    pushFeed("play", `“${item.name}” by ${item.artist}`, `Source: ${DJ_LABELS[currentDJ()] || "the DJ"}`);
    if (openDrawerName === "timeline") renderTimeline();
  },
  onUpNext: () => { if (openDrawerName === "timeline") renderTimeline(); },
  onDJLine: showDJLine,
  onStatus: (mode) => {
    live = mode === "onair";
    setAirVisuals(mode === "onair", mode);
  },
  onProgress: (ms, duration, next) => {
    if (duration > 0) {
      waveform?.setProgress(ms / duration);
      const intro = Math.min(1, ms / 12000);
      const outro = Math.min(1, (duration - ms) / 15000);
      waveform?.setEnergy(Math.max(0.3, Math.min(intro, outro)));
    }
    paintLyrics(ms);
    const tease = $("upNextTease");
    if (next && duration - ms < 30000) {
      tease.hidden = false;
      tease.textContent = `up next · ${next.artist} – ${next.name}`;
    } else {
      tease.hidden = true;
    }
  },
});

setVoiceLogger((msg) => pushFeed("warn", msg));

// ── power ───────────────────────────────────────────────────────────────

async function powerOn() {
  if (live) { await station.stop(); idleDisplay(); return; }
  try {
    setAirVisuals(false, "tuning");
    if (!music.authorized) {
      const ok = await music.authorize();
      if (!ok) { pushFeed("warn", "Apple Music sign-in was cancelled."); setAirVisuals(false, "off"); return; }
    }
    refreshSetupState();
    station.weatherText = await currentWeatherLine();
    await station.start();
  } catch (e) {
    pushFeed("warn", e.message);
    setAirVisuals(false, "off");
  }
}

$("startBtn").addEventListener("click", powerOn);
$("skipBtn").addEventListener("click", () => station.skip().catch(() => {}));
$("likeBtn").addEventListener("click", async () => pushFeed("dj", await station.love()));
$("banBtn").addEventListener("click", async () => pushFeed("dj", await station.ban()));
$("muteBtn").addEventListener("click", () => {
  const inst = music.instance;
  if (!inst) return;
  inst.volume = inst.volume > 0 ? 0 : (settings.playVolume ?? 70) / 100;
  $("muteBtn").textContent = inst.volume === 0 ? "unmute" : "mute";
});
$("volume").addEventListener("input", (e) => {
  settings.playVolume = Number(e.target.value);
  if (music.instance) music.instance.volume = Number(e.target.value) / 100;
});

$("loginBtn").addEventListener("click", async () => {
  try {
    await music.authorize();
    refreshSetupState();
  } catch (e) {
    pushFeed("warn", e.message);
    alert(e.message);
  }
});

// ── weather (open-meteo: keyless, and the browser has no WeatherKit) ─────

async function currentWeatherLine() {
  try {
    const pos = await new Promise((res, rej) =>
      navigator.geolocation.getCurrentPosition(res, rej, { maximumAge: 1800000, timeout: 6000 })
    );
    const { latitude, longitude } = pos.coords;
    const url = `https://api.open-meteo.com/v1/forecast?latitude=${latitude.toFixed(2)}&longitude=${longitude.toFixed(2)}&current=temperature_2m,weather_code&daily=sunrise,sunset&temperature_unit=fahrenheit&timezone=auto`;
    const res = await fetch(url);
    if (!res.ok) return null;
    const d = await res.json();
    const temp = Math.round(d.current?.temperature_2m);
    const cond = WMO[d.current?.weather_code] || "unsettled";
    let line = `${temp}°F, ${cond}`;
    const sunset = d.daily?.sunset?.[0] && new Date(d.daily.sunset[0]);
    const sunrise = d.daily?.sunrise?.[0] && new Date(d.daily.sunrise[0]);
    if (sunset && sunrise) {
      const now = new Date();
      const near = Math.abs(sunset - now) < Math.abs(sunrise - now) ? ["sunset", sunset] : ["sunrise", sunrise];
      const mins = Math.round(Math.abs(near[1] - now) / 60000);
      line += mins < 90
        ? `; ${near[0]} ${near[1] < now ? `was ${mins} min ago` : `in ${mins} min`}`
        : `; ${near[0]} at ${near[1].toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}`;
    }
    $("wxNow") && ($("wxNow").textContent = `${temp}°`);
    return line;
  } catch {
    return null;
  }
}

const WMO = {
  0: "clear", 1: "partly cloudy", 2: "partly cloudy", 3: "overcast", 45: "fog", 48: "fog",
  51: "drizzle", 53: "drizzle", 55: "drizzle", 61: "rain", 63: "rain", 65: "heavy rain",
  71: "snow", 73: "snow", 75: "snow", 80: "rain", 81: "rain", 82: "heavy rain",
  95: "thunderstorms", 96: "thunderstorms", 99: "thunderstorms",
};

// ── setup state / masthead ──────────────────────────────────────────────

function refreshSetupState() {
  const steps = { sync: !!settings.syncUrl && !!settings.syncSecret, gemini: !!settings.geminiKey, login: music.authorized };
  for (const [k, done] of Object.entries(steps)) {
    document.querySelector(`[data-step="${k}"]`)?.classList.toggle("done", done);
  }
  const ready = steps.sync && steps.gemini && steps.login;
  $("setupCard").hidden = ready;
  $("deck").hidden = !ready;
  $("loginBtn").textContent = music.authorized ? "Apple Music connected" : "Sign in to Apple Music";
}

function refreshShowNow() {
  $("stationName").textContent = settings.stationName;
  const show = effectiveBlock();
  const host = DJ_LABELS[currentDJ()];
  $("showNow").innerHTML = show ? `▸ <b>${escapeHTML(show.name)}</b> · ${host}` : "";
  $("hostNow").textContent = host ? `host: ${host}` : "";
}

// ── drawers ─────────────────────────────────────────────────────────────

const DRAWERS = {
  moods: { title: "moods_", render: renderMoods, el: "moodsView" },
  schedule: { title: "schedule_", render: renderSchedule, el: "scheduleView" },
  timeline: { title: "timeline_", render: renderTimeline, el: "timelineList" },
  booth: { title: "booth feed_", render: renderBooth, el: "boothView" },
  request: { title: "request_", render: () => {}, el: "requestForm" },
};

function openDrawer(name) {
  openDrawerName = name;
  const cfg = DRAWERS[name];
  $("drawerTitle").textContent = cfg.title;
  for (const c of Object.values(DRAWERS)) $(c.el).hidden = true;
  $(cfg.el).hidden = false;
  $("drawer").hidden = false;
  cfg.render();
}

function closeDrawer() {
  openDrawerName = null;
  $("drawer").hidden = true;
}

document.querySelectorAll("[data-drawer]").forEach((b) =>
  b.addEventListener("click", () => openDrawer(b.dataset.drawer))
);
$("drawerClose").addEventListener("click", closeDrawer);

// ── moods ───────────────────────────────────────────────────────────────

function renderMoods() {
  const view = $("moodsView");
  const active = activeInstantBlock();
  if (editingMood) { view.innerHTML = moodEditor(editingMood); wireMoodEditor(); return; }

  view.innerHTML = `
    <p class="drawer-hint">${live
      ? "Tap a mood to take over the airwaves now. It overrides the schedule until the next scheduled show."
      : "Start the station, then a mood takes over instantly."}</p>
    ${active ? `<div class="mood-active">Now on: <b>${escapeHTML(active.name)}</b>
       <button class="text-btn" id="moodClear">back to schedule</button></div>` : ""}
    <div class="mood-grid">
      ${allMoods().map((m) => `
        <div class="mood-card ${active?.id === m.id ? "is-active" : ""}" data-mood="${m.id}">
          <div class="mood-top"><span class="mood-icon">${iconGlyph(m.icon)}</span>
            ${m.isCustom ? `<span class="mood-edit" data-edit="${m.id}" title="Edit">✎</span>` : ""}</div>
          <h4>${escapeHTML(m.name)}</h4>
          <p>${escapeHTML(m.desc)}</p>
        </div>`).join("")}
      <div class="mood-card mood-new" id="moodNew">
        <div class="mood-top"><span class="mood-icon">+</span></div>
        <h4>Create a mood</h4>
        <p>Describe a vibe in your own words and the DJ programs to it.</p>
      </div>
    </div>`;

  view.querySelectorAll("[data-mood]").forEach((el) =>
    el.addEventListener("click", async (e) => {
      if (e.target.dataset.edit) return;
      const mood = allMoods().find((m) => m.id === el.dataset.mood);
      setInstantBlock(mood);
      renderMoods();
      refreshShowNow();
      if (live) { closeDrawer(); await station.applyInstant(mood.name); }
      else pushFeed("dj", `${mood.name} armed — it starts when you power on.`);
    })
  );
  view.querySelectorAll("[data-edit]").forEach((el) =>
    el.addEventListener("click", (e) => {
      e.stopPropagation();
      editingMood = allMoods().find((m) => m.id === el.dataset.edit);
      renderMoods();
    })
  );
  $("moodNew")?.addEventListener("click", () => {
    editingMood = { id: newMoodId(), name: "", icon: MOOD_ICONS[0], dj: "fred", desc: "", isCustom: true };
    renderMoods();
  });
  $("moodClear")?.addEventListener("click", async () => {
    setInstantBlock(null);
    renderMoods();
    refreshShowNow();
    if (live) await station.applyInstant("the schedule");
  });
}

function moodEditor(m) {
  return `
    <div class="block-editor">
      <label>Name <input id="mName" value="${escapeAttr(m.name)}" placeholder="Late Drive" /></label>
      <label>Icon</label>
      <div class="icon-tray">
        ${MOOD_ICONS.map((i) => `<button class="icon-choice ${i === m.icon ? "is-on" : ""}" data-icon="${i}" title="${i}">${iconGlyph(i)}</button>`).join("")}
      </div>
      <label>Host <select id="mDJ">${DJS.map((d) => `<option value="${d.id}" ${d.id === m.dj ? "selected" : ""}>${d.name}</option>`).join("")}</select></label>
      <label>Brief for the host <textarea id="mDesc" rows="5" placeholder="The feeling, the genres, the tempo, what to avoid.">${escapeHTML(m.desc)}</textarea></label>
      <p class="fine">Write it like you're briefing a real DJ — this is handed straight to them.</p>
      <div class="editor-actions">
        ${m.isCustom && customMoods().some((c) => c.id === m.id) ? `<button class="text-btn danger" id="mDelete">Delete</button>` : ""}
        <span class="grow"></span>
        <button class="text-btn" id="mCancel">Cancel</button>
        <button class="solid" id="mSave">Save mood</button>
      </div>
    </div>`;
}

function wireMoodEditor() {
  let icon = editingMood.icon;
  document.querySelectorAll("[data-icon]").forEach((b) =>
    b.addEventListener("click", () => {
      icon = b.dataset.icon;
      document.querySelectorAll("[data-icon]").forEach((o) => o.classList.toggle("is-on", o === b));
    })
  );
  $("mCancel").addEventListener("click", () => { editingMood = null; renderMoods(); });
  $("mDelete")?.addEventListener("click", () => {
    deleteMood(editingMood.id);
    editingMood = null;
    renderMoods();
  });
  $("mSave").addEventListener("click", () => {
    const desc = $("mDesc").value.trim();
    if (!desc) { alert("Give the host a brief — that's what they program from."); return; }
    upsertMood({
      id: editingMood.id,
      name: $("mName").value.trim() || "Untitled Mood",
      icon, dj: $("mDJ").value, desc,
    });
    editingMood = null;
    renderMoods();
  });
}

// SF Symbol names come from the shared mood format; map the common ones to
// glyphs the web can draw, and fall back to a dot.
const ICON_GLYPHS = {
  "bolt.fill": "⚡", scope: "◎", "figure.walk": "→", "moon.fill": "☾", sparkles: "✷", asterisk: "❋",
  "sun.max.fill": "☀", "cloud.rain.fill": "☂", snowflake: "❄", "flame.fill": "🔥", "leaf.fill": "❦", "drop.fill": "💧",
  "car.fill": "🚗", airplane: "✈", "tram.fill": "🚋", bicycle: "🚲", "figure.run": "🏃", "dumbbell.fill": "🏋",
  "book.fill": "📖", "briefcase.fill": "💼", desktopcomputer: "🖥", "paintpalette.fill": "🎨", "camera.fill": "📷",
  "fork.knife": "🍴", "cup.and.saucer.fill": "☕", "wineglass.fill": "🍷", "house.fill": "🏠", "bed.double.fill": "🛏",
  "guitars.fill": "🎸", pianokeys: "🎹", headphones: "🎧", "radio.fill": "📻", waveform: "〜",
  "heart.fill": "♥", "star.fill": "★", "brain.head.profile": "🧠", "globe.americas.fill": "🌎", "map.fill": "🗺",
  "mountain.2.fill": "⛰", "beach.umbrella.fill": "⛱", "tree.fill": "🌲", "binoculars.fill": "🔭",
  "clock.fill": "🕐", hourglass: "⧗", "sunrise.fill": "🌅", "sunset.fill": "🌇", shuffle: "⤨", infinity: "∞",
};
const iconGlyph = (name) => ICON_GLYPHS[name] || "•";

// ── timeline / schedule / request / settings ────────────────────────────

function renderTimeline() {
  const list = $("timelineList");
  const up = station.upNext || [];
  list.innerHTML = `
    ${up.length ? `<li class="tl-head">Up next</li>` + up.map((t) =>
      `<li><span class="tl-name">${escapeHTML(t.name)}</span><span class="tl-sub">${escapeHTML(t.artist)}</span></li>`).join("") : ""}
    ${sessionPlayed.length ? `<li class="tl-head">Played</li>` + sessionPlayed.map((t) =>
      `<li><span class="tl-name">${escapeHTML(t.name)}</span><span class="tl-sub">${escapeHTML(t.artist)} · ${t.time.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}</span></li>`).join("") : ""}
    ${!up.length && !sessionPlayed.length ? `<li class="empty">The timeline fills as music plays.</li>` : ""}`;
}

function renderSchedule() {
  const week = loadSchedule();
  const now = currentBlock(week);
  const blocks = (week[scheduleDay] || []).slice().sort((a, b) => a.start - b.start);
  $("scheduleView").innerHTML = `
    <div class="day-tabs">${DAYS.map((d) =>
      `<button data-day="${d}" class="${d === scheduleDay ? "active" : ""}">${DAY_LABELS[d]}</button>`).join("")}</div>
    <div class="sched-actions">
      <button class="text-btn accent" id="addShow">+ add show</button><span class="grow"></span>
      <button class="text-btn" id="resetWeek">reset week</button>
    </div>
    ${blocks.map((b, i) => editingBlock === b.id ? blockForm(week, b) : `
      <div class="block-row" data-block="${b.id || i}">
        <div class="rowtop"><span>${fmtHour(b.start)}–${fmtHour(b.end)} · ${DJ_LABELS[b.dj] || "Fred"}</span>
        ${scheduleDay === dayKey() && b === now ? `<span class="onnow">● ON NOW</span>` : ""}</div>
        <h4>${escapeHTML(b.name)}</h4><p>${escapeHTML(b.desc || "")}</p>
      </div>`).join("")}`;

  $("scheduleView").querySelectorAll("[data-day]").forEach((b) =>
    b.addEventListener("click", () => { scheduleDay = b.dataset.day; editingBlock = null; renderSchedule(); }));
  $("scheduleView").querySelectorAll("[data-block]").forEach((el, i) =>
    el.addEventListener("click", () => { editingBlock = blocks[i].id || (blocks[i].id = crypto.randomUUID()); renderSchedule(); }));
  $("addShow").addEventListener("click", () => {
    const week2 = loadSchedule();
    (week2[scheduleDay] ||= []).push({ id: crypto.randomUUID(), start: 12, end: 14, name: "New Show", desc: "", dj: "fred" });
    saveSchedule(week2);
    renderSchedule();
  });
  $("resetWeek").addEventListener("click", () => {
    if (confirm("Reset the whole week to defaults?")) { resetSchedule(); editingBlock = null; renderSchedule(); }
  });
}

function blockForm(week, b) {
  const hours = (from, to, sel) => Array.from({ length: to - from + 1 }, (_, i) => from + i)
    .map((h) => `<option value="${h}" ${h === sel ? "selected" : ""}>${fmtHour(h)}</option>`).join("");
  return `<div class="block-editor" data-editing="${b.id}">
    <label>Show name <input id="bName" value="${escapeAttr(b.name)}" /></label>
    <div class="editor-grid">
      <label>From <select id="bStart">${hours(0, 23, b.start)}</select></label>
      <label>To <select id="bEnd">${hours(1, 24, b.end)}</select></label>
      <label>Host <select id="bDJ">${DJS.map((d) => `<option value="${d.id}" ${d.id === b.dj ? "selected" : ""}>${d.name}</option>`).join("")}</select></label>
    </div>
    <label>Brief for the host <textarea id="bDesc" rows="4">${escapeHTML(b.desc || "")}</textarea></label>
    <div class="editor-actions">
      <button class="text-btn danger" onclick="window.__delBlock('${b.id}')">Delete</button><span class="grow"></span>
      <button class="text-btn" onclick="window.__cancelBlock()">Cancel</button>
      <button class="solid" onclick="window.__saveBlock('${b.id}')">Save</button>
    </div></div>`;
}

window.__cancelBlock = () => { editingBlock = null; renderSchedule(); };
window.__delBlock = (id) => {
  const week = loadSchedule();
  week[scheduleDay] = (week[scheduleDay] || []).filter((b) => b.id !== id);
  saveSchedule(week); editingBlock = null; renderSchedule();
};
window.__saveBlock = (id) => {
  const week = loadSchedule();
  const b = (week[scheduleDay] || []).find((x) => x.id === id);
  if (b) {
    b.name = $("bName").value.trim() || "Untitled Show";
    b.desc = $("bDesc").value.trim();
    b.start = Number($("bStart").value);
    b.end = Number($("bEnd").value);
    b.dj = $("bDJ").value;
    saveSchedule(week);
  }
  editingBlock = null; renderSchedule();
};

$("requestForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const text = $("requestInput").value.trim();
  if (!text) return;
  const status = $("requestStatus");
  status.hidden = false;
  status.textContent = "digging through the stacks…";
  try {
    const { track, when } = await station.fulfillRequest(text);
    status.textContent = when === "next"
      ? `Found it. Coming up next: ${track.artist} – ${track.name}`
      : `Found it. Now playing: ${track.artist} – ${track.name}`;
    $("requestInput").value = "";
  } catch (err) {
    status.textContent = err.message;
  }
});

// ── settings ────────────────────────────────────────────────────────────

function fillSettingsForm() {
  $("setStationName").value = settings.stationName;
  $("setGeminiKey").value = settings.geminiKey;
  $("setSyncUrl").value = settings.syncUrl;
  $("setSyncSecret").value = settings.syncSecret;
  $("setDuck").value = settings.duckVolume;
  $("setDJOverride").innerHTML = `<option value="schedule">Follow the schedule</option>` +
    DJS.map((d) => `<option value="${d.id}">Always ${d.name}</option>`).join("");
  $("setDJOverride").value = settings.djOverride;
  const voices = availableVoices();
  $("setVoice").innerHTML = `<option value="">Automatic</option>` +
    voices.map((v) => `<option value="${escapeAttr(v.name)}">${escapeHTML(v.name)}</option>`).join("");
  $("setVoice").value = settings.voiceName;
  $("wxAttribution").textContent = "Weather by Open-Meteo.";
}

$("settingsBtn").addEventListener("click", () => { fillSettingsForm(); $("settingsDialog").showModal(); });
$("saveSettingsBtn").addEventListener("click", (e) => {
  e.preventDefault();
  settings.stationName = $("setStationName").value;
  settings.geminiKey = $("setGeminiKey").value;
  settings.syncUrl = $("setSyncUrl").value;
  settings.syncSecret = $("setSyncSecret").value;
  settings.duckVolume = Number($("setDuck").value);
  settings.voiceName = $("setVoice").value;
  if (settings.djOverride !== $("setDJOverride").value) {
    settings.djOverride = $("setDJOverride").value;
    markSettingsChanged();
  }
  $("settingsDialog").close();
  refreshSetupState();
  refreshShowNow();
});
$("testSyncBtn").addEventListener("click", async (e) => {
  e.preventDefault();
  const el = $("syncStatus");
  el.hidden = false;
  el.textContent = "testing…";
  settings.syncUrl = $("setSyncUrl").value;
  settings.syncSecret = $("setSyncSecret").value;
  el.textContent = await testSync();
});
$("testVoiceBtn")?.addEventListener("click", (e) => {
  e.preventDefault();
  const u = new SpeechSynthesisUtterance("Frediohead FM. Voice check complete.");
  const v = availableVoices().find((x) => x.name === $("setVoice").value);
  if (v) u.voice = v;
  speechSynthesis.speak(u);
});
$("reconnectBtn").addEventListener("click", async (e) => {
  e.preventDefault();
  await music.unauthorize();
  refreshSetupState();
});
document.querySelectorAll(".booth-tabs button").forEach((b) =>
  b.addEventListener("click", () => {
    boothFilter = b.dataset.filter;
    document.querySelectorAll(".booth-tabs button").forEach((o) => o.classList.toggle("active", o === b));
    renderBooth();
  })
);

// ── utilities ───────────────────────────────────────────────────────────

function escapeHTML(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
const escapeAttr = escapeHTML;

// ── boot ────────────────────────────────────────────────────────────────

(async function boot() {
  waveform = createWaveform($("waveform"));
  buddy = createBuddy($("buddyMount"));
  $("volume").value = settings.playVolume;
  idleDisplay();
  refreshShowNow();
  refreshSetupState();
  renderBooth();

  // MusicKit configures from a Worker-signed token; without sync settings
  // it can't, and the setup card explains why.
  try {
    await music.configure();
    refreshSetupState();
  } catch (e) {
    pushFeed("warn", e.message);
  }

  await pullSchedule();
  refreshShowNow();
  setInterval(() => { pullSchedule().then(refreshShowNow); }, 60000);
  setInterval(refreshShowNow, 60000);
  currentWeatherLine().then((w) => { station.weatherText = w; });
})();
