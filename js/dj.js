// The DJ brain. Gemini picks tracks from the full Apple Music catalog based on
// the listener's taste, the time of day, the scheduled show's brief, and any
// listener request. Also writes the week's programming when asked.
import { settings, TIME_TOKEN } from "./config.js";
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
    ? "- VERIFIED WEATHER. Every figure below is real. You may state any of it on air, and you\n" +
      "  may state NOTHING beyond it — no invented conditions, no guessed temperatures.\n" +
      weather.split("\n").map((l) => `    ${l}`).join("\n") + "\n" +
      "  The fall of light is often better on-air colour than the temperature."
    : "- Weather: UNKNOWN. Never mention weather, temperature, sky conditions, or the sun.";

  // Real stations do two different things with weather, and this one was only
  // ever doing the first: a passing half-line ("grey out there today"), versus
  // an actual bulletin that tells you what's coming. Without being asked for
  // the second it never volunteered one, because every other instruction here
  // pushes towards brevity.
  const weatherBulletin = weather
    ? "- WEATHER UPDATES: once in a while — NOT every block, roughly one block in three — give a\n" +
      "  proper weather update rather than a passing mention: what it's doing now AND what's\n" +
      "  coming, using the TODAY / NEXT / TOMORROW figures above. Two sentences at most, in your\n" +
      "  own voice, attached to one track's intro. A real host does this a few times an hour and\n" +
      "  then drops it for a while; they don't mention the sky in every single link. When it isn't\n" +
      "  a full update, a glancing reference to the current conditions is still welcome."
    : "";

  // A REQUIREMENT, not a permission.
  //
  // Every other mention of the clock and sky is a ceiling ("at most one",
  // "only when it earns its place"), and each host's spec hedges the same way.
  // Given only ceilings the model resolves them downward and stops mentioning
  // either — which is how time and weather quietly disappeared from the air.
  // Naming a floor, and a rate, is what brings them back; the hosts' own specs
  // still decide how it's phrased in their voice.
  const cadenceLine = weather
    ? "- ON-AIR CLOCK AND SKY: at least ONE spoken drop in this block must place the listener in " +
      "the moment — the time, or the verified weather and light above. This is what separates live " +
      "radio from a playlist, so treat it as part of the job, not a flourish. Not every drop; " +
      "roughly one in three."
    : "- ON-AIR CLOCK: at least ONE spoken drop in this block must place the listener in the day — " +
      "the hour, the part of the afternoon, how late it's getting. Not every drop; roughly one in " +
      "three. Weather is UNKNOWN right now, so leave it out entirely.";

  // A REAL DETAIL, not just a title read out.
  //
  // Every host's spec already permits a fact — "sometimes include", "may fold
  // in", "may offer" — and every one ends with an escape hatch ("if unsure,
  // omit"). Given a permission, a way out, and no floor, a correctly-cautious
  // model takes the way out every time, and the DJ never says anything a
  // playlist couldn't.
  //
  // One per block rather than one in three: a fact is a bigger swing than a
  // time check, and trivia on every third song would wear thin faster.
  //
  // ACCURACY IS THE POINT. Weather could be checked against Open-Meteo; this
  // can't be checked against anything, so the guardrails do the work — steer
  // toward the widely documented, forbid the specifics where invention
  // actually happens, and always leave a safe exit so the model is never
  // cornered into making something up.
  const factLine = [
    "- ON-AIR COLOUR: at least ONE spoken drop in this block must carry a real detail about",
    "  the artist, the record, or where it sits in music history — who produced it, what band",
    "  someone was in before, which album it opens, what scene it came out of, who sampled it",
    "  later. This is what separates a host who knows their records from one reading a list.",
    "  Not every drop; one or two in a block is plenty, and it needn't be the same drop as the",
    "  time or weather — three facts in one breath is a lecture, not radio.",
    "",
    "  A CONFIDENT WRONG FACT IS WORSE THAN NO FACT. It goes out in a trusted voice and the",
    "  listener has no way to check it. So:",
    "  - Say it only if you are certain. Prefer the widely documented over the obscure.",
    "  - NEVER invent, and never guess at specifics: exact dates, chart positions, sales",
    "    figures, studio names, or words quoted to a real person. If the detail needs a number",
    "    you aren't sure of, tell it without the number.",
    "  - If nothing certain comes to mind for a track, say something about the MUSIC instead —",
    "    how it's built, what it does to a room. That is always true and always available.",
  ].join("\n");
  const bans = bannedTracks();
  const banArtists = bannedArtists();
  const text = [
    `You are ${djName}, the on-air DJ for a one-listener radio station called ${settings.stationName}.`,
    `Current slot: ${timeSlot()}. Local time right now: ${new Date().toLocaleTimeString()} — but see THE CLOCK below.`,
    "",
    // Intros for the whole block are written HERE, in one call, and spoken
    // anywhere from seconds to an hour later depending on track lengths and
    // skipping. Any time written into the text is wrong on air. The station
    // substitutes the real clock as each line is spoken.
    "THE CLOCK: you are writing several intros at once, and they will be spoken at",
    "different times — possibly much later, possibly sooner if the listener skips ahead.",
    "So NEVER write a clock time yourself. When a line states the time, write exactly",
    `${TIME_TOKEN} and the station replaces it with the real clock as the line goes to air.`,
    `  Right: "It's ${TIME_TOKEN}, and this next one is..."`,
    `  Wrong: "It's 2:15, and this next one is..."  (that will be wrong by the time it airs)`,
    'Vague time-of-day wording — "this afternoon", "getting late" — needs no token and is',
    `always safe. Use ${TIME_TOKEN} only where an actual clock reading belongs.`,
    ...(showBrief
      ? ["", `You are mid-show. The show is "${showBrief.name}" and its brief is: ${showBrief.desc}`, "Program within that brief."]
      : []),
    "",
    "Listener taste profile (from their listening history) — this is a STARTING POINT, not a playlist to echo:",
    JSON.stringify(tasteProfile),
    "",
    // Stated as hard rules with the real numbers, because the station enforces
    // exactly these locally: a pick breaking either one is dropped from the
    // block, which shrinks it and wastes the call. Better for the DJ to route
    // around them than to be silently corrected afterwards.
    `ALREADY PLAYED — the last ${playedSoFar.length} tracks this station aired.`,
    "Two hard rules, both enforced after you answer:",
    "  1. NEVER pick any track listed below. A track is off the air for 14 days after it plays.",
    "  2. NEVER pick an artist listed below. An artist is off the air for 4 hours after they play,",
    "     so a different song by one of these artists still counts as a repeat right now.",
    "Anything breaking those is discarded and the block comes up short, so route around them:",
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
          // Roughly one in three, and SPREAD. This was "1 or 2 of the picks"
          // against a 12-track block — a voice every six to twelve songs, and
          // worse when skipping, because the talk-up only fires as a song ENDS
          // and a skip jumps straight past it. Stated as a count rather than
          // "a few", and told to spread, or they cluster at the front and the
          // tail of the block is silent anyway.
          `TALK CADENCE: give a spoken intro to about one pick in three — for this block of ${count}`,
          `that means roughly ${Math.max(1, Math.floor(count / 3))} of them. Never zero.`,
          "SPREAD THEM OUT across the running order rather than clustering at the start, and never",
          "two in a row. The listener should hear a voice every couple of songs, not a burst up",
          "front followed by a long silence. Leave the remaining picks with an empty intro so those",
          "songs run back-to-back.",
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
    weatherBulletin,
    "- Current and upcoming audio: the picks in this block, in order.",
    // A one-track request block gets a single intro that belongs to the
    // request — forcing a time check into it would crowd out the thing the
    // listener actually asked for.
    ...(requestOnly ? [] : [cadenceLine]),
    ...(requestOnly ? [] : [factLine]),
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
