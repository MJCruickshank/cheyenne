// INTEL: Telegram channel monitor. The local server reads the channels, works out where each
// post is about and classifies it; this module plots the last 24 hours, lists them in the Intel
// tab and raises an alert when a new located report arrives.

import { emit, clock } from './state.js';
import { map, setData } from './globe.js';
import { ANCHOR_OVERLAY, INK } from './basemap.js';
import { setTarget } from './mission.js';
import { setFirms } from './firms.js';
import { setLamp, placePicker, closePicker } from './hud.js';
import { $, h, getJSON, stamp, hms, fmtPos, toast, destination } from './util.js';

const POLL_MS = 15000;
const ALERT_MS = 120000;                       // how long a new report pulses on the globe
const FEED_ROWS = 250;
const RING_KM = { district: 12, region: 45 };  // drawn uncertainty by how precisely a report is placed
const PREC = { exact: 'EXACT', site: 'SITE', settlement: 'SETTLEMENT', district: 'DISTRICT', region: 'REGION', country: 'COUNTRY' };
const HOT = ['strike', 'drone', 'shelling', 'explosion', 'fire', 'infrastructure', 'air_defence'];

const RED = '#ff453a', ORANGE = '#ff9f0a', YELLOW = '#ffd60a', SKY = '#64d2ff', PINK = '#ff6fae', VIOLET = '#b79bff', GREEN = '#7cf29a', PALE = '#e2fff7', LIME = '#c6ff5c';

// Each glyph is drawn in a 30 px box centred on (c, c).
const CATS = {
  strike: { label: 'STRIKE', color: RED, draw(g, c) { line(g, c + 6, c - 6, c - 4, c + 4); line(g, c - 5, c + 5, c - 5, c - 0.5); line(g, c - 5, c + 5, c + 0.5, c + 5); line(g, c + 3, c - 7, c + 7, c - 3); } },
  drone: { label: 'DRONE', color: ORANGE, draw(g, c) { poly(g, [[c, c - 6.5], [c + 6.5, c + 4.5], [c, c + 1.5], [c - 6.5, c + 4.5]], true); } },
  shelling: { label: 'SHELLING', color: RED, draw(g, c) { for (const dx of [-4.5, 0, 4.5]) line(g, c + dx + 2.5, c - 5.5, c + dx - 2.5, c + 5.5); } },
  explosion: { label: 'EXPLOSION', color: RED, draw(g, c) { const p = []; for (let i = 0; i < 16; i++) { const r = i % 2 ? 3 : 7, a = (i * Math.PI) / 8; p.push([c + r * Math.sin(a), c - r * Math.cos(a)]); } poly(g, p, true); } },
  air_defence: { label: 'AIR DEFENCE', color: SKY, draw(g, c) { g.beginPath(); g.arc(c, c + 4, 7, Math.PI, 0); g.stroke(); line(g, c, c + 4, c, c - 1.5); line(g, c - 2.5, c + 1, c, c - 2); line(g, c + 2.5, c + 1, c, c - 2); } },
  alert: { label: 'ALERT', color: YELLOW, draw(g, c) { poly(g, [[c, c - 6.5], [c + 7, c + 5.5], [c - 7, c + 5.5]], false); line(g, c, c - 2.5, c, c + 1.5); g.fillRect(c - 0.8, c + 3, 1.6, 1.6); } },
  ground: { label: 'GROUND', color: PINK, draw(g, c) { g.strokeRect(c - 6.5, c - 4.5, 13, 9); line(g, c - 6.5, c - 4.5, c + 6.5, c + 4.5); line(g, c - 6.5, c + 4.5, c + 6.5, c - 4.5); } },
  movement: { label: 'MOVEMENT', color: VIOLET, draw(g, c) { line(g, c - 7, c, c + 6, c); line(g, c + 2, c - 4.5, c + 6.5, c); line(g, c + 2, c + 4.5, c + 6.5, c); } },
  naval: { label: 'NAVAL', color: VIOLET, draw(g, c) { g.beginPath(); g.arc(c, c - 5, 1.8, 0, Math.PI * 2); g.stroke(); line(g, c, c - 3, c, c + 6.5); line(g, c - 3.5, c - 0.5, c + 3.5, c - 0.5); g.beginPath(); g.arc(c, c + 0.5, 6, 0.15 * Math.PI, 0.85 * Math.PI); g.stroke(); } },
  raid: { label: 'RAID', color: PINK, draw(g, c) { g.beginPath(); g.moveTo(c - 5.5, c - 6); g.lineTo(c + 5.5, c - 6); g.lineTo(c + 5.5, c); g.quadraticCurveTo(c + 5, c + 5, c, c + 7); g.quadraticCurveTo(c - 5, c + 5, c - 5.5, c); g.closePath(); g.stroke(); } },
  infrastructure: { label: 'INFRASTRUCTURE', color: ORANGE, draw(g, c) { poly(g, [[c + 2, c - 7.5], [c - 4.5, c + 1], [c - 0.5, c + 1], [c - 2, c + 7.5], [c + 4.5, c - 1.5], [c + 0.5, c - 1.5]], true); } },
  fire: { label: 'FIRE', color: ORANGE, draw(g, c) { g.beginPath(); g.moveTo(c, c - 7.5); g.bezierCurveTo(c + 1, c - 3, c + 6, c - 1, c + 5, c + 3); g.bezierCurveTo(c + 4.5, c + 6.5, c - 4.5, c + 6.5, c - 5, c + 3); g.bezierCurveTo(c - 5.5, c, c - 2.5, c - 1, c - 2.5, c - 3.5); g.bezierCurveTo(c - 1, c - 2.5, c, c - 4, c, c - 7.5); g.fill(); } },
  disaster: { label: 'DISASTER', color: PALE, draw(g, c) { for (const dy of [-3.5, 1, 5.5]) { g.beginPath(); g.moveTo(c - 7, c + dy); g.bezierCurveTo(c - 3.5, c + dy - 4, c - 1, c + dy + 3, c + 1.5, c + dy - 0.5); g.bezierCurveTo(c + 3.5, c + dy - 3, c + 5, c + dy, c + 7, c + dy - 1); g.stroke(); } } },
  unrest: { label: 'UNREST', color: PALE, draw(g, c) { g.strokeRect(c - 6, c - 7, 12, 7.5); line(g, c, c + 0.5, c, c + 7.5); line(g, c - 3, c - 3.2, c + 3, c - 3.2); } },
  humanitarian: { label: 'HUMANITARIAN', color: GREEN, draw(g, c) { g.fillRect(c - 2, c - 6.5, 4, 13); g.fillRect(c - 6.5, c - 2, 13, 4); } },
  crime: { label: 'CRIME', color: PINK, draw(g, c) { g.beginPath(); g.arc(c, c, 5.5, 0, Math.PI * 2); g.stroke(); line(g, c, c - 8, c, c - 3); line(g, c, c + 3, c, c + 8); line(g, c - 8, c, c - 3, c); line(g, c + 3, c, c + 8, c); } },
  cyber: { label: 'CYBER', color: LIME, draw(g, c) { g.strokeRect(c - 5.5, c - 1, 11, 8); g.beginPath(); g.arc(c, c - 1, 3.6, Math.PI, 0); g.stroke(); g.fillRect(c - 0.9, c + 1.5, 1.8, 3); } },
  other: { label: 'OTHER', color: PALE, draw(g, c) { g.beginPath(); g.arc(c, c, 2.4, 0, Math.PI * 2); g.fill(); } },
};
const catOf = (p) => (CATS[p.cat] ? p.cat : 'other');

