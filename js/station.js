// The station loop: build a taste profile, let the DJ program blocks, hand
// them to Apple Music in order, and announce them on air.
//
// The queue IS the plan. MusicKit plays what we set, in order, so there's
// nothing to drift — we just keep it topped up before it can run dry.
import { music } from "./musickit.js";
import { askDJ } from "./dj.js";
import { announceOverMusic, talkThenStart, estimateSpeechSeconds, prefetchLine } from "./voice.js";
import { effectiveBlock, currentDJ } from "./schedule.js";
import { findDJ } from "./djs.js";
import { tasteProfile, recordPlay, recordBan, recordLike } from "./taste.js";

const POLL_MS = 1000;      // local state, no network — cheap to poll often
const TOPUP_WHEN_REMAINING = 4;
const BLOCK_SIZE = 12;

// Persistent 24h play history so nothing repeats within a day.
const HISTORY_KEY = "tfm_history";
const DAY_MS = 24 * 60 * 60 * 1000;

function loadHistory() {
  try {
    const cutoff = Date.now() - DAY_MS;
    return (JSON.parse(localStorage.getItem(HISTORY_KEY)) || []).filter((h) => h.at > cutoff);
  } catch {
    return [];
  }
}
function recordHistory(uri, label) {
  const arr = loadHistory();
  if (arr.length && arr[arr.length - 1].uri === uri) return;
  arr.push({ uri, label, at: Date.now() });
  localStorage.setItem(HISTORY_KEY, JSON.stringify(arr));
}
const recentUris = () => new Set(loadHistory().map((h) => h.uri));
const recentLabels = (cap = 60) => loadHistory().slice(-cap).map((h) => h.label);

export class Station {
  constructor(events) {
    this.events = events;
    this.tasteProfile = null;
    this.playedTitles = [];
    this.introByUri = new Map();
    this.upNext = [];
    this.lastUri = null;
    this.timer = null;
    this.running = false;
    this.busy = false;
    this.weatherText = null;
    this.pendingPlayNext = null;
    this.announcing = false;
    this.announcingSince = 0;
    this.currentShowName = null;
  }

  log(text, kind = "info") { this.events.onLog(text, kind); }

  async buildTasteProfile() {
    const recent = await music.recentlyPlayed(30);
    const profile = tasteProfile(recent);
    profile.played_last_days = recentLabels(30);
    return profile;
  }

  async resolvePicks(picks, { skipRecent = false } = {}) {
    const recent = skipRecent ? recentUris() : null;
    // A few at a time: fast enough for a 12-track block, gentle on the API.
    const out = new Array(picks.length).fill(null);
    let cursor = 0;
    const worker = async () => {
      while (cursor < picks.length) {
        const i = cursor++;
        const pick = picks[i];
        try {
          out[i] = await music.searchTrack(`${pick.title} ${pick.artist}`);
        } catch (e) {
          this.log(`Search failed for "${pick.title}": ${e.message}`, "warn");
        }
      }
    };
    await Promise.all([worker(), worker(), worker()]);

    const resolved = [];
    picks.forEach((pick, i) => {
      const track = out[i];
      if (!track) {
        this.log(`Couldn't find "${pick.artist} – ${pick.title}", skipping.`, "warn");
        return;
      }
      if (recent && recent.has(track.uri)) {
        this.log(`Skipped "${trackLabel(track)}" — played in the last 24h.`, "dj");
        return;
      }
      if (pick.intro?.trim()) this.introByUri.set(track.uri, pick.intro.trim());
      resolved.push(track);
    });

    // Warm a network voice's lines while the music is still playing.
    const host = findDJ(currentDJ());
    if (host.voice.kind === "eleven") {
      for (const t of resolved) {
        const intro = this.introByUri.get(t.uri);
        if (intro) prefetchLine(intro, host.id);
      }
    }
    // Drop intros for tracks that left the plan, so the map can't grow forever.
    const keep = new Set([...resolved, ...this.upNext].map((t) => t.uri));
    for (const uri of [...this.introByUri.keys()]) {
      if (!keep.has(uri)) this.introByUri.delete(uri);
    }
    return resolved;
  }

