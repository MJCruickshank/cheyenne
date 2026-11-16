// Orbit propagation: TLE -> positions, ground tracks, sensor swaths, pass prediction.
/* global satellite */

import { R2D, RE, bearing, destination, distanceKm, splitAntimeridian, sunElevation, unwrapRing, getJSON } from './util.js';

export const fleet = {
  sats: [],
  byId: new Map(),          // NORAD id -> sat
  byCons: new Map(),        // constellation id -> [sat]
  fetchedAt: null,
  stale: false,
};

const SHORT = [
  [/^SENTINEL-(\d)([A-D])$/, (m) => `S${m[1]}${m[2]}`],
  [/^LANDSAT (\d)$/, (m) => `L${m[1]}`],
  [/^NOAA (\d+).*$/, (m) => `N${m[1]}`],
  [/^SUOMI NPP$/, () => 'SNPP'],
  [/^WORLDVIEW-(\d).*$/, (m) => `WV${m[1]}`],
  [/^GEOEYE 1$/, () => 'GE1'],
  [/^LEGION (\d)$/, (m) => `WVL${m[1]}`],
  [/^PLEIADES NEO (\d)$/, (m) => `PNEO${m[1]}`],
  [/^PLEIADES (\w+)$/, (m) => `PHR${m[1]}`],
  [/^SPOT (\d)$/, (m) => `SPOT${m[1]}`],
  [/^COSMO-SKYMED (\d)$/, (m) => `CSK${m[1]}`],
  [/^ICEYE-(\w+)$/, (m) => `IX${m[1].replace(/^X/, '')}`],
  [/^CAPELLA-(\d+).*$/, (m) => `CAP${m[1]}`],
  [/^UMBRA-(\d+)$/, (m) => `UMB${m[1]}`],
  [/^TERRASAR-X$/, () => 'TSX'],
  [/^TANDEM-X$/, () => 'TDX'],
  [/^RADARSAT-2$/, () => 'RS2'],
  [/^SKYSAT-(\w+)$/, (m) => `SS${m[1]}`],
  [/^GAOFEN-(.+)$/, (m) => `GF${m[1].replace(/\s+/g, '-')}`],
  [/^JILIN-1 ?(.*)$/, (m) => `JL1${m[1] ? '-' + m[1].replace(/\s+/g, '') : ''}`],
  [/^QPS-SAR-(\d+).*$/, (m) => `QPS${m[1]}`],
  [/^(.+?) \(.*\)$/, (m) => m[1]],
];

function shortName(name) {
  for (const [re, fn] of SHORT) {
    const m = name.match(re);
    if (m) return fn(m);
  }
  return name;
}

export async function loadFleet() {
  const data = await getJSON('/api/tle');
  fleet.sats = [];
  fleet.byId.clear();
  fleet.byCons.clear();
  for (const s of data.sats) {
    let rec;
    try { rec = satellite.twoline2satrec(s.l1, s.l2); } catch { continue; }
    if (!rec || rec.error) continue;
    const sat = {
      id: s.norad, name: s.name, short: shortName(s.name), cid: s.c, rec,
      periodMin: (2 * Math.PI) / rec.no,
      incl: rec.inclo * R2D,
      epochMs: Date.UTC(rec.epochyr < 57 ? 2000 + rec.epochyr : 1900 + rec.epochyr, 0, 1) + (rec.epochdays - 1) * 86400000,
    };
    if (!locate(sat, Date.now())) continue;              // decayed or unusable elements
    fleet.sats.push(sat);
    fleet.byId.set(sat.id, sat);
    if (!fleet.byCons.has(sat.cid)) fleet.byCons.set(sat.cid, []);
    fleet.byCons.get(sat.cid).push(sat);
  }
  for (const list of fleet.byCons.values()) list.sort((a, b) => a.name.localeCompare(b.name, 'en', { numeric: true }));
  fleet.fetchedAt = Date.parse(data.fetchedAt);
  fleet.stale = !!data.stale;
  return fleet;
}

