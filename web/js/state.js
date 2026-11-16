// Shared application state, a tiny event bus and the simulation clock.

const listeners = new Map();

export function on(evt, fn) {
  if (!listeners.has(evt)) listeners.set(evt, new Set());
  listeners.get(evt).add(fn);
}

export function emit(evt, data) {
  const set = listeners.get(evt);
  if (set) for (const fn of [...set]) fn(data);
}

export const S = {
  catalog: null,
  cons: new Map(),            // constellation id -> catalogue entry
  visible: new Set(),         // constellation ids drawn on the board
  active: null,               // constellation id under examination
  selSat: null,               // NORAD id of the selected satellite
  follow: false,              // keep the camera on the selected satellite

  aoiMode: 'view',            // 'view' | 'target'
  target: null,               // [lon, lat]
  designating: false,         // next map click sets the target

  pastDays: 7,
  futureDays: 7,
  custom: false,              // search an explicit date range instead of a lookback
  from: null,                 // 'YYYY-MM-DD' (UTC), used when custom
  to: null,
  cloudMax: 100,

  results: [],                // normalised scene / planned / predicted records
  resultMeta: {},             // notes from the last scan
  selected: null,             // record id
  hovered: null,              // record id
  rendered: new Map(),        // record id -> { rec, viz, quality, opacity }

  basemap: 'vector',          // 'vector' | 'imagery' | 'live'
  imagery: 'esri',            // provider used when basemap is 'imagery'
  live: 'geocolour',          // variant used when basemap is 'live'
  showGrid: true,
  showNight: true,
};

// ---------------------------------------------------------------- clock
// Real time by default. Jumping or accelerating detaches it from the wall clock.

let base = Date.now();
let perf0 = performance.now();
let rate = 1;
let live = true;

export const clock = {
  now() {
    return live ? Date.now() : base + (performance.now() - perf0) * rate;
  },
  get rate() { return rate; },
  get live() { return live; },
  goLive() {
    live = true; rate = 1;
    emit('clock');
  },
  set(ms) {
    base = ms; perf0 = performance.now(); live = false;
    emit('clock');
  },
  jump(deltaMs) {
    this.set(this.now() + deltaMs);
  },
  setRate(r) {
    const t = this.now();
    rate = r;
    if (r === 1 && Math.abs(t - Date.now()) < 1500) { live = true; } else { base = t; perf0 = performance.now(); live = false; }
    emit('clock');
  },
};
