// Local weather for the DJ and the header, via Open-Meteo (free, no key).
// Location comes from the browser's geolocation prompt once, then is cached.
const COORDS_KEY = "tfm_coords"; // {lat, lon} or "denied"

const WMO = [
  [0, "clear"], [1, "mostly clear"], [2, "partly cloudy"], [3, "cloudy"],
  [45, "foggy"], [48, "foggy"], [51, "drizzling"], [53, "drizzling"], [55, "drizzling"],
  [61, "rainy"], [63, "rainy"], [65, "pouring"], [66, "icy rain"], [67, "icy rain"],
  [71, "snowy"], [73, "snowy"], [75, "heavy snow"], [77, "snowy"],
  [80, "showery"], [81, "showery"], [82, "stormy showers"],
  [95, "thundery"], [96, "thundery"], [99, "thundery"],
];

function describe(code) {
  let best = "unsettled";
  for (const [c, label] of WMO) if (code >= c) best = label;
  return best;
}

function getCoords() {
  return new Promise((resolve) => {
    try {
      const cached = JSON.parse(localStorage.getItem(COORDS_KEY));
      if (cached === "denied") return resolve(null);
      if (cached?.lat) return resolve(cached);
    } catch {}
    if (!navigator.geolocation) return resolve(null);
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        const coords = { lat: pos.coords.latitude, lon: pos.coords.longitude };
        localStorage.setItem(COORDS_KEY, JSON.stringify(coords));
        resolve(coords);
      },
      () => {
        localStorage.setItem(COORDS_KEY, JSON.stringify("denied"));
        resolve(null);
      },
      { timeout: 10000, maximumAge: 3600000 }
    );
  });
}

let cache = null; // { at, text, tempF, description }

export async function getWeather() {
  if (cache && Date.now() - cache.at < 30 * 60 * 1000) return cache;
  const coords = await getCoords();
  if (!coords) return null;
  try {
    const res = await fetch(
      `https://api.open-meteo.com/v1/forecast?latitude=${coords.lat}&longitude=${coords.lon}` +
        "&current=temperature_2m,weather_code&temperature_unit=fahrenheit"
    );
    if (!res.ok) return cache;
    const json = await res.json();
    const tempF = Math.round(json.current?.temperature_2m);
    const description = describe(json.current?.weather_code ?? 0);
    cache = { at: Date.now(), tempF, description, text: `${tempF}°F and ${description}` };
    return cache;
  } catch {
    return cache;
  }
}
