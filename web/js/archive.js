// Footprint sources: acquired scenes (STAC), tasking plans (ESA), geometric pass prediction.

import { S, clock } from './state.js';
import { map } from './globe.js';
import { PC } from './viz.js';
import { fleet, findPlatform, platformShort, closestApproach, predictPasses } from './tracker.js';
import { DAY, bboxOf, getJSON, clamp } from './util.js';

const iso = (ms) => new Date(ms).toISOString().replace(/\.\d+Z$/, 'Z');

export const BOX_ZOOM = 5.5;          // below this the view is too wide for a box search

/** The area the next scan applies to. */
export function currentAOI() {
  if (S.aoiMode === 'target' && S.target) return { type: 'point', lon: S.target[0], lat: S.target[1] };
  if (map.getZoom() >= BOX_ZOOM) {
    const b = map.getBounds();
    const w = clamp(b.getWest(), -180, 180), e = clamp(b.getEast(), -180, 180);
    const s = clamp(b.getSouth(), -89, 89), n = clamp(b.getNorth(), -89, 89);
    if (e > w && n > s) return { type: 'box', bbox: [w, s, e, n].map((v) => +v.toFixed(4)) };
  }
  return { type: 'global' };
}

export function aoiCentre(aoi) {
  if (aoi.type === 'point') return [aoi.lon, aoi.lat];
  if (aoi.type === 'box') return [(aoi.bbox[0] + aoi.bbox[2]) / 2, (aoi.bbox[1] + aoi.bbox[3]) / 2];
  const c = map.getCenter();
  return [c.lng, c.lat];
}

// ---------------------------------------------------------------- acquired scenes

function sceneRecord(con, f) {
  const p = f.properties;
  const time = Date.parse(p.start_datetime || p.datetime);
  const sub = [];
  let cloud = null;
  if (con.id === 'sentinel-2') {
    cloud = p['eo:cloud_cover'];
    sub.push(`T${p['s2:mgrs_tile']}`, `ORB ${p['sat:relative_orbit']}`);
  } else if (con.id === 'sentinel-1') {
    sub.push(p['sar:instrument_mode'], (p['sar:polarizations'] || []).join('+'), (p['sat:orbit_state'] || '').slice(0, 4).toUpperCase(), `ORB ${p['sat:relative_orbit']}`);
  } else if (con.id === 'landsat') {
    cloud = p['eo:cloud_cover'];
    sub.push(`WRS ${p['landsat:wrs_path']}/${p['landsat:wrs_row']}`, p['landsat:collection_category'] || '');
  }
  return {
    id: f.id, kind: 'scene', cid: con.id, color: con.color, collection: con.archive.collection,
    platform: platformShort(p.platform), sat: findPlatform(p.platform),
    time, end: p.end_datetime ? Date.parse(p.end_datetime) : time,
    geometry: f.geometry, bbox: f.bbox || bboxOf(f.geometry),
    cloud: typeof cloud === 'number' ? cloud : null, sub: sub.filter(Boolean), props: p,
  };
}

export async function searchScenes(con, aoi, t0, t1, cloudMax, signal) {
  let body = {
    collections: [con.archive.collection],
    datetime: `${iso(t0)}/${iso(t1)}`,
    limit: 100,
    fields: { exclude: ['links', 'assets'] },
    sortby: [{ field: 'datetime', direction: 'desc' }],
  };
  if (aoi.type === 'point') body.intersects = { type: 'Point', coordinates: [aoi.lon, aoi.lat] };
  else body.bbox = aoi.bbox;
  const query = {};
  if (con.archive.cloud && cloudMax < 100) query['eo:cloud_cover'] = { lte: cloudMax };
  if (con.archive.platforms) query.platform = { in: con.archive.platforms };
  if (Object.keys(query).length) body.query = query;

  const out = [];
  let truncated = false;
  for (let page = 0; page < 5 && body; page++) {
    const res = await getJSON(`${PC}/stac/v1/search`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal,
    });
    for (const f of res.features || []) out.push(sceneRecord(con, f));
    const next = (res.links || []).find((l) => l.rel === 'next');
    body = next && next.body ? next.body : null;
    if (page === 4 && body) truncated = true;
  }
  return { records: out, truncated };
}

/** Full STAC item (with assets) for one scene. */
export function fetchItem(rec, signal) {
  return getJSON(`${PC}/stac/v1/collections/${rec.collection}/items/${encodeURIComponent(rec.id)}`, { signal });
}

// ---------------------------------------------------------------- tasking plans

export async function fetchPlans(con, aoi, t0, t1, signal) {
  const q = new URLSearchParams({ mission: con.plan, start: Math.round(t0 / 1000), end: Math.round(t1 / 1000) });
  if (aoi.type === 'point') { q.set('lon', aoi.lon); q.set('lat', aoi.lat); }
  if (aoi.type === 'box') q.set('bbox', aoi.bbox.join(','));
  const res = await getJSON(`/api/plans?${q}`, { signal });
  const centre = aoi.type === 'global' ? null : aoiCentre(aoi);
  const now = clock.now();
  const records = res.features.map((f) => {
    const p = f.properties;
    const sat = findPlatform(p.platform);
    const start = Date.parse(p.datetime), end = Date.parse(p.end);
    let time = start, tot = null;
    if (centre && sat) {                                   // refine to time-over-target along the strip
      const ca = closestApproach(sat, centre, start, end);
      if (ca) { time = ca.t; tot = ca.t; }
    }
    const sub = [p.mode, p.pol, p.relOrbit ? `ORB ${p.relOrbit}` : '', `${Math.max(1, Math.round((end - start) / 60000))} MIN STRIP`];
    return {
      id: `plan:${p.id}:${p.datetime}`, kind: 'planned', cid: con.id, color: con.color,
      platform: platformShort(p.platform), sat, time, start, end, tot, past: time < now,
      geometry: f.geometry, bbox: bboxOf(f.geometry), cloud: null, sub: sub.filter(Boolean), props: p,
    };
  });
  return { records, truncated: !!res.truncated, sources: res.sources || [] };
}

// ---------------------------------------------------------------- geometric prediction

export async function predictAccess(con, centre, t0, t1, onProgress) {
  const sats = fleet.byCons.get(con.id) || [];
  const passes = await predictPasses(sats, con.geom, centre, t0, t1, onProgress);
  return passes.filter((p) => p.geometry).map((p) => ({
    id: `pred:${p.sat.id}:${Math.round(p.time / 1000)}`, kind: 'predicted', cid: con.id, color: con.color,
    platform: p.sat.short, sat: p.sat, time: p.time, start: p.time - 60000, end: p.time + 60000, tot: p.time, past: false,
    geometry: p.geometry, bbox: bboxOf(p.geometry), cloud: null,
    sub: [
      p.ascending ? 'ASC' : 'DESC',
      con.geom.mode === 'agile' ? `OFF-NADIR ${p.offNadir.toFixed(0)}° ${p.crossKm >= 0 ? 'R' : 'L'}` : `${Math.abs(p.crossKm).toFixed(0)} KM ${p.crossKm >= 0 ? 'R' : 'L'} OF TRACK`,
      `SUN ${p.sunEl >= 0 ? '+' : ''}${p.sunEl.toFixed(0)}°`,
    ],
    props: { offNadir: p.offNadir, crossKm: p.crossKm, sunEl: p.sunEl, ascending: p.ascending },
  }));
}

