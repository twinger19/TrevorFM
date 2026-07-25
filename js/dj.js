// The DJ brain. Gemini picks tracks from the full Apple Music catalog based on
// the listener's taste, the time of day, the scheduled show's brief, and any
// listener request. Also writes the week's programming when asked.
import { settings } from "./config.js";
import { findDJ, DJS } from "./djs.js";
import { bannedTracks, bannedArtists } from "./taste.js";

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
            description: "Spoken DJ drop for this track, in the host's own voice per the VOICE section, OR an empty string for no talk. Under 55 words.",
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
                dj: { type: "STRING", description: "Who hosts this show — one of: " + DJS.map((d) => `'${d.id}'`).join(", ") },
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
  const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;
  const body = {
    contents: [{ role: "user", parts: [{ text: promptText }] }],
    generationConfig: {
      responseMimeType: "application/json",
      responseSchema: schema,
      thinkingConfig: { thinkingBudget },
    },
  };

  const send = (payload) =>
    fetch(endpoint, {
      method: "POST",
      // Key in a header, not the URL — query strings end up in logs.
      headers: { "Content-Type": "application/json", "x-goog-api-key": key },
      body: JSON.stringify(payload),
    });

  let res = await send(body);
  // The "-latest" model alias drifts onto newer models that sometimes reject
  // thinkingConfig; if that tripped a 400, drop it and retry once (same fix
  // as the iOS app already carries).
  if (res.status === 400 && body.generationConfig.thinkingConfig) {
    delete body.generationConfig.thinkingConfig;
    res = await send(body);
  }
  if (res.status === 429) throw new Error("Gemini free-tier limit hit. The station will retry shortly.");
  if (!res.ok) throw new Error(`Gemini error ${res.status}: ${await res.text()}`);
  const json = await res.json();
  const text = json.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!text) throw new Error("Gemini returned no usable answer.");
  return JSON.parse(text);
}

export async function askDJ({ tasteProfile, playedSoFar, listenerRequest = null, showBrief = null, weather = null, dj = "fred", announceShow = null, count = 4 }) {
  const requestOnly = !!listenerRequest && count === 1;
  const host = findDJ(dj);
  const djName = host.name;
  const clock = new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false });
  // Weather is stated on air ONLY when we actually know it. An invented
  // temperature delivered in a confident voice is still a lie.
  const weatherLine = weather
    ? `- Weather and light right now, verified: ${weather}\n` +
      "  (The fall of light is often better on-air colour than the temperature. Use at most one\n" +
      "  of these per drop, and only when it earns its place.)"
    : "- Weather: UNKNOWN. Never mention weather, temperature, sky conditions, or the sun.";
  const bans = bannedTracks();
  const banArtists = bannedArtists();
  const text = [
    `You are ${djName}, the on-air DJ for a one-listener radio station called ${settings.stationName}.`,
    `Current slot: ${timeSlot()}. Local time: ${new Date().toLocaleTimeString()}.`,
    ...(showBrief
      ? ["", `You are mid-show. The show is "${showBrief.name}" and its brief is: ${showBrief.desc}`, "Program within that brief."]
      : []),
    "",
    "Listener taste profile (from their listening history) — this is a STARTING POINT, not a playlist to echo:",
    JSON.stringify(tasteProfile),
    "",
    "Recently played (never repeat any of these; also avoid more than one track per artist per hour):",
    JSON.stringify(playedSoFar),
    "",
    ...(bans.length
      ? ["REJECTED BY THE LISTENER — never play these tracks again, ever:", bans.slice(-60).join("; "), ""]
      : []),
    ...(banArtists.length
      ? ["The listener has repeatedly rejected these artists. Do not program them at all:", banArtists.join("; "), ""]
      : []),
    ...(listenerRequest
      ? [
          `LISTENER REQUEST: "${listenerRequest}".`,
          requestOnly
            ? `Pick exactly the requested track, or if they described a vibe or something vague, the best real match for it. ${dj === "fred" ? "The intro states flatly that a listener request has been processed." : "The intro acknowledges the request in your own voice."}`
            : `Honor it early in this block — play the requested track (or the closest real match); ${dj === "fred" ? "that track's intro states flatly that a listener request has been processed." : "that track's intro acknowledges the request in your own voice."}`,
          "",
        ]
      : []),
    `Pick ${count} real, existing track${count === 1 ? "" : "s"}.`,
    ...(requestOnly
      ? []
      : [
          "VARIETY IS THE POINT. This station exists to broaden the listener's world, not replay",
          "their usual rotation. In each block: at most ONE track from an artist in their taste",
          "profile; the rest should be DISCOVERY — artists they don't already listen to but would",
          "love, adjacent genres, deeper catalog, other eras, respected artists in the show's lane.",
          "Lean on the GENRES more than the specific artists. Reach; surprise them. Sequence like a",
          "radio set: flow, contrast, a peak. Never fill a block with their obvious favourites.",
        ]),
    "Use exact artist names and exact track titles so they resolve in Apple Music search.",
    "",
    ...(requestOnly
      ? ["This is a request, so it ALWAYS gets a spoken intro."]
      : [
          "TALK CADENCE: give a spoken intro to 1 or 2 of the picks — never zero, so the DJ is",
          "present every block. Leave the other picks with an empty intro so songs run back-to-back.",
        ]),
    ...(announceShow
      ? ["",
         `NEW SHOW STARTING: the show just changed to "${announceShow.name}" (${announceShow.desc})`,
         "The FIRST spoken intro MUST welcome the listener into this show — name it and describe the",
         "kind of music it plays, in your own voice — before presenting that first track.",
        ]
      : ["",
         "Occasionally (not every block) let a spoken intro mention the show's name and the kind of",
         "music you're playing, the way a real host reminds listeners what they're tuned into.",
        ]),
    "",
    ...host.spec,
    "",
    "STUDIO METADATA:",
    `- Time: ${clock}`,
    weatherLine,
    "- Current and upcoming audio: the picks in this block, in order.",
    "",
    ...host.example,
  ].join("\n");
  return callGemini(text, PICKS_SCHEMA);
}

export async function suggestSchedule(tasteProfile) {
  const text = [
    `Design a full weekly programming schedule for ${settings.stationName}, a one-listener personal radio station.`,
    "",
    "Listener taste profile:",
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
    "  golden hour, ambient and late-night stretches), 'fred' (flat synthetic robot — suits",
    "  focus blocks and the stranger, more clinical shows), or 'marlowe' (warm, human, easy",
    "  energy — suits mornings, drivetime and weekend days). Use all three across the week.",
  ].join("\n");
  return callGemini(text, SCHEDULE_SCHEMA, 1024, MODEL_SCHEDULE);
}