/** Geodetic sub-satellite point at a time. Returns null if propagation fails. */
export function locate(sat, ms) {
  const date = new Date(ms);
  const pv = satellite.propagate(sat.rec, date);
  if (!pv || !pv.position || Number.isNaN(pv.position.x)) return null;
  const geo = satellite.eciToGeodetic(pv.position, satellite.gstime(date));
  const v = pv.velocity;
  return {
    lon: geo.longitude * R2D, lat: geo.latitude * R2D, alt: geo.height,
    speed: v ? Math.hypot(v.x, v.y, v.z) : 0,
    eci: pv.position,
  };
}

/** Direction of travel over the ground (degrees clockwise from north). */
export function heading(sat, ms, here) {
  const a = here || locate(sat, ms);
  const b = locate(sat, ms + 2000);
  if (!a || !b) return 0;
  return bearing([a.lon, a.lat], [b.lon, b.lat]);
}

/** True when the satellite is in sunlight (cylindrical Earth shadow). */
export function sunlit(sat, ms, here) {
  const p = (here || locate(sat, ms));
  if (!p) return true;
  const sub = [p.lon, p.lat];
  const el = sunElevation(sub, ms);
  if (el >= 0) return true;
  // Below the horizon at the sub-point: lit only if high enough to see over the limb.
  const dip = Math.acos(RE / (RE + p.alt)) * R2D;
  return -el < dip;
}

/** Ground track as antimeridian-safe line strings. */
export function groundTrack(sat, t0, t1, stepMs = 20000) {
  const pts = [];
  for (let t = t0; t <= t1; t += stepMs) {
    const p = locate(sat, t);
    if (p) pts.push([p.lon, p.lat]);
  }
  return splitAntimeridian(pts);
}

/**
 * Cross-track extent of what the sensor can see from a point on the orbit.
 * Returns pairs of [from, to] ground points (one pair for nadir or fixed side-lookers,
 * two for agile sensors that can slew to either side).
 */
export function sensorBars(sat, geom, ms) {
  const p = locate(sat, ms);
  if (!p) return [];
  const here = [p.lon, p.lat];
  const hdg = heading(sat, ms, p);
  const right = hdg + 90, left = hdg - 90;
  if (geom.mode === 'nadir') {
    return [[destination(here, left, geom.swathKm / 2), destination(here, right, geom.swathKm / 2)]];
  }
  if (geom.mode === 'side') {
    const dir = geom.side === 'left' ? left : right;
    return [[destination(here, dir, geom.nearKm), destination(here, dir, geom.farKm)]];
  }
  const near = geom.minKm || 0;
  if (near > 0) {
    return [
      [destination(here, left, geom.reachKm), destination(here, left, near)],
      [destination(here, right, near), destination(here, right, geom.reachKm)],
    ];
  }
  return [[destination(here, left, geom.reachKm), destination(here, right, geom.reachKm)]];
}

/** Ribbon polygon swept by a fixed swath between two times. offset/width are km right of track. */
export function swathRibbon(sat, t0, t1, nearKm, farKm, stepMs = 15000) {
  const a = [], b = [];
  for (let t = t0; t <= t1 + 1; t += stepMs) {
    const p = locate(sat, t);
    if (!p) continue;
    const here = [p.lon, p.lat];
    const right = heading(sat, t, p) + 90;
    a.push(destination(here, right, nearKm));
    b.push(destination(here, right, farKm));
  }
  if (a.length < 2) return null;
  const ring = unwrapRing([...a, ...b.reverse(), a[0]]);
  return { type: 'Polygon', coordinates: [ring] };
}

/** Fixed swath limits in km to the right of the ground track, or null for agile sensors. */
export function fixedSwath(geom) {
  if (geom.mode === 'nadir') return [-geom.swathKm / 2, geom.swathKm / 2];
  if (geom.mode === 'side') return geom.side === 'left' ? [-geom.farKm, -geom.nearKm] : [geom.nearKm, geom.farKm];
  return null;
}

