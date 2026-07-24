// The program-director console: edit the week's grid, keep it synced with
// the iOS app via the Cloudflare Worker. No playback, no Spotify, no DJ —
// the station itself lives on the phone now.
import { settings } from "./config.js";
import {
  DAYS, DAY_LABELS, DJS, DJ_LABELS,
  loadSchedule, saveSchedule, resetSchedule, setOnScheduleSaved,
  currentBlock, dayKey, fmtHour,
} from "./schedule.js";
import { pullSchedule, pushSchedule, testSync } from "./sync.js";

const $ = (id) => document.getElementById(id);

let week = loadSchedule();
let day = dayKey();
let editingIndex = null; // index into week[day], or null

// Every local save publishes to the cloud.
setOnScheduleSaved(() => {
  pushSchedule().then((ok) => showSyncLine(ok ? "pushed" : "push failed"));
});

// MARK: header

function renderHeader() {
  $("stationName").textContent = settings.stationName;
  const now = currentBlock(week);
  $("showNow").innerHTML = now ? `▸ <b>${escapeHTML(now.name)}</b> on now` : "";
}

// MARK: day tabs

function renderTabs() {
  $("dayTabs").innerHTML = DAYS.map((d) =>
    `<button data-day="${d}" class="${d === day ? "active" : ""}">${DAY_LABELS[d]}</button>`
  ).join("");
  for (const btn of $("dayTabs").querySelectorAll("button")) {
    btn.onclick = () => { day = btn.dataset.day; editingIndex = null; render(); };
  }
}

// MARK: block list + editor

function sortedBlocks() {
  return (week[day] || []).slice().sort((a, b) => a.start - b.start);
}

function renderBlocks() {
  const list = $("blockList");
  list.innerHTML = "";
  const now = currentBlock(week);
  const isToday = day === dayKey();

  sortedBlocks().forEach((block) => {
    const index = week[day].indexOf(block);
    if (index === editingIndex) {
      list.appendChild(editorEl(block, index));
      return;
    }
    const row = document.createElement("div");
    row.className = "block-row";
    row.innerHTML = `
      <div class="rowtop">
        <span>${fmtHour(block.start)}–${fmtHour(block.end)} · ${DJ_LABELS[block.dj] || "Fred"}</span>
        ${isToday && block === now ? '<span class="onnow">● ON NOW</span>' : ""}
      </div>
      <h3>${escapeHTML(block.name)}</h3>
      <p>${escapeHTML(block.desc || "")}</p>`;
    row.onclick = () => { editingIndex = index; render(); };
    list.appendChild(row);
  });

  if (!sortedBlocks().length) {
    list.innerHTML = '<p class="console-sub">No shows this day yet — add one.</p>';
  }
}

function editorEl(block, index) {
  const el = document.createElement("div");
  el.className = "block-editor";
  const hourOptions = (from, to, sel) =>
    Array.from({ length: to - from + 1 }, (_, i) => from + i)
      .map((h) => `<option value="${h}" ${h === sel ? "selected" : ""}>${fmtHour(h)}</option>`).join("");
  el.innerHTML = `
    <label>Show name <input type="text" id="edName" value="${escapeAttr(block.name)}" /></label>
    <div class="editor-grid">
      <label>From <select id="edStart">${hourOptions(0, 23, block.start)}</select></label>
      <label>To <select id="edEnd">${hourOptions(1, 24, block.end)}</select></label>
      <label>Host <select id="edDJ">${DJS.map((d) => `<option value="${d}" ${d === block.dj ? "selected" : ""}>${DJ_LABELS[d]}</option>`).join("")}</select></label>
    </div>
    <label>Brief for the host <textarea id="edDesc">${escapeHTML(block.desc || "")}</textarea></label>
    <div class="editor-actions">
      <button class="text-btn danger" id="edDelete">Delete</button>
      <span class="grow"></span>
      <button class="text-btn" id="edCancel">Cancel</button>
      <button class="solid" id="edSave">Save</button>
    </div>
    <p class="fine" id="edWrapNote"></p>`;

  const note = () => {
    const s = Number(el.querySelector("#edStart").value);
    const e = Number(el.querySelector("#edEnd").value);
    el.querySelector("#edWrapNote").textContent = e <= s ? "Overnight — wraps past midnight." : "";
  };
  el.querySelector("#edStart").onchange = note;
  el.querySelector("#edEnd").onchange = note;
  note();

  el.querySelector("#edSave").onclick = () => {
    const b = week[day][index];
    b.name = el.querySelector("#edName").value.trim() || "Untitled Show";
    b.desc = el.querySelector("#edDesc").value.trim();
    b.start = Number(el.querySelector("#edStart").value);
    b.end = Number(el.querySelector("#edEnd").value);
    b.dj = el.querySelector("#edDJ").value;
    editingIndex = null;
    saveSchedule(week);
    render();
  };
  el.querySelector("#edCancel").onclick = () => { editingIndex = null; render(); };
  el.querySelector("#edDelete").onclick = () => {
    week[day].splice(index, 1);
    editingIndex = null;
    saveSchedule(week);
    render();
  };
  return el;
}

$("addShowBtn").onclick = () => {
  week[day] = week[day] || [];
  week[day].push({ start: 12, end: 14, name: "New Show", desc: "", dj: "fred" });
  editingIndex = week[day].length - 1;
  saveSchedule(week);
  render();
};

$("resetBtn").onclick = () => {
  if (!confirm("Reset the whole week to defaults?")) return;
  week = resetSchedule();
  editingIndex = null;
  render();
};

// MARK: sync status + periodic pull (adopt edits made on the phone)

function showSyncLine(state) {
  const line = $("syncLine");
  if (!settings.syncUrl || !settings.syncSecret) {
    line.innerHTML = "sync: not configured — open Settings.";
    return;
  }
  const stamp = new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  const cls = state.includes("fail") ? "bad" : "ok";
  line.innerHTML = `sync: <span class="${cls}">${state}</span> · ${stamp}`;
}

async function pull() {
  const result = await pullSchedule();
  if (result === "adopted") {
    week = loadSchedule();
    editingIndex = null;
    render();
    showSyncLine("adopted newer schedule");
  } else if (result === "current") {
    showSyncLine("up to date");
  } else if (result === null && settings.syncUrl) {
    showSyncLine("pull failed");
  }
}

// MARK: settings dialog

$("settingsBtn").onclick = () => {
  $("setStationName").value = settings.stationName;
  $("setSyncUrl").value = settings.syncUrl;
  $("setSyncSecret").value = settings.syncSecret;
  $("syncStatus").hidden = true;
  $("settingsDialog").showModal();
};

$("saveSettingsBtn").onclick = () => {
  settings.stationName = $("setStationName").value;
  settings.syncUrl = $("setSyncUrl").value;
  settings.syncSecret = $("setSyncSecret").value;
  $("settingsDialog").close();
  renderHeader();
  pull();
};

$("testSyncBtn").onclick = async () => {
  settings.syncUrl = $("setSyncUrl").value;
  settings.syncSecret = $("setSyncSecret").value;
  const status = $("syncStatus");
  status.hidden = false;
  status.textContent = "testing…";
  status.textContent = await testSync();
};

// MARK: utilities

function escapeHTML(s) {
  return String(s).replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
function escapeAttr(s) { return escapeHTML(s); }

function render() {
  renderHeader();
  renderTabs();
  renderBlocks();
}

// MARK: boot

render();
pull();
setInterval(pull, 60_000);      // adopt phone-side edits while the tab sits open
setInterval(renderHeader, 60_000); // roll the "on now" chip at block boundaries
