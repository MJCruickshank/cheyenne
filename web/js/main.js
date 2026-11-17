// Boot sequence and wiring.

import { S, on, emit, clock } from './state.js';
import { initGlobe, map } from './globe.js';
import { loadFleet, fleet } from './tracker.js';
import { startLoop, invalidate, plotFootprints, plotHighlights, plotAOI } from './board.js';
import { initMission, setActive, setTarget } from './mission.js';
import { initTimeline } from './timeline.js';
import { initUI } from './ui.js';
import { initFirms, setFirms, firms } from './firms.js';
import { initIntel, intel } from './intel.js';
import { initAis, setAis, ais } from './ais.js';
import { IMAGERY } from './basemap.js';
import { LIVE } from './live.js';
import { currentAOI } from './archive.js';
import { initLamps, setLamp, bootLine, bootDone } from './hud.js';
import { getJSON, toast } from './util.js';

// ---------------------------------------------------------------- shareable view state in the URL hash

function readHash() {
  const q = new URLSearchParams(location.hash.slice(1));
  const nums = (k, n) => {
    if (!q.get(k)) return null;
    const v = q.get(k).split(',').map(Number);
    return v.length === n && v.every(Number.isFinite) ? v : null;
  };
  const day = (k) => (/^\d{4}-\d{2}-\d{2}$/.test(q.get(k) || '') ? q.get(k) : null);
  return {
    ll: nums('ll', 2), z: nums('z', 1), tgt: nums('tgt', 2), c: q.get('c'), bm: q.get('bm'),
    past: nums('past', 1), ahead: nums('ahead', 1), from: day('from'), to: day('to'), fire: q.get('fire'), ais: q.get('ais'),
  };
}

let hashTimer = null;
function writeHash() {
  clearTimeout(hashTimer);
  hashTimer = setTimeout(() => {
    const c = map.getCenter();
    const q = new URLSearchParams();
    q.set('ll', `${c.lat.toFixed(4)},${c.lng.toFixed(4)}`);
    q.set('z', map.getZoom().toFixed(2));
    if (S.active) q.set('c', S.active);
    if (S.target) q.set('tgt', `${S.target[0]},${S.target[1]}`);
    if (S.basemap === 'imagery') q.set('bm', S.imagery);
    if (S.basemap === 'live') q.set('bm', `live-${S.live}`);
    if (firms.on) q.set('fire', firms.src === 'all' ? firms.win : `${firms.win}-${firms.src}`);
    if (ais.on) q.set('ais', `${ais.ships ? 's' : ''}${ais.cov ? 'c' : ''}` || 'on');
    if (S.custom && S.from && S.to) { q.set('from', S.from); q.set('to', S.to); } else if (S.pastDays !== 7) q.set('past', S.pastDays);
    if (S.futureDays !== 7) q.set('ahead', S.futureDays);
    history.replaceState(null, '', `#${q.toString().replace(/%2C/g, ',')}`);
  }, 300);
}

// ---------------------------------------------------------------- boot

async function boot() {
  initLamps();
  const hash = readHash();

  bootLine('LOADING SATELLITE CATALOGUE');
  S.catalog = await getJSON('catalog.json');
  for (const c of S.catalog.constellations) {
    S.cons.set(c.id, c);
    if (c.defaultVisible) S.visible.add(c.id);
  }
  if (hash.past) S.pastDays = hash.past[0];
  if (hash.ahead) S.futureDays = hash.ahead[0];
  if (hash.from && hash.to) { S.custom = true; S.from = hash.from; S.to = hash.to; }

  bootLine('RAISING BOARD: VECTOR BASEMAP, GLOBE PROJECTION');
  bootLine('ACQUIRING ORBITAL ELEMENTS FROM CELESTRAK');
  setLamp('orbit', 'busy');
  const [, fleetResult] = await Promise.all([
    initGlobe(hash.ll ? { lat: hash.ll[0], lon: hash.ll[1], zoom: hash.z ? hash.z[0] : 5 } : null),
    loadFleet().then(() => null, (e) => e),
  ]);
  if (fleetResult) {
    bootLine(`ORBITAL ELEMENTS UNAVAILABLE: ${fleetResult.message}`, 'bad');
    setLamp('orbit', 'down', fleetResult.message);
  } else {
    bootLine(`${fleet.sats.length} SATELLITES IN ${fleet.byCons.size} FLEETS UNDER TRACK`, 'ok');
    setLamp('orbit', fleet.stale ? 'warn' : 'ok', fleet.stale ? 'using cached elements' : undefined);
  }

  initMission();
  initTimeline();
  initFirms();
  initAis();
  initUI();
  initIntel();

  on('results', () => { plotFootprints(); plotHighlights(); });
  on('selected', plotHighlights);
  on('hovered', plotHighlights);
  on('rendered', plotHighlights);
  on('aoi', () => { plotAOI(S.resultMeta.aoi || currentAOI()); writeHash(); });
  on('active', () => { plotAOI(null); writeHash(); });
  on('basemap', writeHash);
  on('firms', writeHash);
  on('ais', writeHash);
  on('results', () => { plotAOI(S.resultMeta.aoi); writeHash(); });
  map.on('moveend', writeHash);

  startLoop((now) => emit('tick', now));

  if (hash.bm) {
    const live = hash.bm.match(/^live(?:-(\w+))?$/);
    if (live) emit('set-basemap', ['live', LIVE[live[1]] ? live[1] : undefined]);
    else if (hash.bm === 'imagery' || IMAGERY[hash.bm]) emit('set-basemap', ['imagery', IMAGERY[hash.bm] ? hash.bm : 'esri']);
  }
  if (hash.fire) {
    const [win, src] = hash.fire.split('-');
    if (['24h', '48h', '7d'].includes(win)) setFirms({ on: true, win, src: ['viirs', 'modis'].includes(src) ? src : 'all' });
  }
  if (hash.ais) setAis({ on: true, ships: hash.ais.includes('s'), cov: hash.ais.includes('c') });
  if (hash.tgt) { S.target = hash.tgt; S.aoiMode = 'target'; emit('aoi'); }
  if (hash.c && S.cons.has(hash.c)) setActive(hash.c);

  bootLine('BOARD LIVE', 'ok');
  setTimeout(bootDone, fleetResult ? 1800 : 500);
  if (fleetResult) toast('NO ORBITAL ELEMENTS: SATELLITE PLOTS OFFLINE', true, 6000);

  // Handy for debugging from the console.
  window.cheyenne = { S, map, fleet, clock, setActive, setTarget, invalidate, intel, ais };
}

boot().catch((e) => {
  console.error(e);
  bootLine(`BOARD FAILED TO START: ${e.message}`, 'bad');
});
