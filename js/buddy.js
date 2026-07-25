// Fred — the booth robot. Leads the DJ thinking line, reacting to what the
// station is doing (same mood machine as Subwave's Booth Sprite: react
// timings, sleepy timeout, poke-startle sequence). Geometry/animation live in
// style.css under .buddy[data-mood].
const REACTION_MS = { voice: 8000, dj: 6000 };
const SLEEPY_MS = 90000;

export function createBuddy(mount) {
  mount.innerHTML = `
    <span class="buddy" data-mood="sleepy" aria-hidden="true" title="fred">
      <span class="b-breathe"><span class="b-root">
        <span class="b-antwrap"><span class="b-tip"><span class="b-pulse"></span></span><span class="b-stalk"></span></span>
        <span class="b-head">
          <span class="b-z"><span>z</span><span>z</span></span>
          <span class="b-eyes">
            <span class="b-eye"><span class="b-pupil"></span></span>
            <span class="b-eye"><span class="b-pupil"></span></span>
          </span>
          <span class="b-mouth"><span class="b-bar"></span><span class="b-bar"></span><span class="b-bar"></span></span>
        </span>
        <span class="b-legs"><span></span><span></span></span>
      </span></span>
    </span>`;
  const el = mount.firstElementChild;

  let reactTimers = [];
  let pokeTimers = [];
  let sleepyTimer = null;
  let poked = false;
  let asleep = true;

  const set = (m) => { el.dataset.mood = m; };
  const clear = (arr) => { arr.forEach(clearTimeout); arr.length = 0; };
  const scheduleSleepy = () => {
    clearTimeout(sleepyTimer);
    sleepyTimer = setTimeout(() => { if (!asleep && !poked) { asleep = true; set("sleepy"); } }, SLEEPY_MS);
  };

  function react(kind) {
    if (poked || asleep) return;
    clear(reactTimers);
    set(kind === "voice" ? "onair" : "curious");
    reactTimers.push(setTimeout(() => set("content"), REACTION_MS[kind] || 6000));
    scheduleSleepy();
  }

  // The startle: spooked -> curious -> content. Also how he wakes up.
  function poke() {
    poked = true;
    asleep = false;
    clear(reactTimers);
    clear(pokeTimers);
    set("spooked");
    pokeTimers.push(
      setTimeout(() => set("curious"), 850),
      setTimeout(() => { poked = false; set("content"); scheduleSleepy(); }, 2400)
    );
  }

  function sleep() {
    asleep = true;
    poked = false;
    clear(reactTimers);
    clear(pokeTimers);
    clearTimeout(sleepyTimer);
    set("sleepy");
  }

  el.addEventListener("click", (e) => { e.stopPropagation(); poke(); });

  return { react, poke, sleep, wake: poke };
}
