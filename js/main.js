// UI wiring. The page mirrors whatever Spotify is playing at all times
// (Subwave-style: the broadcast is just *on*); the power knob controls
// whether Fred is programming the station on top of it.
import { settings, computeRedirectUri } from "./config.js";
import { handleCallback, beginLogin, isLoggedIn } from "./auth.js";
import { spotify } from "./spotify.js";
import { Station } from "./station.js";
import { availableVoices } from "./voice.js";
import { initBrowserPlayer, activateBrowserPlayback } from "./player.js";
import { createWaveform } from "./waveform.js";
import { createBuddy } from "./buddy.js";
import { loadSchedule, saveSchedule, resetSchedule, currentBlock, dayKey, fmtHour, DAYS, DAY_LABELS, DJ_LABELS } from "./schedule.js";
import { suggestSchedule } from "./dj.js";
import { fetchSyncedLyrics } from "./lyrics.js";
import { getWeather } from "./weather.js";

const $ = (id) => document.getElementById(id);

let browserDeviceId = null;
let live = false;
let preMuteVolume = null;
let waveform = null;
let buddy = null;
let lastProgress = null; // { ms, duration, at } for between-poll interpolation
let currentTrackId = null;
let displayedUri = null;
let airPlaying = false;
let sessionPlayed = []; // [{name, artists, time}] newest first
let openDrawerName = null;
let scheduleDay = dayKey();
let editingBlock = null;
let boothFilter = "all";
const boothFeed = []; // newest first: { time, kind: play|dj|warn|system, title, sub }
const requestUris = new Set();
let lyricsLines = null;
let lyricsIndex = -1;

// ---------- booth feed ----------

function pushFeed(kind, title, sub) {
  boothFeed.unshift({ time: new Date().toLocaleTimeString(), kind, title, sub });
  if (boothFeed.length > 120) boothFeed.pop();
  if (openDrawerName === "booth") renderBooth();
}

const FEED_LABEL = { play: "Play", dj: "DJ", warn: "System", system: "System" };

function renderBooth() {
  const list = $("log");
  list.innerHTML = "";
  for (const e of boothFeed) {
    if (boothFilter === "dj" && e.kind !== "dj") continue;
    if (boothFilter === "play" && e.kind !== "play") continue;
    const li = document.createElement("li");
    li.className = e.kind;
    const head = document.createElement("div");
    head.className = "bf-head";
    head.append(`${e.time}  `);
    const b = document.createElement("b");
    b.textContent = FEED_LABEL[e.kind] || e.kind;
    head.appendChild(b);
    li.appendChild(head);
    const title = document.createElement("div");
    title.className = "bf-title";
    title.textContent = e.title;
    li.appendChild(title);
    if (e.sub) {
      const sub = document.createElement("div");
      sub.className = "bf-sub";
      sub.textContent = e.sub;
      li.appendChild(sub);
    }
    list.appendChild(li);
  }
  if (!list.children.length) {
    const li = document.createElement("li");
    li.innerHTML = '<div class="bf-title">Nothing here yet.</div>';
    list.appendChild(li);
  }
}

document.querySelectorAll(".booth-tabs button").forEach((btn) => {
  btn.onclick = () => {
    boothFilter = btn.dataset.filter;
    document.querySelectorAll(".booth-tabs button").forEach((b) => b.classList.toggle("active", b === btn));
    renderBooth();
  };
});

// ---------- now-playing display ----------

function showDJLine(text, kind) {
  $("djLine").hidden = false;
  const target = $("djText");
  target.innerHTML = "";
  const words = (kind === "voice" ? `“${text}”` : text).split(/\s+/);
  const stagger = Math.min(80, 500 / words.length);
  words.forEach((w, i) => {
    const span = document.createElement("span");
    span.className = "word";
    span.style.animationDelay = `${i * stagger}ms`;
    span.textContent = (i ? " " : "") + w;
    target.appendChild(span);
  });
}