  async programBlock(count) {
    this.events.onDJLine?.("programming the next block…", "dj");
    const show = effectiveBlock();
    let announceShow = null;
    if (show && show.name !== this.currentShowName) {
      announceShow = { name: show.name, desc: show.desc };
      this.currentShowName = show.name;
    }
    const { picks, segueNote } = await askDJ({
      tasteProfile: this.tasteProfile || {},
      playedSoFar: [...new Set([...recentLabels(), ...this.playedTitles, ...this.upNext.map(trackLabel)])],
      showBrief: show,
      weather: this.weatherText,
      dj: currentDJ(),
      announceShow,
      count,
    });
    this.log(`DJ: ${segueNote}`, "dj");
    this.events.onDJLine?.(segueNote, "dj");
    return this.resolvePicks(picks, { skipRecent: true });
  }

  async start() {
    this.running = true;
    this.events.onStatus("tuning");
    this.log("Reading your Apple Music taste…");
    this.tasteProfile = await this.buildTasteProfile();
    if (this.tasteProfile.top_artists.length) {
      this.log(`Profile ready: ${this.tasteProfile.top_artists.slice(0, 5).join(", ")}…`);
    } else {
      this.log("No listening history yet — programming from the show brief alone.");
    }

    this.log("The DJ is programming the opening block…");
    const tracks = await this.programBlock(BLOCK_SIZE);
    if (!tracks.length) throw new Error("Couldn't program an opening block. Check the Gemini key in Settings.");

    await music.playSongs(tracks.map((t) => t.uri));
    this.upNext = tracks;
    this.events.onUpNext(this.upNext);
    this.events.onStatus("onair");
    this.timer = setInterval(() => this.tick().catch((e) => this.log(e.message, "warn")), POLL_MS);
  }

  async applyInstant(label) {
    if (!this.running) return;
    this.log(`Switching to ${label}…`, "dj");
    this.events.onDJLine?.(`switching to ${label.toLowerCase()}…`, "dj");
    this.introByUri.clear();
    this.pendingPlayNext = null;
    this.currentShowName = null; // force the new mood to be announced
    const tracks = await this.programBlock(BLOCK_SIZE);
    if (!tracks.length) { this.log("Couldn't program that mood — try again.", "warn"); return; }
    await music.playSongs(tracks.map((t) => t.uri));
    this.upNext = tracks;
    this.events.onUpNext(this.upNext);
  }

  async fulfillRequest(text) {
    this.log(`Request in: "${text}"`, "dj");
    this.events.onDJLine?.("digging through the stacks…", "dj");
    if (!this.tasteProfile) {
      try { this.tasteProfile = await this.buildTasteProfile(); } catch {}
    }
    const { picks } = await askDJ({
      tasteProfile: this.tasteProfile || {},
      playedSoFar: this.playedTitles,
      listenerRequest: text,
      weather: this.weatherText,
      dj: currentDJ(),
      count: 1,
    });
    const tracks = await this.resolvePicks(picks);
    if (!tracks.length) throw new Error("Couldn't find a match for that. Try different words?");
    const track = tracks[0];

    if (this.running) {
      // Slot it straight after the current song; it arrives at the next
      // boundary through normal ordered playback.
      await music.appendSongs([track.uri], { next: true });
      this.pendingPlayNext = track;
      this.upNext = this.upNext.filter((t) => t.uri !== track.uri);
      this.upNext.unshift(track);
      this.events.onUpNext(this.upNext);
      this.log(`Coming up next: ${trackLabel(track)}`, "dj");
      return { track, when: "next" };
    }

    await music.playSongs([track.uri]);
    this.log(`Playing your request: ${trackLabel(track)}`, "dj");
    const intro = this.introByUri.get(track.uri);
    if (intro) {
      this.introByUri.delete(track.uri);
      this.events.onDJLine?.(intro, "voice");
      announceOverMusic(intro, currentDJ());
    }
    return { track, when: "now" };
  }

