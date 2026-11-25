// Footprint sources: acquired scenes (STAC), tasking plans (ESA), geometric pass prediction.

import { S, clock } from './state.js';
import { map } from './globe.js';
import { PC } from './viz.js';
import { fleet, findPlatform, platformShort, closestApproach, predictPasses } from './tracker.js';
import { DAY, bboxOf, getJSON, clamp, pointInGeom } from './util.js';

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

/** Scenes already acquired over the area, from whichever archive the fleet uses. */
export async function searchScenes(con, aoi, t0, t1, cloudMax, signal) {
  if (con.archive.provider === 'opendata') return searchOpenData(con, aoi, signal);
  if (con.archive.provider === 'asf') return searchNisar(con, aoi, t0, t1, signal);
  return searchPC(con, aoi, t0, t1, cloudMax, signal);
}

async function searchPC(con, aoi, t0, t1, cloudMax, signal) {
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

// ---------------------------------------------------------------- open commercial releases (server index)

/** Readable event name: "Nepal-Flooding-Aug-2026" -> "NEPAL FLOODING AUG 2026". */
export function eventName(ev) {
  return (ev.title || ev.id).replace(/^Planet Crisis Response\s*[—-]\s*/i, '').replace(/[-_]+/g, ' ').toUpperCase();
}

async function searchOpenData(con, aoi, signal) {
  const q = new URLSearchParams({ src: con.archive.sources.join(',') });
  if (aoi.type === 'point') q.set('bbox', [aoi.lon - 0.005, aoi.lat - 0.005, aoi.lon + 0.005, aoi.lat + 0.005].join(','));
  else if (aoi.type === 'box') q.set('bbox', aoi.bbox.join(','));
  const res = await getJSON(`/api/opendata?${q}`, { signal });
  const events = new Map(res.events.map((ev) => [ev.id, ev]));
  let scenes = res.scenes;
  if (aoi.type === 'point') scenes = scenes.filter((sc) => pointInGeom([aoi.lon, aoi.lat], sc.geom));
  const records = scenes.map((sc) => {
    const ev = events.get(sc.ev);
    return {
      id: sc.id, kind: 'scene', cid: con.id, color: con.color, collection: 'opendata',
      platform: sc.plat, sat: null, time: sc.t, end: sc.t, geometry: sc.geom, bbox: sc.bbox,
      cloud: typeof sc.cloud === 'number' ? sc.cloud : null,
      sub: [sc.phase ? `${sc.phase.toUpperCase()}-EVENT` : null, sc.gsd ? `${sc.gsd} M` : null, ev ? eventName(ev).slice(0, 28) : null].filter(Boolean),
      props: { ...sc, event: ev || null },
    };
  });
  return { records, truncated: !!res.truncated, events: res.events, sources: res.sources };
}

// ---------------------------------------------------------------- NISAR (Alaska Satellite Facility)

const ASF = 'https://api.daac.asf.alaska.edu/services/search/param';

async function searchNisar(con, aoi, t0, t1, signal) {
  const q = new URLSearchParams({
    dataset: 'NISAR', processingLevel: 'GCOV', start: iso(t0), end: iso(Math.min(t1, Date.now())), maxResults: '250', output: 'geojson',
  });
  if (aoi.type === 'point') q.set('intersectsWith', `POINT(${aoi.lon.toFixed(5)} ${aoi.lat.toFixed(5)})`);
  else q.set('bbox', aoi.bbox.join(','));
  const res = await getJSON(`${ASF}?${q}`, { signal });
  // The same frame can be listed once per processing run: keep the most recently processed.
  const best = new Map();
  for (const f of res.features || []) {
    const p = f.properties;
    const key = `${p.pathNumber}/${p.frameNumber}/${p.startTime}`;
    const prev = best.get(key);
    if (!prev || (p.processingDate || '') > (prev.properties.processingDate || '')) best.set(key, f);
  }
  const records = [...best.values()].map((f) => {
    const p = f.properties;
    const find = (list, re) => (list || []).find((u) => re.test(u)) || null;
    const time = Date.parse(p.startTime);
    return {
      id: p.sceneName, kind: 'scene', cid: con.id, color: con.color, collection: 'nisar-gcov',
      platform: 'NISAR', sat: findPlatform('NISAR'), time, end: Date.parse(p.stopTime || p.startTime),
      geometry: f.geometry, bbox: bboxOf(f.geometry), cloud: null,
      sub: [(p.flightDirection || '').slice(0, 4), `TRACK ${p.pathNumber}`, `FRAME ${p.frameNumber}`,
        (p.mainBandPolarization || []).join('+'), p.frameCoverage === 'Full' ? '' : (p.frameCoverage || '').toUpperCase()].filter(Boolean),
      props: {
        ...p, browseUrl: find(p.browse, /_LATLON\.png$/), thumbUrl: find(p.browse, /_LATLON_thumbnail\.png$/),
        kmlUrl: find(p.additionalUrls, /_LATLON\.kml$/), qaUrl: find(p.additionalUrls, /_QA_REPORT\.pdf$/),
      },
    };
  });
  return { records, truncated: (res.features || []).length >= 250 };
}

/** Loads an image with CORS so its pixels can be read. */
export function loadImage(url, signal) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    const stop = () => { img.src = ''; reject(new DOMException('aborted', 'AbortError')); };
    const done = () => signal && signal.removeEventListener('abort', stop);
    if (signal) signal.addEventListener('abort', stop);
    img.onload = () => { done(); resolve(img); };
    img.onerror = () => { done(); reject(new Error('image unavailable')); };
    img.src = url;
  });
}

