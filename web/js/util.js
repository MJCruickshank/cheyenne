// Geodesy, astronomy, formatting and DOM helpers shared across the board.

export const D2R = Math.PI / 180;
export const R2D = 180 / Math.PI;
export const RE = 6371.0088;            // mean Earth radius, km
export const DAY = 86400000;

export const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
export const wrapLon = (lon) => ((((lon + 180) % 360) + 360) % 360) - 180;

// ---------------------------------------------------------------- spherical geometry
// Points are [lon, lat] in degrees throughout.

export function distanceKm(a, b) {
  const p1 = a[1] * D2R, p2 = b[1] * D2R, dl = (b[0] - a[0]) * D2R;
  const s = Math.sin((p2 - p1) / 2) ** 2 + Math.cos(p1) * Math.cos(p2) * Math.sin(dl / 2) ** 2;
  return 2 * RE * Math.asin(Math.min(1, Math.sqrt(s)));
}

export function bearing(a, b) {
  const p1 = a[1] * D2R, p2 = b[1] * D2R, dl = (b[0] - a[0]) * D2R;
  const y = Math.sin(dl) * Math.cos(p2);
  const x = Math.cos(p1) * Math.sin(p2) - Math.sin(p1) * Math.cos(p2) * Math.cos(dl);
  return (Math.atan2(y, x) * R2D + 360) % 360;
}

export function destination(p, brg, km) {
  const d = km / RE, t = brg * D2R, p1 = p[1] * D2R, l1 = p[0] * D2R;
  const p2 = Math.asin(Math.sin(p1) * Math.cos(d) + Math.cos(p1) * Math.sin(d) * Math.cos(t));
  const l2 = l1 + Math.atan2(Math.sin(t) * Math.sin(d) * Math.cos(p1), Math.cos(d) - Math.sin(p1) * Math.sin(p2));
  return [wrapLon(l2 * R2D), p2 * R2D];
}

/** Split a polyline wherever it jumps across the antimeridian. */
export function splitAntimeridian(pts) {
  const lines = [];
  let cur = [];
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i];
    if (cur.length) {
      const q = cur[cur.length - 1];
      const d = p[0] - q[0];
      if (Math.abs(d) > 180) {
        const sign = d > 0 ? -1 : 1;                       // heading west (-1) or east (+1) over the line
        const span = (p[0] + sign * 360) - q[0];
        const f = span === 0 ? 0 : ((sign * 180) - q[0]) / span;
        const lat = q[1] + (p[1] - q[1]) * clamp(f, 0, 1);
        cur.push([sign * 180, lat]);
        lines.push(cur);
        cur = [[-sign * 180, lat]];
      }
    }
    cur.push([p[0], p[1]]);
  }
  if (cur.length > 1) lines.push(cur);
  return lines;
}

/** Make ring longitudes continuous (may exceed +-180) so polygons survive the antimeridian. */
export function unwrapRing(ring) {
  const out = [];
  let prev = null;
  for (const [lon, lat] of ring) {
    let x = lon;
    if (prev !== null) {
      while (x - prev > 180) x -= 360;
      while (x - prev < -180) x += 360;
    }
    out.push([x, lat]);
    prev = x;
  }
  return out;
}

export function bboxOf(geom) {
  let w = Infinity, s = Infinity, e = -Infinity, n = -Infinity;
  const walk = (c) => {
    if (typeof c[0] === 'number') {
      if (c[0] < w) w = c[0]; if (c[0] > e) e = c[0];
      if (c[1] < s) s = c[1]; if (c[1] > n) n = c[1];
    } else c.forEach(walk);
  };
  walk(geom.coordinates);
  return [w, s, e, n];
}

export function pointInGeom(pt, geom) {
  const inRing = (ring, x, y) => {
    let inside = false;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const [xi, yi] = ring[i], [xj, yj] = ring[j];
      if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
    }
    return inside;
  };
  const polys = geom.type === 'Polygon' ? [geom.coordinates] : geom.type === 'MultiPolygon' ? geom.coordinates : [];
  for (const shift of [0, -360, 360]) {
    for (const poly of polys) {
      if (inRing(poly[0], pt[0] + shift, pt[1])) return true;
    }
  }
  return false;
}

// ---------------------------------------------------------------- sun

/** Sub-solar point (low-precision almanac, good to ~0.01 deg). */
export function subsolar(ms) {
  const d = ms / DAY + 2440587.5 - 2451545.0;
  const g = (357.529 + 0.98560028 * d) * D2R;
  const q = 280.459 + 0.98564736 * d;
  const L = (q + 1.915 * Math.sin(g) + 0.020 * Math.sin(2 * g)) * D2R;
  const e = (23.439 - 0.00000036 * d) * D2R;
  const ra = Math.atan2(Math.cos(e) * Math.sin(L), Math.cos(L)) * R2D;
  const dec = Math.asin(Math.sin(e) * Math.sin(L)) * R2D;
  const gmst = (((18.697374558 + 24.06570982441908 * d) % 24) + 24) % 24;
  return [wrapLon(ra - gmst * 15), dec];
}

export function sunElevation(pt, ms) {
  const [sl, sd] = subsolar(ms);
  const s = Math.sin(pt[1] * D2R) * Math.sin(sd * D2R) + Math.cos(pt[1] * D2R) * Math.cos(sd * D2R) * Math.cos((pt[0] - sl) * D2R);
  return Math.asin(clamp(s, -1, 1)) * R2D;
}