async function refreshMetaAndLike(item) {
  currentTrackId = item.id;
  $("metaStrip").hidden = true;
  $("likeBtn").hidden = false;
  $("likeBtn").classList.remove("liked");
  try {
    const [saved, artist] = await Promise.all([
      spotify.isTrackSaved(item.id),
      item.artists?.[0]?.id ? spotify.artist(item.artists[0].id) : null,
    ]);
    if (currentTrackId !== item.id) return;
    $("likeBtn").classList.toggle("liked", !!saved);
    const tokens = (artist?.genres || []).slice(0, 3);
    const mins = Math.floor(item.duration_ms / 60000);
    const secs = String(Math.floor((item.duration_ms % 60000) / 1000)).padStart(2, "0");
    tokens.push(`${mins}:${secs}`);
    $("metaStrip").textContent = tokens.join(" · ");
    $("metaStrip").hidden = false;
  } catch {}
}

function displayTrack(item) {
  if (item.uri === displayedUri) return;
  displayedUri = item.uri;
  const title = $("trackTitle");
  // The artist line already names features; radio-trim them from the title.
  title.textContent = item.name.replace(/\s*[([](feat\.?|with|ft\.?)[^)\]]*[)\]]/gi, "").trim() || item.name;
  title.classList.remove("idle");
  $("trackArtist").textContent = item.artists.map((a) => a.name).join(", ");
  const art = item.album?.images?.[1]?.url || item.album?.images?.[0]?.url;
  if (art) {
    $("art").src = art;
    $("art").hidden = false;
  }
  $("upNextTease").hidden = true;
  lastProgress = null;
  sessionPlayed.unshift({
    name: item.name,
    artists: item.artists.map((a) => a.name).join(", "),
    time: new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }),
    id: item.id,
  });
  sessionPlayed = sessionPlayed.slice(0, 40);
  const artists = item.artists.map((a) => a.name).join(", ");
  pushFeed("play", `“${item.name}” by ${artists}`,
    `Source: ${requestUris.has(item.uri) ? "request" : live ? "auto" : "spotify"}`);
  refreshMetaAndLike(item);
  loadLyrics(item);
  if (openDrawerName === "timeline") renderTimeline();
}

// ---------- lyrics ----------

async function loadLyrics(item) {
  lyricsLines = null;
  lyricsIndex = -1;
  $("lyricsBox").hidden = true;
  const uri = item.uri;
  const lines = await fetchSyncedLyrics({
    artist: item.artists?.[0]?.name || "",
    track: item.name,
    album: item.album?.name,
    durationSec: (item.duration_ms || 0) / 1000,
  });
  if (!lines || displayedUri !== uri) return;
  lyricsLines = lines;
  const scroll = $("lyricsScroll");
  scroll.innerHTML = "";
  scroll.style.transform = "translateY(0)";
  for (const l of lines) {
    const p = document.createElement("p");
    p.textContent = l.text || "…";
    scroll.appendChild(p);
  }
  $("lyricsBox").hidden = false;
}

setInterval(() => {
  if (!lyricsLines || !lastProgress?.duration || $("lyricsBox").hidden) return;
  const ms = lastProgress.ms + (performance.now() - lastProgress.at);
  let idx = -1;
  for (let i = 0; i < lyricsLines.length && lyricsLines[i].t <= ms; i++) idx = i;
  if (idx === lyricsIndex) return;
  lyricsIndex = idx;
  if (idx >= 0) waveform?.pulse(); // a lyric line landing = real musical timing
  const scroll = $("lyricsScroll");
  const kids = scroll.children;
  for (let i = 0; i < kids.length; i++) kids[i].classList.toggle("current", i === idx);
  if (idx >= 0 && kids[idx]) {
    const target = Math.max(0, kids[idx].offsetTop - $("lyricsBox").clientHeight * 0.38);
    scroll.style.transform = `translateY(-${target}px)`;
  } else {
    scroll.style.transform = "translateY(0)";
  }
}, 300);

function idleDisplay() {
  displayedUri = null;
  const title = $("trackTitle");
  title.textContent = "scanning the dial";
  title.classList.add("idle");
  $("trackArtist").textContent = "press power to tune in";
  $("art").hidden = true;
  $("upNextTease").hidden = true;
  $("metaStrip").hidden = true;
  $("likeBtn").hidden = true;
  $("lyricsBox").hidden = true;
  lyricsLines = null;
  lastProgress = null;
}