function line(g, x1, y1, x2, y2) { g.beginPath(); g.moveTo(x1, y1); g.lineTo(x2, y2); g.stroke(); }
function poly(g, pts, fill) {
  g.beginPath();
  pts.forEach(([x, y], i) => (i ? g.lineTo(x, y) : g.moveTo(x, y)));
  g.closePath();
  if (fill) g.fill(); else g.stroke();
}

export const intel = {
  on: false, loaded: false, error: null,
  posts: new Map(), channels: [], status: null, seq: 0,
  view: 'feed', show: 'all', scope: 'all', hidden: new Set(),
  alerts: true, sound: false, unseen: 0,
};

let sites = new Map();        // site key -> { key, lon, lat, place, posts[] }
let pulses = [];              // [{ key, lon, lat, until }]
let timer = null, request = 0, pulseFrame = 0;
const alerted = new Set();
const iconUrl = {};

const prefs = {
  load() { try { Object.assign(intel, JSON.parse(localStorage.getItem('cheyenne.intel') || '{}')); } catch { /* first run */ } },
  save() { try { localStorage.setItem('cheyenne.intel', JSON.stringify({ alerts: intel.alerts, sound: intel.sound })); } catch { /* private mode */ } },
};

// ---------------------------------------------------------------- map layers

function drawIcon(cat) {
  const def = CATS[cat], size = 30;
  const cv = document.createElement('canvas');
  cv.width = cv.height = size * 2;
  const g = cv.getContext('2d');
  g.scale(2, 2);
  const c = size / 2;
  g.fillStyle = 'rgba(1,6,8,0.88)'; g.strokeStyle = def.color; g.lineWidth = 1.4;
  g.shadowColor = def.color; g.shadowBlur = 4;
  g.beginPath(); g.arc(c, c, 12.5, 0, Math.PI * 2); g.fill(); g.stroke();
  g.shadowBlur = 0; g.fillStyle = def.color; g.lineWidth = 1.6; g.lineCap = 'round'; g.lineJoin = 'round';
  def.draw(g, c);
  iconUrl[cat] = cv.toDataURL();
  return { width: cv.width, height: cv.height, data: g.getImageData(0, 0, cv.width, cv.height).data };
}

function addLayers() {
  for (const cat of Object.keys(CATS)) {
    const id = `intel-${cat}`;
    if (map.hasImage(id)) map.removeImage(id);
    map.addImage(id, drawIcon(cat), { pixelRatio: 2 });
  }
  const empty = { type: 'FeatureCollection', features: [] };
  const colour = ['match', ['get', 'cat'], ...Object.entries(CATS).flatMap(([k, v]) => [k, v.color]), PALE];
  map.addSource('cy-intel-rings', { type: 'geojson', data: empty });
  map.addLayer({ id: 'cy-intel-ring-fill', type: 'fill', source: 'cy-intel-rings', paint: { 'fill-color': colour, 'fill-opacity': 0.05 } }, ANCHOR_OVERLAY);
  map.addLayer({ id: 'cy-intel-ring', type: 'line', source: 'cy-intel-rings',
    paint: { 'line-color': colour, 'line-opacity': 0.5, 'line-width': 1, 'line-dasharray': [3, 3] } }, ANCHOR_OVERLAY);

  map.addSource('cy-intel-pulse', { type: 'geojson', data: empty });
  map.addLayer({ id: 'cy-intel-pulse', type: 'circle', source: 'cy-intel-pulse',
    paint: { 'circle-radius': 14, 'circle-color': RED, 'circle-opacity': 0, 'circle-stroke-color': RED, 'circle-stroke-width': 2, 'circle-stroke-opacity': 0.8 } }, 'cy-target');

  map.addSource('cy-intel', { type: 'geojson', data: empty });
  map.addLayer({ id: 'cy-intel', type: 'symbol', source: 'cy-intel',
    layout: {
      'icon-image': ['concat', 'intel-', ['get', 'cat']], 'icon-allow-overlap': true, 'icon-ignore-placement': true,
      'icon-size': ['interpolate', ['linear'], ['zoom'], 1, 0.62, 5, 0.85, 9, 1],
      'text-field': ['get', 'count'], 'text-font': ['Noto Sans Bold'], 'text-size': 10, 'text-offset': [1.15, -1.05],
      'text-allow-overlap': true, 'text-ignore-placement': true, 'symbol-sort-key': ['-', 0, ['get', 'age']],
    },
    paint: {
      'icon-opacity': ['interpolate', ['linear'], ['get', 'age'], 0, 1, 6, 0.9, 24, 0.5],
      'text-color': INK.white, 'text-halo-color': INK.halo, 'text-halo-width': 1.6,
    } }, 'cy-target');
}

