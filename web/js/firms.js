// NASA FIRMS active-fire / thermal-anomaly detections as a board overlay.
// The local server caches the near-real-time files; MapLibre loads the GeoJSON in its worker.

import { emit } from './state.js';
import { map } from './globe.js';
import { ANCHOR_OVERLAY } from './basemap.js';
import { $, h, getJSON, stamp, clamp, wrapLon } from './util.js';

const SATS = ['NOAA-20 VIIRS', 'NOAA-21 VIIRS', 'SUOMI NPP VIIRS', 'TERRA MODIS', 'AQUA MODIS'];
const CONF = ['LOW', 'NOMINAL', 'HIGH'];
const WINDOWS = [['24h', '24H'], ['48h', '48H'], ['7d', '7D']];
const FAMILIES = [['all', 'ALL'], ['viirs', 'VIIRS 375M'], ['modis', 'MODIS 1KM']];
const GLOBAL_BELOW_ZOOM = 3.2;                 // wider than this, ask for the whole world
const REFRESH_MS = 15 * 60 * 1000;
const EMPTY = { type: 'FeatureCollection', features: [] };

export const firms = { on: false, win: '24h', src: 'all', busy: false, error: null, meta: null };

let last = null;              // { key, box (raw lon/lat or null), truncated }
let request = 0;
let moveTimer = null;

// ---------------------------------------------------------------- data

function rawView(pad) {
  if (map.getZoom() < GLOBAL_BELOW_ZOOM) return null;
  const b = map.getBounds();
  let w = b.getWest(), e = b.getEast(), s = b.getSouth(), n = b.getNorth();
  const dx = (e - w) * pad, dy = (n - s) * pad;
  w -= dx; e += dx; s -= dy; n += dy;
  if (!(e > w) || e - w > 300) return null;
  return [w, clamp(s, -90, 90), e, clamp(n, -90, 90)];
}

const covers = (outer, inner) => outer[0] <= inner[0] && outer[1] <= inner[1] && outer[2] >= inner[2] && outer[3] >= inner[3];

async function load(force) {
  if (!firms.on) return;
  const key = `${firms.win}/${firms.src}`;
  const view = rawView(0);
  if (!force && last && last.key === key) {
    const stillValid = last.box === null ? !(last.truncated && view) : (view && covers(last.box, view) && !last.truncated);
    if (stillValid) return;
  }
  const box = rawView(0.3);
  const q = new URLSearchParams({ win: firms.win, src: firms.src });
  // A box whose west exceeds its east tells the server it spans the antimeridian.
  if (box) q.set('bbox', [wrapLon(box[0]), box[1], wrapLon(box[2]), box[3]].map((v) => v.toFixed(3)).join(','));
  const mine = ++request;
  firms.busy = true; firms.error = null;
  render();
  try {
    const meta = await getJSON(`/api/firms?${q}&meta=1`);         // first call makes the server fetch and parse
    if (mine !== request || !firms.on) return;
    firms.meta = meta;
    last = { key, box, truncated: meta.truncated };
    map.getSource('cy-firms').setData(`/api/firms?${q}`);
    restyle();
    const failed = meta.feeds.filter((f) => f.error && !f.rows).map((f) => f.key.toUpperCase());
    if (failed.length === meta.feeds.length) firms.error = 'FIRMS FEEDS UNREACHABLE';
  } catch (e) {
    if (mine !== request) return;
    firms.error = e.message;
  }
  firms.busy = false;
  render();
  emit('firms');
}

/** Fade older detections; recomputed against the wall clock whenever data is refreshed. */
function restyle() {
  const nowMin = Math.floor(Date.now() / 60000);
  const age = ['-', nowMin, ['get', 't']];
  const fade = ['interpolate', ['linear'], age, 0, 1, 1440, 0.8, 2880, 0.6, 10080, 0.4];
  map.setPaintProperty('cy-firms', 'circle-opacity', ['*', fade, ['match', ['get', 'c'], 0, 0.55, 1]]);
}

// ---------------------------------------------------------------- map layers

function addLayers() {
  map.addSource('cy-firms', { type: 'geojson', data: EMPTY, maxzoom: 10, buffer: 16, tolerance: 0 });
  const radiusAt = (k) => ['interpolate', ['exponential', 1.5], ['zoom'], 1, 1.1 * k, 5, 2 * k, 9, 3.6 * k, 13, 9 * k, 16, 22 * k];
  const radius = radiusAt(1);
  map.addLayer({ id: 'cy-firms-glow', type: 'circle', source: 'cy-firms', minzoom: 5, layout: { visibility: 'none' },
    paint: { 'circle-radius': radiusAt(2.6), 'circle-color': '#ff3b30', 'circle-blur': 1, 'circle-opacity': 0.22 } }, ANCHOR_OVERLAY);
  map.addLayer({ id: 'cy-firms', type: 'circle', source: 'cy-firms', layout: { visibility: 'none', 'circle-sort-key': ['get', 'f'] },
    paint: {
      'circle-radius': radius,
      'circle-color': ['interpolate', ['linear'], ['get', 'f'], 0, '#ffb300', 8, '#ff7a1a', 40, '#ff3b30', 250, '#fff1e6'],
      'circle-stroke-width': ['interpolate', ['linear'], ['zoom'], 7, 0, 10, 0.8],
      'circle-stroke-color': '#2a0500',
    } }, ANCHOR_OVERLAY);
}