/** Time of closest ground approach to a point within a window (ms). */
export function closestApproach(sat, target, t0, t1) {
  let best = null;
  const scan = (a, b, step) => {
    for (let t = a; t <= b; t += step) {
      const p = locate(sat, t);
      if (!p) continue;
      const d = distanceKm([p.lon, p.lat], target);
      if (!best || d < best.km) best = { t, km: d, p };
    }
  };
  scan(t0, t1, Math.max(2000, Math.min(20000, (t1 - t0) / 60)));
  if (best) scan(Math.max(t0, best.t - 20000), Math.min(t1, best.t + 20000), 1000);
  return best;
}

/**
 * Geometric access prediction: every time a satellite's sensor can reach the target
 * within [t0, t1]. Cooperative (yields to the UI) and reports progress.
 */
export async function predictPasses(sats, geom, target, t0, t1, onProgress) {
  const out = [];
  const COARSE = 60000;
  const reach = geom.mode === 'nadir' ? geom.swathKm / 2 : geom.mode === 'side' ? geom.farKm : geom.reachKm;
  const gate = reach + 520;                     // slack for the coarse step
  let done = 0;
  for (const sat of sats) {
    let t = t0, lastYield = performance.now();
    while (t <= t1) {
      const p = locate(sat, t);
      if (p && distanceKm([p.lon, p.lat], target) < gate) {
        const ca = closestApproach(sat, target, t - COARSE, t + Math.max(4 * COARSE, (gate / 6.5) * 1000));
        if (ca && ca.t >= t0 && ca.t <= t1) {
          const sub = [ca.p.lon, ca.p.lat];
          const hdg = heading(sat, ca.t, ca.p);
          const rel = ((bearing(sub, target) - hdg + 540) % 360) - 180;      // + = target right of track
          const cross = ca.km * (rel >= 0 ? 1 : -1);
          const fixed = fixedSwath(geom);
          let ok;
          if (fixed) ok = cross >= fixed[0] && cross <= fixed[1];
          else ok = ca.km <= geom.reachKm && ca.km >= (geom.minKm || 0);
          const sunEl = sunElevation(target, ca.t);
          if (ok && (!geom.daylight || sunEl > 3)) {
            const half = geom.swathKm / 2;
            const strip = fixed ? fixed : [cross - half, cross + half];
            const next = locate(sat, ca.t + 10000);
            out.push({
              sat, time: ca.t, crossKm: cross, sunEl,
              offNadir: Math.atan2(ca.km, ca.p.alt) * R2D,
              ascending: next ? next.lat > ca.p.lat : false,
              geometry: swathRibbon(sat, ca.t - 60000, ca.t + 60000, strip[0], strip[1]),
            });
          }
        }
        t += 12 * COARSE;                        // skip past this pass
      } else {
        t += COARSE;
      }
      if (performance.now() - lastYield > 24) {
        await new Promise((r) => setTimeout(r));
        lastYield = performance.now();
      }
    }
    done += 1;
    if (onProgress) onProgress(done / sats.length);
  }
  out.sort((a, b) => a.time - b.time);
  return out;
}

/** Resolve a platform label from a catalogue (S2B, sentinel-1c, landsat-9, Sentinel-2A) to a tracked satellite. */
export function findPlatform(label) {
  if (!label) return null;
  let key = String(label).toUpperCase().replace(/[^A-Z0-9]/g, '');
  const m = key.match(/^S([1-6])([A-D])$/);
  if (m) key = `SENTINEL${m[1]}${m[2]}`;
  for (const sat of fleet.sats) {
    if (sat.name.toUpperCase().replace(/[^A-Z0-9]/g, '') === key) return sat;
  }
  return null;
}

export function platformShort(label) {
  const sat = findPlatform(label);
  if (sat) return sat.short;
  return String(label || '?').toUpperCase().replace(/^SENTINEL-?/, 'S').replace(/^LANDSAT-?/, 'L');
}