function ringGeometry(lon, lat, km) {
  const pts = [];
  for (let b = 0; b <= 360; b += 7.5) pts.push(destination([lon, lat], b, km));
  // keep longitudes continuous so a ring over the antimeridian stays in one piece
  for (let i = 1; i < pts.length; i++) {
    while (pts[i][0] - pts[i - 1][0] > 180) pts[i][0] -= 360;
    while (pts[i][0] - pts[i - 1][0] < -180) pts[i][0] += 360;
  }
  return { type: 'Polygon', coordinates: [pts] };
}

// ---------------------------------------------------------------- data

const channelOf = (name) => intel.channels.find((c) => c.name === name);

function inScope(p) {
  const ch = channelOf(p.ch);
  if (!ch || ch.muted) return false;
  if (intel.scope === 'all') return true;
  return intel.scope.startsWith('g:') ? ch.group === intel.scope.slice(2) : p.ch === intel.scope.slice(2);
}
const mapped = (p) => p.places.filter((pl) => pl.prec !== 'country');
const isPlaced = (p) => mapped(p).length > 0;

function rebuild() {
  sites = new Map();
  for (const p of intel.posts.values()) {
    if (!inScope(p) || intel.hidden.has(catOf(p))) continue;
    for (const pl of mapped(p)) {
      const key = `${pl.lat.toFixed(4)},${pl.lon.toFixed(4)}`;
      let s = sites.get(key);
      if (!s) sites.set(key, s = { key, lon: pl.lon, lat: pl.lat, place: pl, posts: [] });
      s.posts.push(p);
    }
  }
  const now = Date.now(), points = [], rings = [];
  for (const s of sites.values()) {
    s.posts.sort((a, b) => b.t - a.t);
    const top = s.posts[0], cat = catOf(top);
    points.push({ type: 'Feature', geometry: { type: 'Point', coordinates: [s.lon, s.lat] },
      properties: { id: s.key, cat, count: s.posts.length > 1 ? String(s.posts.length) : '', age: Math.max(0, (now - top.t) / 3600000) } });
    const km = (RING_KM[s.place.prec] || 0) + (s.place.approx ? 15 : 0);
    if (km) rings.push({ type: 'Feature', geometry: ringGeometry(s.lon, s.lat, km), properties: { cat } });
  }
  setData('cy-intel', points);
  setData('cy-intel-rings', rings);
}

function setVisible(v) {
  for (const id of ['cy-intel', 'cy-intel-ring', 'cy-intel-ring-fill', 'cy-intel-pulse']) map.setLayoutProperty(id, 'visibility', v ? 'visible' : 'none');
}

function merge(res) {
  const first = !intel.loaded;
  const changed = first || res.posts.length > 0 || JSON.stringify(res.channels) !== JSON.stringify(intel.channels);
  intel.channels = res.channels;
  intel.status = res.status;
  intel.seq = res.seq;
  const fresh = [];
  for (const p of res.posts) {
    intel.posts.set(p.k, p);
    if (p.fresh && isPlaced(p)) {
      if (!first && !alerted.has(p.k)) fresh.push(p);
      alerted.add(p.k);                                // reports already on screen at start-up are not news
    }
  }
  const had = intel.posts.size;
  for (const [k, p] of intel.posts) if (p.t < res.cutoff) intel.posts.delete(k);
  intel.loaded = true;
  intel.error = null;
  if (changed || had !== intel.posts.size) rebuild();
  if (fresh.length) raise(fresh);
  // Leave the lists alone when nothing changed, so an open menu or a half-read row is not disturbed.
  if (changed || had !== intel.posts.size) render(); else { renderHead(); renderBadge(); }
  const st = res.status;
  setLamp('intel', st.extract === 'OK' ? (st.pending ? 'busy' : 'ok') : 'warn', st.extract === 'OK' ? `${intel.posts.size} posts in the last 24 h` : st.extract.toLowerCase());
}

async function poll() {
  if (!intel.on) return;
  const mine = ++request;
  try {
    const res = await getJSON(`/api/intel?since=${intel.seq}`);
    if (mine !== request || !intel.on) return;
    if (!res.enabled) return switchOff();              // switched off from another window
    merge(res);
  } catch (e) {
    if (mine !== request) return;
    intel.error = e.message;
    setLamp('intel', 'down', e.message);
    renderHead();
  }
}

async function command(body) {
  const res = await getJSON('/api/intel', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...body, since: intel.seq }) });
  request += 1;                                        // discard any poll already in flight
  return res;
}

function switchOff() {
  intel.on = false;
  clearInterval(timer); timer = null;
  request += 1;
  pulses = [];
  setVisible(false);
  setLamp('intel', '');
  $('#alerts').replaceChildren();
  render();
  emit('intel');
}

export async function setIntel(on) {
  if (on === intel.on) return;
  try {
    await command({ action: on ? 'enable' : 'disable' });
    if (!on) return switchOff();
    intel.on = true;
    intel.loaded = false; intel.posts.clear(); intel.seq = 0;
    setVisible(true);
    merge(await getJSON('/api/intel?since=0'));
    clearInterval(timer);
    timer = setInterval(poll, POLL_MS);
    emit('intel');
  } catch (e) {
    toast(`INTEL: ${e.message}`.toUpperCase(), true, 5000);
  }
}

// ---------------------------------------------------------------- alerts

function beep() {
  try {
    const ctx = beep.ctx || (beep.ctx = new (window.AudioContext || window.webkitAudioContext)());
    [[880, 0], [660, 0.16]].forEach(([freq, at]) => {
      const osc = ctx.createOscillator(), gain = ctx.createGain();
      osc.type = 'square'; osc.frequency.value = freq;
      gain.gain.setValueAtTime(0.05, ctx.currentTime + at);
      gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + at + 0.14);
      osc.connect(gain).connect(ctx.destination);
      osc.start(ctx.currentTime + at); osc.stop(ctx.currentTime + at + 0.15);
    });
  } catch { /* audio not available until the page has been clicked */ }
}