// signal + waveform + chip react to whether MUSIC is audible; the signal
// label distinguishes Fred broadcasting from plain Spotify playback.
function setAirVisuals(playing, mode) {
  airPlaying = playing;
  waveform?.setOnAir(playing);
  $("onairChip").hidden = !playing;
  const label = mode === "onair" ? "On air" : mode === "tuning" ? "Tuning…" : playing ? "Receiving" : "Standby";
  $("signalState").textContent = label;
  $("signalState").classList.toggle("onair", mode === "onair");
  if (!playing) $("dialNeedle").style.left = "1%";
}

// ---------- station ----------

const station = new Station({
  onNowPlaying(item) {
    displayTrack(item);
  },
  onUpNext() {
    if (openDrawerName === "timeline") renderTimeline();
  },
  onLog(text, kind = "info") {
    pushFeed(kind === "dj" ? "dj" : kind === "warn" ? "warn" : "system", text);
  },
  onProgress(ms, duration, nextTrack) {
    lastProgress = { ms, duration, at: performance.now() };
    const remaining = duration - ms;
    if (nextTrack && remaining > 0 && remaining < 30000) {
      $("upNextTease").textContent = `Up next · ${nextTrack.name} — ${nextTrack.artists[0].name}`;
      $("upNextTease").hidden = false;
    } else {
      $("upNextTease").hidden = true;
    }
  },
  onDJLine(text, kind) {
    showDJLine(text, kind);
    buddy?.react(kind);
  },
  onStatus(status) {
    const on = status === "onair";
    $("startBtn").classList.toggle("on", on || status === "tuning");
    $("startBtn").disabled = status === "tuning";
    $("skipBtn").disabled = !on;
    if (status === "tuning") {
      buddy?.wake();
      showDJLine("warming up the transmitter…", "dj");
      setAirVisuals(false, "tuning");
    } else if (on) {
      setAirVisuals(true, "onair");
    } else {
      buddy?.sleep();
      showDJLine("fred is asleep — press power to wake him", "dj");
      mirrorTick(true); // maybe plain Spotify is still playing
    }
  },
});

// ---------- mirror: reflect Spotify playback when Fred is off ----------

async function mirrorTick(force = false) {
  if ((live && !force) || !isLoggedIn()) return;
  try {
    const state = await spotify.playerState();
    const item = state?.item;
    if (item && state.is_playing) {
      displayTrack(item);
      lastProgress = { ms: state.progress_ms ?? 0, duration: item.duration_ms ?? 0, at: performance.now() };
      if (!live) setAirVisuals(true, "receiving");
    } else if (!live) {
      setAirVisuals(false);
      if (!item) idleDisplay();
    }
  } catch {}
}
setInterval(() => mirrorTick(), 5000);

// needle wander: never quite stable, like a real tuner
setInterval(() => {
  if (!airPlaying) return;
  const base = 42;
  $("dialNeedle").style.left = `${base + (Math.random() * 7 - 3.5)}%`;
}, 1300);

// "Now playing — 2:17 / 6:45" elapsed readout
const fmtMs = (ms) => `${Math.floor(ms / 60000)}:${String(Math.floor((ms % 60000) / 1000)).padStart(2, "0")}`;
setInterval(() => {
  if (airPlaying && lastProgress?.duration) {
    const ms = Math.min(lastProgress.ms + (performance.now() - lastProgress.at), lastProgress.duration);
    $("npLabel").textContent = `Now playing — ${fmtMs(ms)} / ${fmtMs(lastProgress.duration)}`;
  } else {
    $("npLabel").textContent = "Now playing";
  }
}, 1000);