  async tick() {
    if (!this.running || this.busy) return;
    this.busy = true;
    try {
      const item = music.nowPlaying();
      if (!item) return;

      if (item.uri !== this.lastUri) {
        this.lastUri = item.uri;
        if (this.pendingPlayNext?.uri === item.uri) this.pendingPlayNext = null;
        const label = trackLabel(item);
        this.playedTitles.push(label);
        if (this.playedTitles.length > 100) this.playedTitles.splice(0, this.playedTitles.length - 100);
        recordHistory(item.uri, label);
        recordPlay(item.artist, null);
        this.upNext = this.upNext.filter((t) => t.uri !== item.uri);
        this.events.onNowPlaying(item);
        this.events.onUpNext(this.upNext);

        // Catch-up path: normally the intro is spoken over the previous outro.
        const intro = this.introByUri.get(item.uri);
        if (intro && !this.announcing) {
          this.introByUri.delete(item.uri);
          this.events.onDJLine?.(intro, "voice");
          this.log(`On air: "${intro}"`, "dj");
          announceOverMusic(intro, currentDJ());
        }
      }

      this.events.onProgress?.(music.progressMs(), music.durationMs() || item.durationMs * 1000, this.upNext[0] || null);

      // Watchdog: never let a lost callback mute the DJ for the session.
      if (this.announcing && Date.now() - this.announcingSince > 90000) {
        this.announcing = false;
        this.log("Talk-up watchdog: an announcement never reported finishing — reset.", "warn");
      }

      this.maybeTalkUp(item);

      if (this.upNext.length <= TOPUP_WHEN_REMAINING) {
        const tracks = await this.programBlock(4);
        if (tracks.length) {
          await music.appendSongs(tracks.map((t) => t.uri));
          this.upNext.push(...tracks);
          this.events.onUpNext(this.upNext);
        }
      }
    } finally {
      this.busy = false;
    }
  }

  // Hit the post: the DJ talks over the outro and the next track starts
  // under the last words. Everything is already queued in order, so the
  // transition is a plain skip.
  maybeTalkUp(item) {
    if (this.announcing) return;
    const duration = music.durationMs() || item.durationMs * 1000;
    const remainingMs = duration - music.progressMs();
    if (remainingMs <= 0) return;
    const nextUp = this.upNext.find((t) => t.uri !== item.uri);
    if (!nextUp) return;
    const intro = this.introByUri.get(nextUp.uri);
    if (!intro) return;

    const speechMs = (estimateSpeechSeconds(intro) + 1.2) * 1000;
    if (remainingMs > speechMs + 4000) return; // not yet

    this.announcing = true;
    this.announcingSince = Date.now();
    this.introByUri.delete(nextUp.uri);
    this.events.onDJLine?.(intro, "voice");
    this.log(`On air: "${intro}"`, "dj");
    talkThenStart(intro, () => {
      if (music.nowPlaying()?.uri === item.uri) music.skipNext().catch(() => {});
    }, currentDJ()).finally(() => { this.announcing = false; });
  }

  // The listener's verdicts.
  async love() {
    const item = music.nowPlaying();
    if (!item) return "No track playing.";
    recordLike(trackLabel(item));
    try { await music.rate(item.id, 1); } catch {}
    try { await music.addToLibrary(item.id); } catch {
      return "Loved ♥ — to also save it, turn on Sync Library in Apple Music.";
    }
    return "Saved and loved ♥";
  }

  async ban() {
    const item = music.nowPlaying();
    if (!item) return "No track playing.";
    recordBan(trackLabel(item), item.artist);
    try { await music.rate(item.id, -1); } catch {}
    await music.skipNext().catch(() => {});
    return "Noted — that one won't come back.";
  }

  async stop() {
    this.running = false;
    this.pendingPlayNext = null;
    clearInterval(this.timer);
    speechSynthesis.cancel();
    try { await music.pause(); } catch {}
    this.events.onStatus("off");
    this.log("Station off air.");
  }

  async skip() { await music.skipNext(); }
}

function trackLabel(track) {
  const artist = track.artist || track.artists?.[0]?.name || "Unknown";
  return `${artist} – ${track.name}`;
}