function setVisible(v) {
  for (const id of ['cy-firms', 'cy-firms-glow']) map.setLayoutProperty(id, 'visibility', v ? 'visible' : 'none');
}

/** The detection under a screen point, if any. */
export function fireAt(point) {
  if (!firms.on) return null;
  const pad = 5;
  const hit = map.queryRenderedFeatures([[point.x - pad, point.y - pad], [point.x + pad, point.y + pad]], { layers: ['cy-firms'] });
  if (!hit.length) return null;
  hit.sort((a, b) => b.properties.f - a.properties.f);
  return hit[0];
}

export function describeFire(feature) {
  const p = feature.properties;
  const time = p.t * 60000;
  return {
    lonlat: feature.geometry.coordinates,
    time,
    title: `THERMAL DETECTION  ${stamp(time)}`,
    sub: `${SATS[p.s] || 'UNKNOWN'}  FRP ${p.f} MW  ${CONF[p.c]} CONFIDENCE`,
    facts: [
      ['SENSOR', SATS[p.s] || 'UNKNOWN'],
      ['DETECTED', stamp(time)],
      ['PASS', p.n ? 'NIGHT' : 'DAY'],
      ['FIRE POWER', `${p.f} MW (FRP)`],
      ['BRIGHTNESS', p.b ? `${p.b} K` : 'N/A'],
      ['CONFIDENCE', CONF[p.c]],
    ],
  };
}

// ---------------------------------------------------------------- control block

export function setFirms(patch) {
  const wasOn = firms.on;
  Object.assign(firms, patch);
  setVisible(firms.on);
  if (!firms.on) {
    request += 1; firms.busy = false; last = null;
    map.getSource('cy-firms').setData(EMPTY);
    render();
    emit('firms');
    return;
  }
  load(!wasOn || 'win' in patch || 'src' in patch);
}

function statusLine() {
  if (!firms.error && !firms.busy && !firms.meta) return '';
  if (firms.error) return h('div', { class: 'ov-note red' }, `UNAVAILABLE: ${firms.error}`);
  if (firms.busy && !firms.meta) return h('div', { class: 'ov-note amber' }, firms.win === '7d' ? 'RETRIEVING 7-DAY FILES (ABOUT 60 MB)…' : 'RETRIEVING DETECTIONS…');
  const m = firms.meta;
  const n = (v) => v.toLocaleString('en-US');
  const to = m.newest ? ` TO ${stamp(Date.parse(m.newest)).slice(-6)}` : '';
  return h('div', { class: 'ov-note' + (m.truncated ? ' amber' : '') },
    m.truncated ? `SHOWING ${n(m.count)} STRONGEST OF ${n(m.total)}. ZOOM IN FOR ALL.` : `${n(m.count)} DETECTIONS${last && last.box ? ' IN VIEW' : ''}${to}`,
    firms.busy ? ' …' : '');
}

function seg(options, current, onPick) {
  return h('div', { class: 'seg' }, options.map(([val, label]) => h('button', { class: val === current ? 'on' : '', onclick: () => onPick(val) }, label)));
}

function render() {
  const el = $('#firms-block');
  if (!el) return;
  el.replaceChildren(
    h('div', { class: 'row-c ov-head' + (firms.on ? '' : ' off'), style: { '--c': '#ff5a2b' }, title: 'NASA FIRMS near-real-time active fire and thermal anomaly detections',
      onclick: () => setFirms({ on: !firms.on }) },
    h('button', { class: 'lampbtn' + (firms.on ? ' lit' : ''), 'aria-pressed': String(firms.on), title: firms.on ? 'Hide detections' : 'Show detections',
      onclick: (e) => { e.stopPropagation(); setFirms({ on: !firms.on }); } }),
    h('span', { class: 'nm' }, 'FIRMS THERMAL DETECTIONS'),
    h('span', { class: 'tag' }, 'NRT')),
    firms.on ? h('div', { class: 'ov-body' },
      h('div', { class: 'ctl' },
        h('span', { class: 'k' }, 'WINDOW'), seg(WINDOWS, firms.win, (w) => setFirms({ win: w })),
        h('span', { class: 'k' }, 'SENSOR'), seg(FAMILIES, firms.src, (s) => setFirms({ src: s }))),
      statusLine()) : '',
  );
}

export function initFirms() {
  addLayers();
  render();
  map.on('moveend', () => {
    if (!firms.on) return;
    clearTimeout(moveTimer);
    moveTimer = setTimeout(() => load(false), 450);
  });
  setInterval(() => { if (firms.on && !document.hidden) load(true); }, REFRESH_MS);
}