function raise(posts) {
  posts.sort((a, b) => b.t - a.t);
  for (const p of posts) alerted.add(p.k);
  const shown = posts.filter((p) => inScope(p) && !intel.hidden.has(catOf(p)));
  if (!shown.length) return;
  const until = Date.now() + ALERT_MS;
  for (const p of shown) for (const pl of mapped(p).slice(0, 1)) pulses.push({ lon: pl.lon, lat: pl.lat, until });
  startPulse();
  if ($('#pane-intel').hidden || document.hidden) intel.unseen += shown.length;   // the feed itself marks new rows when it is in view
  if (!intel.alerts) return;
  if (intel.sound) beep();
  const box = $('#alerts');
  for (const p of shown.slice(0, 3)) {
    const def = CATS[catOf(p)];
    const card = h('button', { class: 'alert', style: { '--c': def.color }, title: 'Show on the globe',
      onclick: () => { card.remove(); focusPost(p.k); } },
    h('img', { src: iconUrl[catOf(p)], alt: '' }),
    h('span', { class: 'a-head' }, `NEW REPORT  ${def.label}  ${mapped(p)[0].name}`),
    h('span', { class: 'a-body' }, p.sum || p.x));
    box.prepend(card);
    setTimeout(() => card.remove(), 25000);
  }
  if (shown.length > 3) toast(`${shown.length - 3} MORE NEW REPORTS IN THE INTEL FEED`);
  while (box.children.length > 4) box.lastChild.remove();
}

function startPulse() {
  if (pulseFrame) return;
  const step = () => {
    const now = Date.now();
    pulses = pulses.filter((p) => p.until > now);
    setData('cy-intel-pulse', pulses.map((p) => ({ type: 'Feature', geometry: { type: 'Point', coordinates: [p.lon, p.lat] }, properties: {} })));
    if (!pulses.length || !intel.on) { pulseFrame = 0; return; }
    const phase = (now % 1400) / 1400;
    map.setPaintProperty('cy-intel-pulse', 'circle-radius', 12 + 26 * phase);
    map.setPaintProperty('cy-intel-pulse', 'circle-stroke-opacity', 0.95 * (1 - phase));
    pulseFrame = setTimeout(step, 70);
  };
  pulseFrame = setTimeout(step, 0);
}

// ---------------------------------------------------------------- globe interaction

export function intelAt(point) {
  if (!intel.on) return null;
  const pad = 9;
  const hit = map.queryRenderedFeatures([[point.x - pad, point.y - pad], [point.x + pad, point.y + pad]], { layers: ['cy-intel'] });
  if (!hit.length) return null;
  hit.sort((a, b) => a.properties.age - b.properties.age);
  return hit[0];
}

const placeLine = (pl) => [pl.name, pl.admin, pl.cc].filter(Boolean).join(', ');
const ago = (t) => {
  const m = Math.max(0, Math.round((Date.now() - t) / 60000));
  return m < 60 ? `${m} MIN AGO` : `${Math.floor(m / 60)} H ${String(m % 60).padStart(2, '0')} MIN AGO`;
};

export function describeSite(feature) {
  const s = sites.get(feature.properties.id);
  if (!s) return { title: 'REPORT', sub: '' };
  const top = s.posts[0];
  return {
    title: `${CATS[catOf(top)].label}  ${s.place.name}`,
    sub: `${s.posts.length > 1 ? `${s.posts.length} REPORTS, NEWEST ` : ''}${hms(top.t).slice(0, 5)}Z  ${ago(top.t)}`,
  };
}

function precisionTag(pl) {
  return h('span', { class: 'tag' + (pl.approx ? ' amber' : ''), title: pl.approx
    ? 'Not found in the gazetteer: position is the language model\'s estimate'
    : 'How precisely the report could be placed' }, pl.approx ? `${PREC[pl.prec]} (ESTIMATE)` : PREC[pl.prec]);
}