// current show + local weather in the header, like a real station ident
async function refreshShowNow() {
  const block = currentBlock(loadSchedule());
  const weather = await getWeather();
  station.weatherText = weather?.text || null;
  $("showNow").innerHTML = "";
  if (block) {
    $("showNow").append("▸ ");
    const b = document.createElement("b");
    b.textContent = block.name;
    $("showNow").appendChild(b);
    $("showNow").append(` · ${fmtHour(block.start)}–${fmtHour(block.end)}`);
  }
  if (weather) $("showNow").append(`${block ? " · " : ""}${weather.tempF}° ${weather.description.toUpperCase()}`);
}
refreshShowNow();
setInterval(refreshShowNow, 60000);

// ---------- setup / devices ----------

function refreshSetupState() {
  const steps = {
    clientId: !!settings.clientId,
    login: isLoggedIn(),
    gemini: !!settings.geminiKey,
    device: true,
  };
  document.querySelectorAll("#setupSteps li").forEach((li) => {
    li.classList.toggle("done", steps[li.dataset.step]);
  });
  const ready = steps.clientId && steps.login && steps.gemini;
  $("setupCard").hidden = ready;
  $("deck").hidden = !ready;
  $("stationName").textContent = settings.stationName;
  document.title = settings.stationName;
  if (ready && $("djLine").hidden) showDJLine("fred is asleep — press power to wake him", "dj");
}

async function refreshDevices() {
  if (!isLoggedIn()) return;
  try {
    const devices = await spotify.devices();
    const sel = $("deviceSelect");
    sel.innerHTML = "";
    if (browserDeviceId) {
      const opt = document.createElement("option");
      opt.value = browserDeviceId;
      opt.textContent = "▶ Play in this tab";
      opt.selected = true;
      sel.appendChild(opt);
    }
    for (const d of devices) {
      if (d.id === browserDeviceId) continue;
      const opt = document.createElement("option");
      opt.value = d.id;
      opt.textContent = `${d.name} (${d.type})`;
      if (!browserDeviceId && d.type === "Computer") opt.selected = true;
      sel.appendChild(opt);
    }
    if (!sel.children.length) {
      const opt = document.createElement("option");
      opt.textContent = "No devices — open the Spotify app";
      opt.value = "";
      sel.appendChild(opt);
    }
  } catch (e) {
    station.events.onLog(`Device list failed: ${e.message}`, "warn");
  }
}

// ---------- drawers ----------

const DRAWERS = {
  schedule: { title: "schedule_", el: "scheduleView" },
  timeline: { title: "timeline_", el: "timelineList" },
  booth: { title: "booth feed_", el: "boothView" },
  request: { title: "request_", el: "requestForm" },
};

function openDrawer(name) {
  const conf = DRAWERS[name];
  openDrawerName = name;
  $("drawerTitle").textContent = conf.title;
  for (const d of Object.values(DRAWERS)) $(d.el).hidden = d.el !== conf.el;
  $("drawer").hidden = false;
  if (name === "request") $("requestInput").focus();
  if (name === "timeline") renderTimeline();
  if (name === "schedule") renderSchedule();
  if (name === "booth") renderBooth();
}

function closeDrawer() {
  $("drawer").hidden = true;
  openDrawerName = null;
}

document.querySelectorAll(".rail-btn").forEach((btn) => {
  btn.onclick = () => openDrawer(btn.dataset.drawer);
});
$("drawerClose").onclick = closeDrawer;
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && !$("drawer").hidden) closeDrawer();
});

// ---------- timeline ----------

function tlItem(name, artists, extra, cls, trackId) {
  const li = document.createElement("li");
  if (cls) li.className = cls;
  if (trackId) li.dataset.tid = trackId;
  if (extra) {
    const t = document.createElement("time");
    t.textContent = extra;
    li.appendChild(t);
  }
  li.append(name);
  const span = document.createElement("span");
  span.textContent = artists;
  li.appendChild(span);
  return li;
}

