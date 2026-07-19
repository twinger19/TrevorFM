// The station loop: build a taste profile, let the DJ program blocks of tracks,
// queue them on the Spotify device, and announce each one as it starts.
import { spotify } from "./spotify.js";
import { askDJ } from "./dj.js";
import { announceOverMusic, talkThenStart, estimateSpeechSeconds } from "./voice.js";
import { settings } from "./config.js";
import { effectiveBlock, currentDJ } from "./schedule.js";

const POLL_MS = 4000;
const TOPUP_WHEN_REMAINING = 2;
const BLOCK_SIZE = 4;

export class Station {
  constructor(events) {
    this.events = events; // { onNowPlaying, onUpNext, onLog, onStatus }
    this.deviceId = null;
    this.tasteProfile = null;
    this.playedTitles = [];   // "Artist – Title" strings for the DJ's memory
    this.introByUri = new Map();
    this.upNext = [];         // resolved tracks not yet heard
    this.lastUri = null;
    this.timer = null;
    this.running = false;
    this.busy = false;
    this.weatherText = null; // set from outside; passed to the DJ
    this.pendingPlayNext = null; // a request that cuts in at the next song boundary
    this.announcing = false;
  }

  // A request works whether or not the station is live: the DJ finds the
  // track (or best match for a described vibe) right away. Live -> it joins
  // the queue with an on-air acknowledgement; off air -> it just plays.
  async fulfillRequest(text, fallbackDeviceId) {
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
    if (!tracks.length) throw new Error("Fred couldn't find a match for that. Try different words?");
    const track = tracks[0];
    const deviceId = this.deviceId || fallbackDeviceId;
    if (!deviceId) throw new Error("Pick a playback device first.");
    if (this.running) {
      // Not queued via Spotify (that would land behind the block) — the tick
      // loop cuts to it when the current song ends.
      this.pendingPlayNext = track;
      this.upNext = this.upNext.filter((t) => t.uri !== track.uri);
      this.upNext.unshift(track);
      this.events.onUpNext(this.upNext);
      this.log(`Coming up next: ${trackLabel(track)}`, "dj");
      return { track, when: "next" };
    }
    await spotify.play(deviceId, [track.uri]);
    this.log(`Playing your request: ${trackLabel(track)}`, "dj");
    const intro = this.introByUri.get(track.uri);
    if (intro) {
      this.introByUri.delete(track.uri);
      this.events.onDJLine?.(intro, "voice");
      announceOverMusic(deviceId, intro, currentDJ());
    }
    return { track, when: "now" };
  }

  log(text, kind = "info") {
    this.events.onLog(text, kind);
  }

  async buildTasteProfile() {
    const [artists, tracks, recent] = await Promise.all([
      spotify.topArtists("medium_term", 20),
      spotify.topTracks("short_term", 15),
      spotify.recentlyPlayed(20),
    ]);
    const genres = [...new Set(artists.flatMap((a) => a.genres))].slice(0, 15);
    return {
      top_artists: artists.map((a) => a.name),
      genres,
      recent_favorites: tracks.map((t) => `${t.artists[0].name} – ${t.name}`),
      played_last_days: [...new Set(recent.map((r) => `${r.track.artists[0].name} – ${r.track.name}`))],
    };
  }

  async resolvePicks(picks) {
    const resolved = [];
    for (const pick of picks) {
      try {
        const track = await spotify.searchTrack(`track:${pick.title} artist:${pick.artist}`)
          || await spotify.searchTrack(`${pick.title} ${pick.artist}`);
        if (track) {
          if (pick.intro?.trim()) this.introByUri.set(track.uri, pick.intro.trim());
          resolved.push(track);
        } else {
          this.log(`Couldn't find "${pick.artist} – ${pick.title}", skipping.`, "warn");
        }
      } catch (e) {
        this.log(`Search failed for "${pick.title}": ${e.message}`, "warn");
      }
    }
    return resolved;
  }

  async programBlock(count) {
    this.events.onDJLine?.("programming the next block…", "dj");
    const { picks, segueNote } = await askDJ({
      tasteProfile: this.tasteProfile,
      playedSoFar: this.playedTitles.concat(this.upNext.map(trackLabel)),
      showBrief: effectiveBlock(),
      weather: this.weatherText,
      dj: currentDJ(),
      count,
    });
    this.log(`DJ: ${segueNote}`, "dj");
    this.events.onDJLine?.(segueNote, "dj");
    return this.resolvePicks(picks);
  }

  async start(deviceId) {
    this.deviceId = deviceId;
    this.running = true;
    this.events.onStatus("tuning");
    this.log("Reading your Spotify taste profile…");
    this.tasteProfile = await this.buildTasteProfile();
    this.log(`Profile ready: ${this.tasteProfile.top_artists.slice(0, 5).join(", ")}…`);

    this.log("DJ is programming the opening block…");
    const tracks = await this.programBlock(BLOCK_SIZE);
    if (!tracks.length) throw new Error("The DJ couldn't program an opening block. Check the Gemini key in Settings.");

    await spotify.play(this.deviceId, [tracks[0].uri]);
    try { await spotify.setVolume(this.deviceId, settings.playVolume); } catch {}
    for (const t of tracks.slice(1)) await spotify.queue(this.deviceId, t.uri);
    this.upNext = tracks;
    this.events.onStatus("onair");
    this.timer = setInterval(() => this.tick().catch((e) => this.log(e.message, "warn")), POLL_MS);
  }