function postDetail(p, place, back) {
  const def = CATS[catOf(p)], ch = channelOf(p.ch);
  const link = `https://t.me/${p.ch}/${p.id}`;
  const original = h('div', { class: 'i-orig', dir: 'auto' }, p.len > p.x.length ? `${p.x}…` : p.x);
  if (p.len > p.x.length) {
    getJSON(`/api/intel/post?k=${encodeURIComponent(p.k)}`).then((r) => { original.textContent = r.text; }, () => {});
  }
  const pt = place ? [place.lon, place.lat] : null;
  const firms = h('div', { class: 'i-note' });
  const checkFirms = async (btn) => {
    btn.disabled = true; firms.textContent = 'CHECKING FIRMS…';
    const dy = 0.09, dx = dy / Math.max(0.2, Math.cos((place.lat * Math.PI) / 180));
    try {
      const m = await getJSON(`/api/firms?win=24h&src=all&meta=1&bbox=${[place.lon - dx, place.lat - dy, place.lon + dx, place.lat + dy].map((v) => v.toFixed(3)).join(',')}`);
      firms.replaceChildren(m.total ? `${m.total} THERMAL DETECTION${m.total > 1 ? 'S' : ''} WITHIN 10 KM IN THE LAST 24 H. ` : 'NO THERMAL DETECTIONS WITHIN 10 KM IN THE LAST 24 H.',
        m.total ? h('a', { href: '#', onclick: (e) => { e.preventDefault(); setFirms({ on: true, win: '24h' }); } }, 'SHOW ON BOARD') : '');
      firms.classList.toggle('amber', m.total > 0);
    } catch (e) { firms.textContent = `FIRMS UNAVAILABLE: ${e.message}`; }
  };
  return [
    h('div', { class: 'panel-head' }, h('span', { style: { color: def.color } }, back ? h('a', { href: '#', class: 'back', onclick: (e) => { e.preventDefault(); back(); } }, '< ') : '', `REPORTED ${def.label}`),
      h('button', { class: 'x', onclick: closePicker }, 'X')),
    h('div', { class: 'panel-body' },
      h('div', { class: 'i-sum' }, p.sum || (p.st === 'new' || p.st === 'busy' ? 'Awaiting analysis.' : 'No summary available.')),
      h('dl', { class: 'facts' },
        h('dt', null, 'SOURCE'), h('dd', null, h('a', { href: link, target: '_blank', rel: 'noopener noreferrer' }, ch ? ch.title : p.ch), p.fwd ? ` (FWD: ${p.fwd})` : ''),
        h('dt', null, 'POSTED'), h('dd', { class: 'num' }, `${stamp(p.t)}  ${ago(p.t)}`),
        place ? [h('dt', null, 'PLACE'), h('dd', null, placeLine(place), ' ', precisionTag(place))] : [h('dt', null, 'PLACE'), h('dd', { class: 'muted' }, p.st === 'done' ? 'NOT LOCATED' : 'NOT YET LOCATED')],
        place ? [h('dt', null, 'POSITION'), h('dd', { class: 'num' }, fmtPos(pt, 4))] : '',
        p.conf ? [h('dt', null, 'CONFIDENCE'), h('dd', null, `${p.conf} (MODEL'S OWN RATING)`)] : '',
        p.places.length > 1 ? [h('dt', null, 'ALSO NAMES'), h('dd', null, p.places.filter((x) => x !== place).map((x) => x.name).join('; '))] : ''),
      p.thumb ? h('div', { class: 'i-media blurred', title: 'Media may be graphic. Click to reveal.', onclick: (e) => e.currentTarget.classList.remove('blurred') },
        h('img', { src: p.thumb, alt: '', referrerpolicy: 'no-referrer', loading: 'lazy' }), h('span', null, p.media === 'video' ? 'VIDEO FRAME: CLICK TO REVEAL' : 'IMAGE: CLICK TO REVEAL')) : '',
      h('details', { open: !p.sum }, h('summary', null, 'ORIGINAL POST'), original,
        h('div', { class: 'links' }, h('a', { href: link, target: '_blank', rel: 'noopener noreferrer' }, 'OPEN IN TELEGRAM'),
          h('a', { href: '#', title: 'Sends the post text to Google Translate', onclick: (e) => { e.preventDefault(); window.open(`https://translate.google.com/?sl=auto&tl=en&op=translate&text=${encodeURIComponent(original.textContent.slice(0, 4500))}`, '_blank', 'noopener'); } }, 'TRANSLATE (GOOGLE)'))),
      h('div', { class: 'i-note' }, 'UNVERIFIED REPORT. PLACE AND CATEGORY WERE EXTRACTED AUTOMATICALLY.'),
      firms),
    pt ? h('div', { class: 'btnrow' },
      h('button', { class: 'primary', title: 'Search imagery of this place with the selected fleet', onclick: () => { closePicker(); setTarget(pt); toast(`FOCUS DESIGNATED ${fmtPos(pt, 3)}`); } }, 'DESIGNATE FOCUS'),
      h('button', { title: 'Move the board clock to the time of the post', onclick: () => { closePicker(); clock.set(p.t); } }, 'CLOCK TO'),
      HOT.includes(catOf(p)) && place.prec !== 'region' ? h('button', { title: 'Look for NASA FIRMS thermal detections near this place', onclick: (e) => checkFirms(e.currentTarget) }, 'FIRMS') : '') : '',
  ];
}

function show(nodes, x, y) {
  const el = $('#picker');
  el.classList.add('wide');
  el.replaceChildren(...nodes.flat(Infinity).filter(Boolean));
  placePicker(x, y);
}

/** Open the card for one site: the report itself, or a list when several share the place. */
export function openSite(key, x, y, postKey) {
  const s = sites.get(key);
  if (!s) return;
  intel.unseen = 0; renderBadge();
  const list = () => show([
    h('div', { class: 'panel-head' }, h('span', null, `${s.posts.length} REPORTS  ${s.place.name}`), h('button', { class: 'x', onclick: closePicker }, 'X')),
    h('div', { class: 'i-place' }, placeLine(s.place), ' ', precisionTag(s.place)),
    h('div', { class: 'panel-body' }, s.posts.slice(0, 60).map((p) => feedRow(p, () => show(postDetail(p, s.place, list), x, y)))),
  ], x, y);
  const one = postKey ? s.posts.find((p) => p.k === postKey) : s.posts.length === 1 ? s.posts[0] : null;
  if (one) show(postDetail(one, s.place, s.posts.length > 1 ? list : null), x, y); else list();
}

/** Fly to a post and open its card. Unplaced posts open beside the panel. */
function focusPost(k) {
  const p = intel.posts.get(k);
  if (!p) return;
  intel.unseen = 0; renderBadge();
  const pl = mapped(p)[0];
  if (!pl) {
    const r = $('#roster').getBoundingClientRect();
    return show(postDetail(p, null, null), r.right, r.top + 60);
  }
  const key = `${pl.lat.toFixed(4)},${pl.lon.toFixed(4)}`;
  const zoom = Math.max(map.getZoom(), pl.prec === 'region' ? 5.5 : pl.prec === 'district' ? 7 : 8.5);
  const open = () => { const pt = map.project([pl.lon, pl.lat]); const box = map.getCanvas().getBoundingClientRect(); openSite(key, box.left + pt.x, box.top + pt.y, k); };
  closePicker();
  map.once('moveend', () => setTimeout(open, 60));
  map.flyTo({ center: [pl.lon, pl.lat], zoom, duration: 1400 });
}

// ---------------------------------------------------------------- Intel tab

