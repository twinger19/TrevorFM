// The signal band: a 120-bar canvas strip in the style of Subwave's Waveform.
// Spotify audio can't be tapped for real spectrum data (DRM, or it's playing
// in another app entirely), so this uses their synthetic random-walk fallback:
// heavier motion on the left, easing off to the right. Played portion of the
// current track renders in the accent color (progress split).
const BARS = 120;
const REST = 0.12;
const FRAME_MS = 30;

export function createWaveform(canvas) {
  const ctx = canvas.getContext("2d");
  const levels = new Float32Array(BARS);
  let onAir = false;
  let progressFrac = 0;
  let lastPaint = 0;
  let palette = null;
  // Musical modulation: lyric-line pulses + track-position energy envelope.
  let energy = 1;
  let pulseUntil = 0;

  function resolvePalette() {
    const cs = getComputedStyle(document.body);
    palette = {
      bar: cs.getPropertyValue("--ink").trim() || "#161412",
      past: cs.getPropertyValue("--accent").trim() || "#d9402a",
    };
  }

  function stepWalk() {
    const boost = (performance.now() < pulseUntil ? 1.55 : 1) * energy;
    for (let i = 0; i < BARS; i++) {
      const target = Math.pow(Math.random(), 1.4) * (1 - i / (BARS * 2.2)) * boost;
      levels[i] += (target - levels[i]) * 0.45;
    }
  }

  function paint() {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const w = canvas.clientWidth, h = canvas.clientHeight;
    if (!w || !h) return;
    if (canvas.width !== w * dpr || canvas.height !== h * dpr) {
      canvas.width = w * dpr;
      canvas.height = h * dpr;
    }
    if (!palette) resolvePalette();
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    const slot = w / BARS;
    const barW = Math.max(1.5, slot * 0.45);
    const pastBars = Math.floor(progressFrac * BARS);
    for (let i = 0; i < BARS; i++) {
      const level = onAir ? Math.max(REST, levels[i]) : REST;
      const bh = Math.max(2, level * h);
      ctx.fillStyle = i < pastBars ? palette.past : palette.bar;
      ctx.globalAlpha = i < pastBars ? 0.75 : 0.45;
      ctx.fillRect(i * slot, (h - bh) / 2, barW, bh);
    }
    ctx.globalAlpha = 1;
  }

  function loop(t) {
    if (t - lastPaint >= FRAME_MS) {
      lastPaint = t;
      if (onAir) stepWalk();
      paint();
    }
    requestAnimationFrame(loop);
  }
  requestAnimationFrame(loop);

  return {
    setOnAir(v) { onAir = v; if (!v) { levels.fill(0); progressFrac = 0; } },
    setProgress(frac) { progressFrac = Math.max(0, Math.min(1, frac || 0)); },
    // A synced-lyric line just landed: kick the band for a beat.
    pulse() { pulseUntil = performance.now() + 450; },
    // 0.25..1.2 multiplier from track position (intro/outro breathe lower).
    setEnergy(v) { energy = Math.max(0.25, Math.min(1.2, v || 1)); },
  };
}