/**
 * Geographic bounds of a NISAR browse image (a lat/lon grid). Validated products publish a
 * KML with the bounds beside the browse image. For the earlier provisional release that KML
 * sits behind the Earthdata login, so the bounds are worked out instead: the browse image is
 * transparent outside the data, and its opaque extent matches the product footprint. That
 * lands within about one browse pixel of the KML.
 */
export async function nisarBounds(rec, img = null, signal = undefined) {
  if (rec.props.bounds) return rec.props.bounds;
  const kml = rec.props.kmlUrl;
  if (kml && kml.includes('/BROWSE/')) {
    try { return (rec.props.bounds = await kmlBounds(kml, signal)); }
    catch (err) { if (signal && signal.aborted) throw err; }
  }
  if (!rec.props.browseUrl) throw new Error('no browse image');
  img = img || await loadImage(rec.props.browseUrl, signal);
  return (rec.props.bounds = boundsFromOpaque(img, rec.bbox));
}

function boundsFromOpaque(img, [w, s, e, n]) {
  const W = img.naturalWidth, H = img.naturalHeight;
  const cv = document.createElement('canvas');
  cv.width = W; cv.height = H;
  const g = cv.getContext('2d', { willReadFrequently: true });
  g.drawImage(img, 0, 0);
  const a = g.getImageData(0, 0, W, H).data;
  let c0 = W, c1 = -1, r0 = H, r1 = -1;
  for (let y = 0; y < H; y++) {
    const row = y * W * 4;
    let first = -1, last = -1;
    for (let x = 0; x < W; x++) if (a[row + x * 4 + 3]) { first = x; break; }
    if (first < 0) continue;
    for (let x = W - 1; x >= first; x--) if (a[row + x * 4 + 3]) { last = x; break; }
    if (y < r0) r0 = y;
    r1 = y;
    if (first < c0) c0 = first;
    if (last > c1) c1 = last;
  }
  if (c1 < c0 || r1 < r0) throw new Error('browse image is empty');
  const dx = (e - w) / (c1 + 1 - c0), dy = (n - s) / (r1 + 1 - r0);
  return [w - c0 * dx, s - (H - r1 - 1) * dy, e + (W - c1 - 1) * dx, n + r0 * dy];
}

async function kmlBounds(url, signal) {
  const res = await fetch(url, { signal });
  if (!res.ok) throw new Error(`browse KML: HTTP ${res.status}`);
  const text = await res.text();
  const nums = (/<coordinates>([^<]+)<\/coordinates>/.exec(text) || [])[1];
  let box;
  if (nums) {
    const pts = nums.trim().split(/\s+/).map((pair) => pair.split(',').map(Number));
    box = [Math.min(...pts.map((p) => p[0])), Math.min(...pts.map((p) => p[1])), Math.max(...pts.map((p) => p[0])), Math.max(...pts.map((p) => p[1]))];
  } else {
    const tag = (t) => parseFloat((new RegExp(`<${t}>([^<]+)</${t}>`).exec(text) || [])[1]);
    box = [tag('west'), tag('south'), tag('east'), tag('north')];
  }
  if (!box.every(Number.isFinite)) throw new Error('browse KML has no bounds');
  return box;
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