// After the timeline renders, mark every row whose track is in Liked Songs.
async function annotateLikedHearts(list) {
  const rows = [...list.querySelectorAll("li[data-tid]")];
  const ids = [...new Set(rows.map((r) => r.dataset.tid))].slice(0, 50);
  if (!ids.length) return;
  try {
    const flags = await spotify.containsTracks(ids);
    const liked = new Set(ids.filter((_, i) => flags[i]));
    for (const row of rows) {
      if (!liked.has(row.dataset.tid)) continue;
      const heart = document.createElement("span");
      heart.className = "tl-heart";
      heart.textContent = "♥";
      row.insertBefore(heart, row.querySelector("span"));
    }
  } catch {}
}

async function renderTimeline() {
  const list = $("timelineList");
  list.innerHTML = "";
  const section = (label) => {
    const li = document.createElement("li");
    li.className = "tl-section";
    li.textContent = label;
    list.appendChild(li);
  };

  if (live && station.upNext.length) {
    section("Up next");
    for (const t of station.upNext) {
      list.appendChild(tlItem(t.name, t.artists.map((a) => a.name).join(", "), null, null, t.uri?.split(":").pop()));
    }
  }
  if (sessionPlayed.length) {
    section("On air");
    const now = sessionPlayed[0];
    list.appendChild(tlItem(now.name, now.artists, now.time, "tl-now", now.id));
    if (sessionPlayed.length > 1) {
      section("Earlier this session");
      for (const p of sessionPlayed.slice(1)) list.appendChild(tlItem(p.name, p.artists, p.time, null, p.id));
    }
  }
  try {
    const recent = await spotify.recentlyPlayed(12);
    if (recent.length) {
      section("Earlier on Spotify");
      const seen = new Set(sessionPlayed.map((p) => `${p.artists} – ${p.name}`));
      for (const r of recent) {
        const artists = r.track.artists.map((a) => a.name).join(", ");
        if (seen.has(`${artists} – ${r.track.name}`)) continue;
        const when = new Date(r.played_at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
        list.appendChild(tlItem(r.track.name, artists, when, null, r.track.id));
      }
    }
  } catch {}
  if (!list.children.length) {
    list.appendChild(tlItem("Nothing yet", "The timeline fills as music plays."));
  }
  annotateLikedHearts(list);
}

// ---------- request ----------

$("requestForm").onsubmit = async (e) => {
  e.preventDefault();
  const text = $("requestInput").value.trim();
  if (!text) return;
  const status = $("requestStatus");
  status.classList.remove("error");
  status.textContent = "fred is digging through the stacks…";
  status.hidden = false;
  try {
    const { track, when } = await station.fulfillRequest(text, $("deviceSelect").value);
    requestUris.add(track.uri);
    const label = `${track.artists.map((a) => a.name).join(", ")} – ${track.name}`;
    status.textContent = when === "next" ? `Found it. Coming up next: ${label}` : `Found it. Now playing: ${label}`;
    $("requestInput").value = "";
    mirrorTick(true);
  } catch (err) {
    status.textContent = err.message;
    status.classList.add("error");
  }
};

// ---------- schedule ----------

function renderSchedule() {
  const view = $("scheduleView");
  const week = loadSchedule();
  view.innerHTML = "";

  const tabs = document.createElement("div");
  tabs.className = "day-tabs";
  for (const d of DAYS) {
    const b = document.createElement("button");
    b.textContent = DAY_LABELS[d];
    b.classList.toggle("active", d === scheduleDay);
    b.onclick = () => { scheduleDay = d; editingBlock = null; renderSchedule(); };
    tabs.appendChild(b);
  }
  view.appendChild(tabs);

  const actions = document.createElement("div");
  actions.className = "sched-actions";
  const ai = document.createElement("button");
  ai.className = "text-btn";
  ai.textContent = "✦ suggest a week with AI";
  ai.onclick = suggestWeekWithAI;
  const add = document.createElement("button");
  add.className = "text-btn";
  add.textContent = "+ add block";
  add.onclick = () => {
    week[scheduleDay].push({ start: 12, end: 14, name: "New Show", desc: "" });
    saveSchedule(week);
    editingBlock = week[scheduleDay].length - 1;
    renderSchedule();
  };
  const reset = document.createElement("button");
  reset.className = "text-btn";
  reset.textContent = "reset to defaults";
  reset.onclick = () => {
    if (confirm("Replace the whole week with the default schedule?")) {
      resetSchedule();
      editingBlock = null;
      renderSchedule();
    }
  };
  actions.append(ai, add, reset);
  view.appendChild(actions);

  const nowBlock = currentBlock(week);
  const blocks = [...week[scheduleDay]].sort((a, b) => a.start - b.start);
  blocks.forEach((block) => {
    const idx = week[scheduleDay].indexOf(block);
    if (editingBlock === idx) {
      view.appendChild(blockForm(week, idx));
      return;
    }
    const div = document.createElement("div");
    div.className = "sched-block";
    if (scheduleDay === dayKey() && nowBlock && block.name === nowBlock.name && block.start === nowBlock.start) {
      div.classList.add("now");
    }
    div.innerHTML = `
      <div class="sched-time">${fmtHour(block.start)}–${fmtHour(block.end)} · with ${DJ_LABELS[block.dj] || "Fred"}</div>
      <div class="sched-name"></div>
      <div class="sched-desc"></div>`;
    div.querySelector(".sched-name").textContent = block.name;
    div.querySelector(".sched-desc").textContent = block.desc;
    div.onclick = () => { editingBlock = idx; renderSchedule(); };
    view.appendChild(div);
  });

  const note = document.createElement("p");
  note.className = "sched-note";
  note.textContent = "Tap a block to edit its hours, name, or brief. Fred programs each block from its brief while the station is live.";
  view.appendChild(note);
}

function blockForm(week, idx) {
  const block = week[scheduleDay][idx];
  const form = document.createElement("div");
  form.className = "sched-form";
  form.innerHTML = `
    <input class="f-name" placeholder="Show name" />
    <div class="times">from <input class="f-start" type="number" min="0" max="23" /> :00
      to <input class="f-end" type="number" min="1" max="24" /> :00
      · DJ <select class="f-dj"><option value="fred">Fred</option><option value="lotus">Lotus</option></select></div>
    <textarea class="f-desc" placeholder="Brief for the DJ: mood, genres, energy, what to avoid"></textarea>
    <div class="row">
      <button class="text-btn f-delete">delete</button>
      <button class="text-btn f-cancel">cancel</button>
      <button class="solid f-save">Save</button>
    </div>`;
  form.querySelector(".f-name").value = block.name;
  form.querySelector(".f-start").value = block.start;
  form.querySelector(".f-end").value = block.end;
  form.querySelector(".f-dj").value = block.dj || "fred";
  form.querySelector(".f-desc").value = block.desc;
  form.querySelector(".f-save").onclick = () => {
    block.name = form.querySelector(".f-name").value.trim() || "Untitled Show";
    block.start = Math.max(0, Math.min(23, Number(form.querySelector(".f-start").value) || 0));
    block.end = Math.max(1, Math.min(24, Number(form.querySelector(".f-end").value) || 24));
    block.dj = form.querySelector(".f-dj").value === "lotus" ? "lotus" : "fred";
    block.desc = form.querySelector(".f-desc").value.trim();
    saveSchedule(week);
    editingBlock = null;
    renderSchedule();
  };
  form.querySelector(".f-cancel").onclick = () => { editingBlock = null; renderSchedule(); };
  form.querySelector(".f-delete").onclick = () => {
    week[scheduleDay].splice(idx, 1);
    saveSchedule(week);
    editingBlock = null;
    renderSchedule();
  };
  return form;
}

async function suggestWeekWithAI() {
  if (!confirm("Ask the AI to write a fresh week of programming from your Spotify taste? This replaces the current schedule.")) return;
  const view = $("scheduleView");
  view.innerHTML = '<p class="sched-note">✦ designing your week from your listening taste…</p>';
  try {
    if (!station.tasteProfile) station.tasteProfile = await station.buildTasteProfile();
    const result = await suggestSchedule(station.tasteProfile);
    const week = {};
    for (const d of result.days || []) {
      if (DAYS.includes(d.day) && Array.isArray(d.blocks) && d.blocks.length) week[d.day] = d.blocks;
    }
    for (const d of DAYS) if (!week[d]) throw new Error(`The AI schedule came back missing ${DAY_LABELS[d]} — try again.`);
    saveSchedule(week);
    station.events.onLog("New week of programming installed.", "dj");
  } catch (e) {
    station.events.onLog(`Schedule suggestion failed: ${e.message}`, "warn");
  }
  editingBlock = null;
  renderSchedule();
}

// ---------- settings ----------

function fillSettingsForm() {
  $("setStationName").value = settings.stationName;
  $("setClientId").value = settings.clientId;
  $("setGeminiKey").value = settings.geminiKey;
  $("setDuck").value = settings.duckVolume;
  $("setDJOverride").value = settings.djOverride;
  $("setElevenKey").value = settings.elevenKey;
  $("setElevenVoiceId").value = settings.elevenVoiceId === "21m00Tcm4TlvDq8ikWAM" ? "" : settings.elevenVoiceId;
  $("redirectUriShown").value = computeRedirectUri();
  const sel = $("setVoice");
  sel.innerHTML = "";
  for (const v of availableVoices()) {
    const opt = document.createElement("option");
    opt.value = v.name;
    opt.textContent = v.name;
    if (v.name === settings.voiceName) opt.selected = true;
    sel.appendChild(opt);
  }
}

$("settingsBtn").onclick = () => { fillSettingsForm(); $("settingsDialog").showModal(); };

$("saveSettingsBtn").onclick = () => {
  settings.stationName = $("setStationName").value;
  settings.clientId = $("setClientId").value;
  settings.geminiKey = $("setGeminiKey").value;
  settings.duckVolume = Number($("setDuck").value);
  settings.voiceName = $("setVoice").value;
  settings.djOverride = $("setDJOverride").value;
  settings.elevenKey = $("setElevenKey").value;
  settings.elevenVoiceId = $("setElevenVoiceId").value;
  $("settingsDialog").close();
  refreshSetupState();
  refreshDevices();
};

$("reconnectBtn").onclick = () => {
  settings.clientId = $("setClientId").value;
  if (settings.clientId) beginLogin();
};

$("testVoiceBtn").onclick = () => {
  const u = new SpeechSynthesisUtterance("You're listening to " + settings.stationName + ". Stay tuned.");
  const v = availableVoices().find((x) => x.name === $("setVoice").value);
  if (v) u.voice = v;
  speechSynthesis.speak(u);
};

$("loginBtn").onclick = () => {
  if (!settings.clientId) {
    fillSettingsForm();
    $("settingsDialog").showModal();
    return;
  }
  beginLogin();
};

// ---------- transport ----------

async function powerOn() {
  const deviceId = $("deviceSelect").value;
  if (!deviceId) {
    station.events.onLog("Open the Spotify desktop app first, then hit power.", "warn");
    await refreshDevices();
    return;
  }
  live = true;
  try {
    if (deviceId === browserDeviceId) activateBrowserPlayback();
    await station.start(deviceId);
  } catch (e) {
    live = false;
    station.events.onLog(e.message, "warn");
    station.events.onStatus("off");
    openDrawer("booth");
  }
}

$("startBtn").onclick = async () => {
  if (live) {
    await station.stop();
    live = false;
    return;
  }
  await powerOn();
};

$("skipBtn").onclick = () => station.skip().catch((e) => station.events.onLog(e.message, "warn"));

$("volume").value = settings.playVolume;
$("volume").onchange = async (e) => {
  settings.playVolume = Number(e.target.value);
  preMuteVolume = null;
  $("muteBtn").textContent = "mute";
  const deviceId = $("deviceSelect").value;
  if (deviceId) {
    try { await spotify.setVolume(deviceId, settings.playVolume); } catch (err) {
      station.events.onLog(`Volume: ${err.message}`, "warn");
    }
  }
};

$("muteBtn").onclick = async () => {
  const deviceId = $("deviceSelect").value;
  if (!deviceId) return;
  try {
    if (preMuteVolume === null) {
      preMuteVolume = Number($("volume").value);
      $("volume").value = 0;
      $("muteBtn").textContent = "unmute";
      await spotify.setVolume(deviceId, 0);
    } else {
      $("volume").value = preMuteVolume;
      await spotify.setVolume(deviceId, preMuteVolume);
      preMuteVolume = null;
      $("muteBtn").textContent = "mute";
    }
  } catch (e) {
    station.events.onLog(e.message, "warn");
  }
};

// ---------- tune-in overlay ----------

async function showTuneOverlayIfIdle() {
  // If Spotify is already audible we're "tuned in" — no gate needed.
  try {
    const state = await spotify.playerState();
    if (state?.is_playing) return;
  } catch {}
  $("tuneOverlay").hidden = false;
}

$("tuneOverlay").onclick = () => {
  $("tuneOverlay").hidden = true;
  if (!live) powerOn();
};

// ---------- waveform, buddy, likes, shortcuts ----------

waveform = createWaveform($("waveform"));
buddy = createBuddy($("buddyMount"));

setInterval(() => {
  if (!lastProgress?.duration) return waveform.setProgress(0);
  const ms = lastProgress.ms + (performance.now() - lastProgress.at);
  waveform.setProgress(ms / lastProgress.duration);
  // Track-position energy envelope: intros ramp in, outros breathe down.
  const intro = Math.min(1, ms / 12000);
  const outro = Math.min(1, (lastProgress.duration - ms) / 15000);
  waveform.setEnergy(Math.max(0.3, Math.min(intro, outro, 1)));
}, 500);

// Heart toggle: tap to save to Liked Songs, tap again to remove.
$("likeBtn").onclick = async () => {
  if (!currentTrackId) return;
  const wasLiked = $("likeBtn").classList.contains("liked");
  $("likeBtn").classList.toggle("liked", !wasLiked); // optimistic
  try {
    if (wasLiked) {
      await spotify.unsaveTrack(currentTrackId);
      station.events.onLog("Removed from your Liked Songs.", "dj");
    } else {
      await spotify.saveTrack(currentTrackId);
      station.events.onLog("Saved to your Liked Songs.", "dj");
    }
  } catch (e) {
    $("likeBtn").classList.toggle("liked", wasLiked); // roll back
    const hint = e.message.includes("403")
      ? "likes need fresh permissions — settings gear, then reconnect spotify"
      : e.message;
    showDJLine(hint, "dj"); // on the main screen, not buried in the booth
    station.events.onLog(hint, "warn");
  }
};

$("djLine").onclick = () => openDrawer("booth");

document.addEventListener("keydown", (e) => {
  const typing = /INPUT|TEXTAREA|SELECT/.test(document.activeElement?.tagName || "");
  if (typing || e.metaKey || e.ctrlKey || e.altKey) return;
  if (e.key === " ") { e.preventDefault(); $("startBtn").click(); }
  else if (e.key === "m") $("muteBtn").click();
  else if (e.key === "ArrowRight" && !$("skipBtn").disabled) $("skipBtn").click();
});

// decorative burst (idle album art)
(() => {
  const g = $("burstRays");
  if (!g) return;
  let rays = "";
  for (let i = 0; i < 24; i++) {
    const a = (i / 24) * Math.PI * 2;
    const x1 = 50 + Math.cos(a) * 18, y1 = 50 + Math.sin(a) * 18;
    const x2 = 50 + Math.cos(a) * 44, y2 = 50 + Math.sin(a) * 44;
    rays += `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="currentColor" stroke-width="3.4"/>`;
  }
  g.innerHTML = rays;
})();

speechSynthesis.onvoiceschanged = () => {};

// ---------- boot ----------

(async () => {
  await handleCallback();
  refreshSetupState();
  if (isLoggedIn()) {
    initBrowserPlayer({
      onReady(deviceId) {
        browserDeviceId = deviceId;
        refreshDevices();
        station.events.onLog("In-tab player ready.");
      },
      onError(message) {
        station.events.onLog(`In-tab player: ${message}`, "warn");
      },
    });
    await refreshDevices();
    await mirrorTick(true);
    await showTuneOverlayIfIdle();
  }
})();
