// Turns state into board graphics: satellite plots, ground tracks, sensor swaths,
// footprints, highlights and the area-of-interest marker.

import { S, clock } from './state.js';
import { map, setData, updateNight } from './globe.js';
import { fleet, locate, groundTrack, sensorBars, swathRibbon, fixedSwath } from './tracker.js';
import { fmtPos } from './util.js';

const LABELLED_GROUPS = new Set(['open', 'daily']);
const TRACK_LIMIT = 12;          // draw every track of a constellation only up to this size
const RIBBON_LIMIT = 8;

export const live = new Map();   // NORAD id -> last computed position

export function plotSats(now) {
  const feats = [];
  for (const sat of fleet.sats) {
    if (!S.visible.has(sat.cid)) continue;
    const p = locate(sat, now);
    if (!p) continue;
    live.set(sat.id, p);
    const con = S.cons.get(sat.cid);
    const act = sat.cid === S.active;
    const sel = sat.id === S.selSat;
    feats.push({
      type: 'Feature', geometry: { type: 'Point', coordinates: [p.lon, p.lat] },
      properties: {
        id: sat.id, cid: sat.cid, label: sat.short, color: con.color, act, sel,
        lab: sel || act || (!S.active && LABELLED_GROUPS.has(con.group)),
        dim: !!S.active && !act && !sel,
      },
    });
  }
  setData('cy-sats', feats);
  return feats.length;
}

function trackedSats() {
  const list = [];
  const active = S.active ? (fleet.byCons.get(S.active) || []) : [];
  if (active.length <= TRACK_LIMIT) list.push(...active);
  const sel = S.selSat && fleet.byId.get(S.selSat);
  if (sel && !list.includes(sel)) list.push(sel);
  return list;
}

export function plotTracks(now) {
  const feats = [];
  for (const sat of trackedSats()) {
    const color = S.cons.get(sat.cid).color;
    const period = sat.periodMin * 60000;
    const step = Math.max(10000, period / 240);
    for (const [phase, a, b] of [['past', now - period * 0.35, now], ['next', now, now + period * 1.02]]) {
      for (const line of groundTrack(sat, a, b, step)) {
        feats.push({ type: 'Feature', properties: { phase, color, id: sat.id }, geometry: { type: 'LineString', coordinates: line } });
      }
    }
  }
  setData('cy-tracks', feats);
}

export function plotSwaths(now) {
  const feats = [];
  const active = S.active ? (fleet.byCons.get(S.active) || []) : [];
  const sel = S.selSat && fleet.byId.get(S.selSat);
  const list = active.length ? [...active] : [];
  if (sel && !list.includes(sel)) list.push(sel);
  for (const sat of list) {
    const con = S.cons.get(sat.cid);
    const fixed = fixedSwath(con.geom);
    for (const [a, b] of sensorBars(sat, con.geom, now)) {
      if (Math.abs(a[0] - b[0]) > 180) continue;                     // bar straddles the antimeridian
      feats.push({ type: 'Feature', properties: { color: con.color, reach: !fixed }, geometry: { type: 'LineString', coordinates: [a, b] } });
    }
    if (fixed && list.length <= RIBBON_LIMIT) {
      const ribbon = swathRibbon(sat, now - 8 * 60000, now, fixed[0], fixed[1], 30000);
      if (ribbon) feats.push({ type: 'Feature', properties: { color: con.color }, geometry: ribbon });
    }
  }
  setData('cy-swath', feats);
}

export function plotFootprints() {
  // Footprints stack deeply over a point, so only wide-area tasking strips get a tint;
  // everything else is linework and the imagery underneath stays readable.
  const wide = S.resultMeta.aoi && S.resultMeta.aoi.type === 'global';
  setData('cy-foot', S.results.map((r) => ({
    type: 'Feature', geometry: r.geometry,
    properties: { id: r.id, kind: r.kind, color: r.color, past: !!r.past, fo: wide && r.kind === 'planned' && !r.past ? 0.06 : 0 },
  })));
}

export function plotHighlights() {
  const feats = [];
  const byId = (id) => S.results.find((r) => r.id === id) || (S.rendered.get(id) || {}).rec;
  const sel = S.selected && byId(S.selected);
  const hov = S.hovered && S.hovered !== S.selected && byId(S.hovered);
  if (hov) feats.push({ type: 'Feature', properties: { role: 'hover', color: hov.color }, geometry: hov.geometry });
  if (sel) feats.push({ type: 'Feature', properties: { role: 'selected' }, geometry: sel.geometry });
  setData('cy-hl', feats);
}

export function plotAOI(aoi) {
  const box = [];
  if (aoi && aoi.type === 'box' && S.active) {
    const [w, s, e, n] = aoi.bbox;
    const ring = [];
    const N = 24;                                        // densify so edges follow the globe
    for (let i = 0; i <= N; i++) ring.push([w + ((e - w) * i) / N, s]);
    for (let i = 0; i <= N; i++) ring.push([e, s + ((n - s) * i) / N]);
    for (let i = 0; i <= N; i++) ring.push([e - ((e - w) * i) / N, n]);
    for (let i = 0; i <= N; i++) ring.push([w, n - ((n - s) * i) / N]);
    box.push({ type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: ring } });
  }
  setData('cy-aoi', box);
  setData('cy-target', S.target ? [{
    type: 'Feature', geometry: { type: 'Point', coordinates: S.target },
    properties: { label: `FOCUS ${fmtPos(S.target, 2)}` },
  }] : []);
}

// ---------------------------------------------------------------- frame loop

let lastPlot = 0, lastTracks = 0, lastNight = 0, lastTick = 0, dirty = true;

export function invalidate() { dirty = true; }

export function startLoop(onTick) {
  const frame = () => {
    const wall = performance.now();
    const now = clock.now();
    const fast = clock.rate > 1 || map.getZoom() > 6 || S.follow;
    if (dirty || wall - lastPlot > (fast ? 50 : 250)) {
      lastPlot = wall;
      plotSats(now);
      plotSwaths(now);
      if (S.follow && S.selSat && live.has(S.selSat) && !map.isMoving()) {
        const p = live.get(S.selSat);
        map.jumpTo({ center: [p.lon, p.lat] });
      }
    }
    if (dirty || Math.abs(now - lastTracks) > 20000) { lastTracks = now; plotTracks(now); }
    if (dirty || Math.abs(now - lastNight) > 60000) { lastNight = now; updateNight(now); }
    if (wall - lastTick > 500) { lastTick = wall; onTick(now); }
    dirty = false;
    requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);
}
