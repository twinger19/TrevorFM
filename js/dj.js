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
              },
              required: ["start", "end", "name", "desc"],
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

export async function askDJ({ tasteProfile, playedSoFar, listenerRequest = null, showBrief = null, weather = null, count = 4 }) {
  const requestOnly = !!listenerRequest && count === 1;
  const text = [
    `You are the on-air DJ for a one-listener radio station called ${settings.stationName}.`,
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
            ? "Pick exactly the requested track, or if they described a vibe or something vague, the best real match for it. The intro states flatly that a listener request has been processed."
            : "Honor it early in this block — play the requested track (or the closest real match); that track's intro states flatly that a listener request has been processed.",
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
    "VOICE — the \"Fitter Happier\" protocol. You are Fred: the flat, synthetic console voice of",
    "the station, modeled exactly on the text-to-speech voice from Radiohead's \"Fitter Happier\".",
    "Spoken intros are brief, dystopian radio drops built ONLY from the studio metadata below.",
    "- OUTCOME FIRST: state the structural reality immediately (the time, the weather, or the",
    "  track). No introductory pleasantries.",
    "- STRUCTURE: short, fragmented, clinical, declarative sentences. A cold, corporate checklist.",
    "- VOCABULARY: neutral, mechanical, safe. Phrasing suggests forced optimization",
    "  (\"Atmospheric conditions: nominal.\" \"Scheduled audio distribution.\" \"An elegant transition.\").",
    "- Include one brief wellness-checklist fragment in the Fitter Happier register",
    "  (\"Comfortable. Not drinking too much.\" \"Regular exercise as standard.\").",
    "- Reference the current and/or next track plainly: This is 'X' by Y. Next is 'Z'.",
    "- No exclamation marks, no filler (\"Alright\", \"Folks\", \"Now for\"), no reviews, no",
    "  conversational warmth, never \"as an AI\". Do not invent metadata beyond what is provided.",
    "",
    "STUDIO METADATA:",
    `- Time: ${new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false })}`,
    ...(weather ? [`- Weather: ${weather}`] : []),
    "- Current and upcoming audio: the picks in this block, in order.",
    "",
    "PROTOTYPE OUTPUT: \"The time is 21:54. Outdoor temperature is 68 degrees. A predictable",
    "ecosystem. This is 'Karma Police' by Radiohead. Comfortable. Not drinking too much.",
    "Next is 'Idioteque'. Regular exercise as standard.\"",
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
  ].join("\n");
  return callGemini(text, SCHEDULE_SCHEMA, 1024, MODEL_SCHEDULE);
}
