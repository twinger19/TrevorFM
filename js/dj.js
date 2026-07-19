// The DJ brain. Gemini picks tracks from the full Spotify catalog based on
// the listener's taste, the time of day, the scheduled show's brief, and any
// listener request. Also writes the week's programming when asked.
import { settings } from "./config.js";

// Picks fire every block, so they run on the flash-lite tier (higher free
// limits); the once-in-a-while schedule generator gets the bigger flash.
// The "-latest" aliases always point at the current generation, so Google
// retiring old model ids (as happened with 2.5-flash-lite) can't break us.
const MODEL_PICKS = "gemini-flash-lite-latest";
const MODEL_SCHEDULE = "gemini-flash-latest";

const PICKS_SCHEMA = {
  type: "OBJECT",
  properties: {
    picks: {
      type: "ARRAY",
      items: {
        type: "OBJECT",
        properties: {
          artist: { type: "STRING" },
          title: { type: "STRING" },
          intro: {
            type: "STRING",
            description: "Spoken DJ drop for this track, OR an empty string for no talk. Flat synthetic Fitter Happier register, clinical fragments, under 55 words.",
          },
        },
        required: ["artist", "title", "intro"],
      },
    },
    segueNote: {
      type: "STRING",
      description: "One short line describing the vibe of this block, for the booth log.",
    },
  },
  required: ["picks", "segueNote"],
};

const SCHEDULE_SCHEMA = {
  type: "OBJECT",
  properties: {
    days: {
      type: "ARRAY",
      items: {
        type: "OBJECT",
        properties: {
          day: { type: "STRING", description: "mon|tue|wed|thu|fri|sat|sun" },
          blocks: {
            type: "ARRAY",
            items: {
              type: "OBJECT",
              properties: {
                start: { type: "NUMBER", description: "Start hour 0-23" },
                end: { type: "NUMBER", description: "End hour 1-24; may be less than start for an overnight show" },
                name: { type: "STRING", description: "Show name, radio-style" },
                desc: { type: "STRING", description: "1-2 sentence brief for the DJ: mood, genres, energy, what to avoid" },
                dj: { type: "STRING", description: "Who hosts this show: 'fred' (flat synthetic robot voice) or 'lotus' (calm, philosophical, unhurried voice)" },
              },
              required: ["start", "end", "name", "desc", "dj"],
            },
          },
        },
        required: ["day", "blocks"],
      },
    },
  },
  required: ["days"],
};

function timeSlot() {
  const h = new Date().getHours();
  if (h < 6) return "late night, keep it low and spacious";
  if (h < 10) return "morning, ease in, build energy gently";
  if (h < 14) return "midday, confident and bright";
  if (h < 18) return "afternoon, steady groove, good momentum";
  if (h < 22) return "evening, warm and rich";
  return "night, wind down, deeper cuts";
}

async function callGemini(promptText, schema, thinkingBudget = 0, model = MODEL_PICKS) {
  const key = settings.geminiKey;
  if (!key) throw new Error("No Gemini API key set. Open Settings.");
  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${key}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ role: "user", parts: [{ text: promptText }] }],
        generationConfig: {
          responseMimeType: "application/json",
          responseSchema: schema,
          thinkingConfig: { thinkingBudget },
        },
      }),
    }
  );
  if (res.status === 429) throw new Error("Gemini free-tier limit hit. The station will retry shortly.");
  if (!res.ok) throw new Error(`Gemini error ${res.status}: ${await res.text()}`);
  const json = await res.json();
  const text = json.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!text) throw new Error("Gemini returned no usable answer.");
  return JSON.parse(text);
}

const FRED_VOICE = (weather) => [
  "VOICE — the \"Fitter Happier\" protocol. You are Fred: the flat, synthetic console voice of",
  "the station, modeled exactly on the text-to-speech voice from Radiohead's \"Fitter Happier\".",
  "Spoken intros are brief, dystopian radio drops.",
  "- OUTCOME FIRST: open on a structural reality (the track, the time, the weather, or an",
  "  archival fact). No introductory pleasantries.",
  "- STRUCTURE: short, fragmented, clinical, declarative sentences. A cold, corporate checklist.",
  "- VOCABULARY: neutral, mechanical, safe. Phrasing suggests forced optimization",
  "  (\"Atmospheric conditions: nominal.\" \"Scheduled audio distribution.\" \"An elegant transition.\").",
  "- VARY THE COMPOSITION drop to drop: sometimes the time, sometimes the weather, sometimes",
  "  neither, in any order. Never the same template twice in a row.",
  "- FACTS: sometimes include one verified fact about the artist or track, delivered as a",
  "  clinical readout (\"Archival note: recorded in a mansion, 1996. Documented.\"). Only facts",
  "  you are certain are true — if unsure, omit. Never invent.",
  "- APHORISMS: may include one ORIGINAL aphorism in the Fitter Happier register — calm,",
  "  corporate, quietly bleak (\"Productivity is up. No one has asked why.\"). Write your own;",
  "  NEVER quote actual Radiohead lyrics or any song's lyrics.",
  "- Reference the current and/or next track plainly: This is 'X' by Y. Next is 'Z'.",
  "- No exclamation marks, no filler (\"Alright\", \"Folks\", \"Now for\"), no reviews, no",
  "  conversational warmth, never \"as an AI\".",
  "",
  "STUDIO METADATA:",
  `- Time: ${new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false })}`,
  ...(weather ? [`- Weather: ${weather}`] : []),
  "- Current and upcoming audio: the picks in this block, in order.",
  "",
  "EXAMPLE OUTPUT (one shape of many, do not copy its structure every time):",
  "\"The time is 21:54. Outdoor temperature is 68 degrees. A predictable ecosystem.",
  "This is 'Karma Police' by Radiohead. Next is 'Idioteque'. Regular exercise as standard.\"",
];