function feedRow(p, onclick) {
  const def = CATS[catOf(p)], ch = channelOf(p.ch), pl = mapped(p)[0];
  const waiting = p.st === 'new' || p.st === 'busy';
  return h('div', { class: 'irow' + (pl ? '' : ' unplaced') + (alerted.has(p.k) && Date.now() - p.t < 30 * 60000 ? ' new' : ''), style: { '--c': def.color }, onclick },
    h('img', { src: iconUrl[catOf(p)], alt: def.label, title: def.label }),
    h('span', { class: 'when' }, `${hms(p.t).slice(0, 5)}Z`),
    h('span', { class: 'src' }, ch ? ch.title : p.ch),
    h('span', { class: 'sum', dir: 'auto' }, p.sum || p.x),
    h('span', { class: 'where' }, pl ? `${pl.name}${p.places.length > 1 ? ` +${p.places.length - 1}` : ''}` : waiting ? 'AWAITING ANALYSIS' : p.places.length ? `${p.places[0].name} (COUNTRY ONLY)` : 'NOT LOCATED'));
}

function renderBadge() {
  $('#intel-badge').textContent = intel.unseen ? String(intel.unseen) : '';
  $('#tab-intel').classList.toggle('alerting', intel.unseen > 0);
  document.title = `${intel.unseen ? `(${intel.unseen}) ` : ''}CHEYENNE // EO Tracking Board`;
}

function renderHead() {
  const st = intel.status, posts = [...intel.posts.values()];
  const placed = posts.filter(isPlaced).length;
  const money = (v) => `$${v.toFixed(2)}`;
  const notes = [];
  if (intel.on && intel.error) notes.push(h('div', { class: 'ov-note red' }, `SERVER UNREACHABLE: ${intel.error}`));
  else if (intel.on && st) {
    notes.push(h('div', { class: 'ov-note' }, `${intel.channels.filter((c) => !c.muted).length} CHANNELS  ${posts.length} POSTS / 24 H  ${placed} PLACED`));
    if (st.extract !== 'OK') notes.push(h('div', { class: 'ov-note amber' }, `PLACE EXTRACTION: ${st.extract}`));
    else if (st.pending || st.backfilling) notes.push(h('div', { class: 'ov-note amber' }, st.backfilling ? `RETRIEVING THE LAST 24 H… ${st.pending} TO ANALYSE` : `ANALYSING ${st.pending} POST${st.pending > 1 ? 'S' : ''}…`));
    notes.push(h('div', { class: 'ov-note', title: `Estimated from token counts for ${st.model}. This month: ${money(st.spendMonth)}` }, `SPEND TODAY ${money(st.spendToday)} OF ${money(st.budget)}`));
  } else if (!intel.on) notes.push(h('div', { class: 'ov-note' }, 'OFF. NOTHING IS FETCHED OR SPENT.'));
  $('#intel-head').replaceChildren(
    h('div', { class: 'row-c ov-head' + (intel.on ? '' : ' off'), style: { '--c': RED }, title: 'Follow public Telegram channels and plot what they report', onclick: () => setIntel(!intel.on) },
      h('button', { class: 'lampbtn' + (intel.on ? ' lit' : ''), 'aria-pressed': String(intel.on), onclick: (e) => { e.stopPropagation(); setIntel(!intel.on); } }),
      h('span', { class: 'nm' }, 'TELEGRAM MONITOR'),
      h('span', { class: 'tag' }, intel.on ? 'LIVE' : 'OFF')),
    h('div', { class: 'ov-body' }, notes));
}

function scopeSelect() {
  const groups = [...new Set(intel.channels.map((c) => c.group))];
  const sel = h('select', { 'aria-label': 'Channels shown', onchange: (e) => { intel.scope = e.target.value; rebuild(); renderBody(); } },
    h('option', { value: 'all' }, 'ALL CHANNELS'),
    groups.map((g) => h('option', { value: `g:${g}` }, `GROUP: ${g}`)),
    intel.channels.filter((c) => !c.muted).map((c) => h('option', { value: `c:${c.name}` }, c.title)));
  sel.value = intel.scope;
  if (sel.value !== intel.scope) { intel.scope = 'all'; sel.value = 'all'; }
  return sel;
}

function renderFeed() {
  const all = [...intel.posts.values()].filter(inScope);
  const counts = {};
  for (const p of all) counts[catOf(p)] = (counts[catOf(p)] || 0) + 1;
  const rows = all.filter((p) => !intel.hidden.has(catOf(p)) && (intel.show === 'all' || (intel.show === 'placed') === isPlaced(p)))
    .sort((a, b) => b.t - a.t);
  const seg = (val, label) => h('button', { class: intel.show === val ? 'on' : '', onclick: () => { intel.show = val; renderBody(); } }, label);
  return [
    h('div', { class: 'i-filters' },
      scopeSelect(),
      h('div', { class: 'seg' }, seg('all', 'ALL'), seg('placed', 'PLACED'), seg('unplaced', 'UNPLACED')),
      h('div', { class: 'i-cats' }, Object.entries(CATS).map(([cat, def]) => h('button', {
        class: intel.hidden.has(cat) ? 'off' : '', title: `${def.label}: ${counts[cat] || 0}. Click to ${intel.hidden.has(cat) ? 'show' : 'hide'}.`,
        onclick: () => { if (intel.hidden.has(cat)) intel.hidden.delete(cat); else intel.hidden.add(cat); rebuild(); renderBody(); },
      }, h('img', { src: iconUrl[cat], alt: def.label }))))),
    rows.length ? rows.slice(0, FEED_ROWS).map((p) => feedRow(p, () => focusPost(p.k)))
      : h('div', { class: 'note' }, intel.loaded ? 'NO POSTS MATCH.' : 'LOADING…'),
    rows.length > FEED_ROWS ? h('div', { class: 'note' }, `NEWEST ${FEED_ROWS} OF ${rows.length} SHOWN. NARROW THE FILTER TO SEE OLDER POSTS.`) : '',
  ];
}