/** Polygon covering the night hemisphere. */
export function nightPolygon(ms) {
  const [sl, sdRaw] = subsolar(ms);
  const sd = Math.abs(sdRaw) < 0.05 ? (sdRaw < 0 ? -0.05 : 0.05) : sdRaw;
  const ring = [];
  for (let lon = -180; lon <= 180; lon += 2) {
    const lat = Math.atan(-Math.cos((lon - sl) * D2R) / Math.tan(sd * D2R)) * R2D;
    ring.push([lon, lat]);
  }
  const pole = sd > 0 ? -89.9 : 89.9;          // the pole that is in darkness
  ring.push([180, pole], [-180, pole], ring[0]);
  return { type: 'Feature', properties: {}, geometry: { type: 'Polygon', coordinates: [ring] } };
}

// ---------------------------------------------------------------- formatting

const MON = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];
const p2 = (n) => String(n).padStart(2, '0');

/** Military date-time group, e.g. 151433ZNOV26 */
export function dtg(ms) {
  const d = new Date(ms);
  return `${p2(d.getUTCDate())}${p2(d.getUTCHours())}${p2(d.getUTCMinutes())}Z${MON[d.getUTCMonth()]}${String(d.getUTCFullYear()).slice(2)}`;
}
export function hms(ms) {
  const d = new Date(ms);
  return `${p2(d.getUTCHours())}:${p2(d.getUTCMinutes())}:${p2(d.getUTCSeconds())}`;
}
export function dmy(ms) {
  const d = new Date(ms);
  return `${p2(d.getUTCDate())} ${MON[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
}
export function dayMon(ms) {
  const d = new Date(ms);
  return `${p2(d.getUTCDate())}${MON[d.getUTCMonth()]}`;
}
export function isoDay(ms) {
  return new Date(ms).toISOString().slice(0, 10);
}
export function stamp(ms) {
  return `${dmy(ms)} ${hms(ms).slice(0, 5)}Z`;
}

/** Signed offset from a reference, e.g. T-2D04H or T+00H35M */
export function tRel(ms, ref) {
  const d = ms - ref, a = Math.abs(d), sign = d < 0 ? '-' : '+';
  const days = Math.floor(a / DAY), hrs = Math.floor((a % DAY) / 3600000), min = Math.floor((a % 3600000) / 60000);
  return days > 0 ? `T${sign}${days}D${p2(hrs)}H` : `T${sign}${p2(hrs)}H${p2(min)}M`;
}

export function fmtLat(lat, dp = 3) {
  return `${Math.abs(lat).toFixed(dp).padStart(dp + 3, '0')}${lat < 0 ? 'S' : 'N'}`;
}
export function fmtLon(lon, dp = 3) {
  const l = wrapLon(lon);
  return `${Math.abs(l).toFixed(dp).padStart(dp + 4, '0')}${l < 0 ? 'W' : 'E'}`;
}
export const fmtPos = (p, dp = 3) => `${fmtLat(p[1], dp)} ${fmtLon(p[0], dp)}`;

/** Parse "48.5, 37.9", "48.5N 37.9E", "48 30 N, 37 54 E" style coordinates -> [lon, lat] | null */
export function parseCoords(text) {
  const t = text.trim().toUpperCase();
  const m = t.match(/^(-?\d+(?:\.\d+)?)\s*°?\s*([NS])?[\s,;]+(-?\d+(?:\.\d+)?)\s*°?\s*([EW])?$/);
  if (!m) return null;
  let lat = parseFloat(m[1]), lon = parseFloat(m[3]);
  if (m[2] === 'S') lat = -Math.abs(lat);
  if (m[4] === 'W') lon = -Math.abs(lon);
  if (Math.abs(lat) > 90 || Math.abs(lon) > 180) return null;
  return [lon, lat];
}

// ---------------------------------------------------------------- DOM

export function h(tag, attrs, ...kids) {
  const el = document.createElement(tag);
  if (attrs) {
    for (const [k, v] of Object.entries(attrs)) {
      if (v === null || v === undefined || v === false) continue;
      if (k === 'class') el.className = v;
      else if (k === 'style' && typeof v === 'object') {
        for (const [prop, val] of Object.entries(v)) {
          if (prop.startsWith('--')) el.style.setProperty(prop, val); else el.style[prop] = val;
        }
      }
      else if (k === 'dataset') Object.assign(el.dataset, v);
      else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
      else if (k === 'html') el.innerHTML = v;
      else if (v === true) el.setAttribute(k, '');
      else el.setAttribute(k, v);
    }
  }
  for (const kid of kids.flat(Infinity)) {
    if (kid === null || kid === undefined || kid === false) continue;
    el.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
  }
  return el;
}

export const $ = (sel) => document.querySelector(sel);

export function toast(msg, isErr = false, ms = 3200) {
  const el = h('div', { class: 'toast' + (isErr ? ' err' : '') }, msg);
  $('#toasts').append(el);
  setTimeout(() => el.classList.add('fade'), ms);
  setTimeout(() => el.remove(), ms + 500);
}

export async function getJSON(url, opts) {
  const r = await fetch(url, opts);
  let body = null;
  try { body = await r.json(); } catch { /* non-JSON error body */ }
  if (!r.ok) throw new Error((body && (body.error || body.detail || body.description)) || `HTTP ${r.status}`);
  return body;
}