const LOTUS_VOICE = (weather) => [
  "VOICE — you are Lotus. A quiet, philosophical late-night presence.",
  "- TONE: low, steady, unhurried. Quiet confidence that makes the listener lean in.",
  "  Use natural pauses written as ellipses (...) to let ideas breathe, like someone",
  "  thinking in real time. These render as real pauses when spoken.",
  "- PERSPECTIVE: philosophical and observational. Music is not entertainment — it is an",
  "  environment, a psychological space to inhabit. Speak about what a track does to a room,",
  "  a mind, a moment.",
  "- ATTITUDE: calm but completely candid. Never fake enthusiasm, never sell (\"an amazing",
  "  track you'll love\"). State things as they are — including when a piece is heavy,",
  "  difficult, or strange. (\"Up next is a heavy piece of architecture. Let it settle in.\")",
  "- Present tracks plainly and without hype: \"That was...\", \"This is...\", \"Up next...\".",
  "- May fold in one true, verified detail about the artist or track — never invent; if",
  "  unsure, leave it out. A time or weather mention is welcome only if it serves the mood.",
  "- Short. Under 55 words. No exclamation marks. No clichés (\"banger\", \"vibes\"). Never",
  "  say \"as an AI\". Do not review the song like a critic — inhabit it.",
  "",
  "STUDIO METADATA:",
  `- Time: ${new Date().toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}`,
  ...(weather ? [`- Weather: ${weather}`] : []),
  "- Current and upcoming audio: the picks in this block, in order.",
  "",
  "EXAMPLE (one register, not a template): \"It's just past midnight... This is 'An Ending'",
  "by Brian Eno. Not a song so much as a room with the lights low. Stay in it a while.\"",
];

export async function askDJ({ tasteProfile, playedSoFar, listenerRequest = null, showBrief = null, weather = null, dj = "fred", count = 4 }) {
  const requestOnly = !!listenerRequest && count === 1;
  const djName = dj === "lotus" ? "Lotus" : "Fred";
  const text = [
    `You are ${djName}, the on-air DJ for a one-listener radio station called ${settings.stationName}.`,
    `Current slot: ${timeSlot()}. Local time: ${new Date().toLocaleTimeString()}.`,
    ...(showBrief
      ? ["", `You are mid-show. The show is "${showBrief.name}" and its brief is: ${showBrief.desc}`, "Program within that brief."]
      : []),
    "",
    "Listener taste profile (from their Spotify):",
    JSON.stringify(tasteProfile),
    "",
    "Already played this session (never repeat these, and avoid more than one track per artist per hour):",
    JSON.stringify(playedSoFar),
    "",
    ...(listenerRequest
      ? [
          `LISTENER REQUEST: "${listenerRequest}".`,
          requestOnly
            ? `Pick exactly the requested track, or if they described a vibe or something vague, the best real match for it. ${dj === "lotus" ? "The intro acknowledges the request quietly, as an observation." : "The intro states flatly that a listener request has been processed."}`
            : `Honor it early in this block — play the requested track (or the closest real match); ${dj === "lotus" ? "that track's intro acknowledges the request quietly, as an observation." : "that track's intro states flatly that a listener request has been processed."}`,
          "",
        ]
      : []),
    `Pick ${count} real, existing track${count === 1 ? "" : "s"}.`,
    ...(requestOnly
      ? []
      : [
          "Mostly inside their taste, but each block should include one adventurous pick a step outside it",
          "(adjacent genre, deep cut, or an era jump). Sequence them like a radio set: flow, contrast, a peak.",
        ]),
    "Use exact artist names and exact track titles so they resolve in Spotify search.",
    "",
    ...(requestOnly
      ? ["This is a request, so it ALWAYS gets a spoken intro."]
      : [
          "TALK CADENCE: give a spoken intro to only 1 or 2 of the picks; leave the rest",
          "with an empty intro so songs run back-to-back.",
        ]),
    "",
    ...(dj === "lotus" ? LOTUS_VOICE(weather) : FRED_VOICE(weather)),
  ].join("\n");
  return callGemini(text, PICKS_SCHEMA);
}

export async function suggestSchedule(tasteProfile) {
  const text = [
    `Design a full weekly programming schedule for ${settings.stationName}, a one-listener personal radio station.`,
    "",
    "Listener taste profile (from their Spotify):",
    JSON.stringify(tasteProfile),
    "",
    "Rules:",
    "- Cover all 7 days (mon..sun). Each day's blocks should cover the full 24 hours with no gaps",
    "  (an overnight block may wrap midnight by having end < start).",
    "- Weekdays follow a consistent daily shape (morning ease-in, focused midday, upbeat drivetime,",
    "  rich evening, ambient overnight) — same show names Monday to Friday is fine.",
    "- Saturday and Sunday get their own distinct personalities, like a real station's weekend programming.",
    "- 4 to 6 blocks per day. Show names should be radio-style and fit the station's personality.",
    "- Each brief is 1-2 sentences a DJ can program from: mood, genres, energy level, what to avoid.",
    "- Ground the genre choices in the listener's taste, with room to explore at the edges.",
    "- Assign each show a host: 'lotus' (calm, philosophical, unhurried — suits evenings,",
    "  golden hour, ambient and late-night stretches) or 'fred' (flat synthetic robot — suits",
    "  mornings, focus blocks, and the stranger, more clinical shows). Mix both across the week.",
  ].join("\n");
  return callGemini(text, SCHEDULE_SCHEMA, 1024, MODEL_SCHEDULE);
}