function renderChannels() {
  const act = async (body, done) => {
    try { merge(await command(body)); if (done) done(); } catch (e) { toast(e.message.toUpperCase(), true, 5000); }
  };
  const groups = [...new Set(intel.channels.map((c) => c.group))];
  const name = h('input', { type: 'text', placeholder: '@CHANNEL OR T.ME LINK', spellcheck: 'false', 'aria-label': 'Channel to follow' });
  const group = h('input', { type: 'text', placeholder: 'GROUP', list: 'intel-groups', 'aria-label': 'Group', value: groups[0] || '' });
  const budget = h('input', { type: 'text', inputmode: 'decimal', value: intel.status ? intel.status.budget.toFixed(2) : '', 'aria-label': 'Daily budget in US dollars' });
  return [
    h('div', { class: 'btnrow' }, h('button', { class: 'wide', title: 'Choose which of the starting channel groups to follow', onclick: openGroups }, 'CHOOSE CHANNEL GROUPS')),
    h('form', { class: 'i-add', onsubmit: (e) => { e.preventDefault(); if (name.value.trim()) act({ action: 'add', name: name.value, group: group.value }, () => toast('CHANNEL ADDED')); } },
      name, h('label', null, 'GROUP'), group, h('datalist', { id: 'intel-groups' }, groups.map((g) => h('option', { value: g }))), h('button', { class: 'primary' }, 'FOLLOW')),
    groups.map((g) => h('div', { class: 'grp' },
      h('div', { class: 'grp-head' }, h('b', null, g), h('span', null, 'POSTS / 24 H')),
      intel.channels.filter((c) => c.group === g).map((c) => h('div', { class: 'row-c ichan' + (c.muted ? ' off' : ''), style: { '--c': c.error ? '#ff453a' : '#8ff5dd' },
        title: `@${c.name}${c.error ? ` – ${c.error}` : ''}`, onclick: () => { intel.scope = `c:${c.name}`; intel.view = 'feed'; rebuild(); render(); } },
      h('button', { class: 'lampbtn' + (c.muted ? '' : ' lit'), title: c.muted ? 'Resume following' : 'Pause this channel', 'aria-pressed': String(!c.muted),
        onclick: (e) => { e.stopPropagation(); act({ action: c.muted ? 'unmute' : 'mute', name: c.name }); } }),
      h('span', { class: 'nm' }, c.title),
      c.error ? h('span', { class: 'tag red' }, c.error.slice(0, 14)) : h('span', { class: 'ct' }, c.count),
      h('button', { class: 'x', title: 'Stop following and delete its posts', onclick: (e) => { e.stopPropagation(); if (confirm(`Stop following @${c.name} and delete its stored posts?`)) act({ action: 'remove', name: c.name }); } }, 'X'))))),
    h('form', { class: 'i-budget', onsubmit: (e) => { e.preventDefault(); act({ action: 'budget', value: parseFloat(budget.value) }, () => toast('DAILY BUDGET SET')); } },
      h('label', null, 'DAILY BUDGET $'), budget, h('button', null, 'SET')),
    h('div', { class: 'note' }, 'Channels are read from their public web preview while the monitor is on: busy channels every minute, quiet ones every 3 to 10 minutes. Place extraction stops for the day when the budget is reached.'),
  ];
}

function renderBody() {
  const body = $('#intel-body');
  const keep = body.scrollTop;
  if (!intel.on) {
    body.replaceChildren(h('div', { class: 'note' }, 'Switch the monitor on to follow public Telegram channels. Posts from the last 24 hours are placed on the globe where they can be located, and new ones raise an alert.'),
      h('div', { class: 'btnrow' }, h('button', { class: 'wide', onclick: openGroups }, 'CHOOSE CHANNEL GROUPS')));
    return;
  }
  if (intel.view === 'feed' && intel.loaded && !intel.channels.some((c) => !c.muted)) {
    body.replaceChildren(h('div', { class: 'note' }, 'No channels are being followed.'),
      h('div', { class: 'btnrow' }, h('button', { class: 'primary wide', onclick: openGroups }, 'CHOOSE CHANNEL GROUPS')));
    return;
  }
  body.replaceChildren(...(intel.view === 'feed' ? renderFeed() : renderChannels()).flat(Infinity).filter(Boolean));
  body.scrollTop = keep;
}

function render() {
  renderHead();
  renderBadge();
  $('#intel-tabs').hidden = !intel.on;
  $('#intel-tabs').replaceChildren(...[['feed', 'FEED'], ['channels', 'CHANNELS']].map(([v, label]) =>
    h('button', { class: intel.view === v ? 'on' : '', onclick: () => { intel.view = v; render(); } }, label)));
  // Typing in the channel form must not be wiped by the periodic refresh.
  const typing = intel.view === 'channels' && $('#intel-body').contains(document.activeElement) && document.activeElement.tagName === 'INPUT';
  if (!typing) renderBody();
  const toggle = (key, label, title) => h('button', { class: intel[key] ? 'on' : '', title, onclick: () => { intel[key] = !intel[key]; prefs.save(); if (key === 'sound' && intel.sound) beep(); render(); } }, label);
  $('#intel-foot').replaceChildren(h('div', { class: 'seg' }, toggle('alerts', 'ALERT CARDS', 'Show a card when a new located report arrives'), toggle('sound', 'SOUND', 'Play a tone with each alert')),
    h('div', { class: 'i-legend' }, 'DASHED RING: PLACED ONLY TO A DISTRICT OR REGION, OR AN ESTIMATE.'));
}

// ---------------------------------------------------------------- channel groups (start-up prompt)

let modalKeys = null;

function closeModal() {
  $('#modal').hidden = true;
  $('#modal').replaceChildren();
  if (modalKeys) { document.removeEventListener('keydown', modalKeys); modalKeys = null; }
}