  // Switch to a just-selected instant block: drop the queued schedule tracks
  // and program a fresh block from the mood, playing its first track now so
  // the change is immediate. (The instant block is already set in schedule.js;
  // programBlock reads it via effectiveBlock.)
  async applyInstant(label) {
    if (!this.running) return;
    this.log(`Switching to ${label}…`, "dj");
    this.events.onDJLine?.(`switching to ${label.toLowerCase()}…`, "dj");
    this.introByUri.clear();
    this.pendingPlayNext = null;
    const tracks = await this.programBlock(BLOCK_SIZE);
    if (!tracks.length) { this.log("Couldn't program that mood — try again.", "warn"); return; }
    await spotify.play(this.deviceId, [tracks[0].uri]);
    for (const t of tracks.slice(1)) await spotify.queue(this.deviceId, t.uri);
    this.upNext = tracks;
    this.events.onUpNext(this.upNext);
  }

  async tick() {
    if (!this.running || this.busy) return;
    this.busy = true;
    try {
      const state = await spotify.playerState();
      const item = state?.item;
      if (!item) return;

      if (item.uri !== this.lastUri) {
        this.lastUri = item.uri;
        this.playedTitles.push(trackLabel(item));
        this.upNext = this.upNext.filter((t) => t.uri !== item.uri);
        this.events.onNowPlaying(item);
        this.events.onUpNext(this.upNext);

        // Catch-up path only: intros normally get spoken over the PREVIOUS
        // track's outro (below) and are consumed there.
        const intro = this.introByUri.get(item.uri);
        if (intro && !this.announcing) {
          this.introByUri.delete(item.uri);
          this.events.onDJLine?.(intro, "voice");
          this.log(`On air: "${intro}"`, "dj");
          await announceOverMusic(this.deviceId, intro, currentDJ());
        }
      }

      this.events.onProgress?.(state.progress_ms ?? 0, item.duration_ms ?? 0, this.upNext[0] || null);
      this.maybeTalkUp(state, item);

      if (this.upNext.length <= TOPUP_WHEN_REMAINING) {
        this.log("DJ is programming the next block…");
        const tracks = await this.programBlock(BLOCK_SIZE);
        for (const t of tracks) await spotify.queue(this.deviceId, t.uri);
        this.upNext.push(...tracks);
        this.events.onUpNext(this.upNext);
      }
    } finally {
      this.busy = false;
    }
  }

  // The real-radio transition: as the current song runs out, Fred talks over
  // its outro and the next track fires under his final words. Requests
  // (pendingPlayNext) take priority over the queued block; without an intro
  // they still cut in right at the boundary.
  maybeTalkUp(state, item) {
    if (this.announcing) return;
    const remainingMs = (item.duration_ms ?? 0) - (state.progress_ms ?? 0);
    if (remainingMs <= 0) return;
    const nextUp = this.pendingPlayNext || this.upNext.find((t) => t.uri !== item.uri);
    if (!nextUp) return;
    const intro = this.introByUri.get(nextUp.uri);

    if (intro) {
      const speechMs = (estimateSpeechSeconds(intro) + 1.2) * 1000;
      if (remainingMs > speechMs + POLL_MS + 1000) return; // not yet
      this.announcing = true;
      this.introByUri.delete(nextUp.uri);
      this.events.onDJLine?.(intro, "voice");
      this.log(`On air: "${intro}"`, "dj");
      talkThenStart(this.deviceId, intro, () => {
        spotify.play(this.deviceId, [nextUp.uri]).catch(() => {});
        if (this.pendingPlayNext?.uri === nextUp.uri) this.pendingPlayNext = null;
      }, currentDJ()).finally(() => { this.announcing = false; });
    } else if (this.pendingPlayNext && remainingMs < POLL_MS + 1000) {
      const target = this.pendingPlayNext;
      this.pendingPlayNext = null;
      setTimeout(
        () => spotify.play(this.deviceId, [target.uri]).catch(() => {}),
        Math.max(0, remainingMs - 400)
      );
    }
  }

  async stop() {
    this.running = false;
    this.pendingPlayNext = null;
    clearInterval(this.timer);
    speechSynthesis.cancel();
    try { await spotify.pause(this.deviceId); } catch {}
    this.events.onStatus("off");
    this.log("Station off air.");
  }

  async skip() {
    await spotify.next(this.deviceId);
  }
}

function trackLabel(track) {
  const artist = track.artists?.[0]?.name || "Unknown";
  return `${artist} – ${track.name}`;
}