/** Ask which of the starting channel groups to follow. */
export async function openGroups() {
  let info;
  try { info = await getJSON('/api/intel/groups'); } catch (e) { toast(`INTEL: ${e.message}`.toUpperCase(), true, 5000); return; }
  const chosen = new Set(info.groups.filter((g) => g.selected).map((g) => g.id));
  let ask = info.ask;
  const money = (v) => `$${v.toFixed(2)}`;
  const total = h('div', { class: 'g-total' });
  const paintTotal = () => {
    const posts = info.groups.filter((g) => chosen.has(g.id)).reduce((a, g) => a + g.est, 0);
    const cost = posts * info.costPerPost;
    total.replaceChildren(
      h('span', null, chosen.size ? `${chosen.size} GROUP${chosen.size > 1 ? 'S' : ''}  ${chosen.size * 10} CHANNELS  ABOUT ${posts.toLocaleString('en')} POSTS A DAY` : 'NO GROUPS SELECTED'),
      h('span', { class: cost > info.budget ? 'amber' : 'muted' }, chosen.size ? `ANALYSIS ABOUT ${money(cost)} A DAY, CAPPED AT ${money(info.budget)}${cost > info.budget ? ': RAISE THE BUDGET IN THE CHANNELS VIEW' : ''}` : ''));
  };
  const card = (g) => {
    const lamp = h('button', { class: 'lampbtn' + (chosen.has(g.id) ? ' lit' : ''), 'aria-pressed': String(chosen.has(g.id)), 'aria-label': `Follow ${g.label}` });
    const el = h('div', { class: 'g-card' + (chosen.has(g.id) ? ' on' : '') },
      h('div', { class: 'g-top', onclick: () => {
        if (chosen.has(g.id)) chosen.delete(g.id); else chosen.add(g.id);
        el.classList.toggle('on', chosen.has(g.id));
        lamp.classList.toggle('lit', chosen.has(g.id));
        lamp.setAttribute('aria-pressed', String(chosen.has(g.id)));
        paintTotal();
      } }, lamp, h('b', null, g.label), h('span', { class: 'ct' }, `~${g.est} / DAY`)),
      h('div', { class: 'g-note' }, g.note),
      h('details', null, h('summary', null, `${g.channels.length} CHANNELS`),
        h('div', { class: 'g-chans' }, g.channels.map((c) => h('a', { href: `https://t.me/s/${c.name}`, target: '_blank', rel: 'noopener noreferrer', title: `@${c.name}` }, c.title)))));
    return el;
  };
  const confirm = async () => {
    try {
      const res = await command({ action: 'groups', groups: [...chosen], ask });
      closeModal();
      if (chosen.size && !intel.on) { await setIntel(true); showTab('intel'); }
      else if (intel.on) merge(res);
      toast(chosen.size ? `FOLLOWING ${chosen.size} CHANNEL GROUP${chosen.size > 1 ? 'S' : ''}` : 'CHANNEL GROUPS PAUSED');
    } catch (e) { toast(e.message.toUpperCase(), true, 5000); }
  };
  const later = async () => {
    closeModal();
    if (ask !== info.ask) { try { await command({ action: 'ask', value: ask }); } catch { /* keep going */ } }
  };
  const askBox = h('input', { type: 'checkbox', id: 'g-ask', checked: ask, onchange: (e) => { ask = e.target.checked; } });
  const box = $('#modal');
  box.replaceChildren(h('div', { class: 'modal-box panel', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'g-title' },
    h('div', { class: 'panel-head' }, h('span', { id: 'g-title' }, 'INTEL // CHANNEL GROUPS'), h('button', { class: 'x', title: 'Close without changes', onclick: later }, 'X')),
    h('div', { class: 'panel-body' },
      h('p', { class: 'g-intro' }, 'Choose which groups of public Telegram channels to follow. New posts are read from each channel\'s public web preview, placed on the map by a language model and listed in the Intel tab. Each group mixes official, independent, partisan and state-run sources; nothing is verified.'),
      info.custom ? h('p', { class: 'g-intro muted' }, `${info.custom} channel${info.custom > 1 ? 's' : ''} you added yourself ${info.custom > 1 ? 'are' : 'is'} not affected.`) : '',
      h('div', { class: 'g-grid' }, info.groups.map(card))),
    h('div', { class: 'g-foot' },
      total,
      h('div', { class: 'g-actions' },
        h('label', { class: 'g-ask', for: 'g-ask' }, askBox, 'ASK WHEN THE BOARD OPENS'),
        h('button', { onclick: () => { const all = chosen.size < info.groups.length; info.groups.forEach((g) => (all ? chosen.add(g.id) : chosen.delete(g.id))); openGroupsRepaint(); } }, 'ALL / NONE'),
        h('button', { onclick: later }, 'NOT NOW'),
        h('button', { class: 'primary', onclick: confirm }, 'FOLLOW SELECTED')))));
  const openGroupsRepaint = () => {
    box.querySelectorAll('.g-card').forEach((el, i) => {
      const on = chosen.has(info.groups[i].id);
      el.classList.toggle('on', on);
      const lamp = el.querySelector('.lampbtn');
      lamp.classList.toggle('lit', on); lamp.setAttribute('aria-pressed', String(on));
    });
    paintTotal();
  };
  paintTotal();
  box.hidden = false;
  if (modalKeys) document.removeEventListener('keydown', modalKeys);
  modalKeys = (e) => { if (e.key === 'Escape') later(); };
  document.addEventListener('keydown', modalKeys);
  box.querySelector('.g-actions .primary').focus();
}

function showTab(which) {
  for (const t of ['assets', 'intel']) {
    $(`#tab-${t}`).classList.toggle('on', t === which);
    $(`#pane-${t}`).hidden = t !== which;
  }
  if (which === 'intel') { intel.unseen = 0; renderBadge(); }
}

export async function initIntel() {
  prefs.load();
  addLayers();
  setVisible(false);
  $('#tab-assets').addEventListener('click', () => showTab('assets'));
  $('#tab-intel').addEventListener('click', () => showTab('intel'));
  document.addEventListener('visibilitychange', () => { if (!document.hidden && !$('#pane-intel').hidden) { intel.unseen = 0; renderBadge(); } });
  render();
  setInterval(() => { if (intel.on) { rebuild(); if (intel.view === 'feed') renderHead(); } }, 5 * 60000);   // age the markers
  try {
    const res = await getJSON('/api/intel?peek=1&since=999999999');
    if (res.enabled) { await setIntel(true); showTab('intel'); }
  } catch { /* an older server without Intel: the tab simply stays off */ }
  // Ask which channel groups to follow, unless that has been switched off.
  try {
    const info = await getJSON('/api/intel/groups');
    if (info.ask) setTimeout(openGroups, 600);
  } catch { /* no group catalogue on this server */ }
}
