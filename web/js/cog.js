// Draws open high-resolution imagery on the board without a tile server.
//
// Cloud-optimised GeoTIFFs are read with HTTP range requests: only the header and the internal
// tiles under the current map tile are fetched, at the overview level that matches the zoom.
// Each map tile is then resampled from the image's own projection (geographic, UTM or Web
// Mercator) into Web Mercator. Plain images with known geographic bounds, such as NISAR browse
// images, go through the same path.
//
// Supported: 8-bit images with 1-4 bands, tiled, JPEG / LZW / Deflate / WebP / no compression.
// That covers the "visual" products published by Vantor, Planet and NASA.
/* global maplibregl */

const TILE = 512;                       // output tile size in pixels
const GRID = 16;                        // reprojection is exact every GRID pixels, interpolated between
const R = 6378137;                      // WGS84 semi-major axis, metres

const layers = new Map();               // key -> [source]
const files = new Map();                // url -> Promise<tiff>
const images = new Map();               // url -> Promise<{w, h, data}>
const tiles = new Map();                // decoded internal tiles, least recently used first
const TILE_CACHE = 160;

// ================================================================ registry and protocol

/**
 * Register imagery under a key; the board then shows it with tiles `cyraster://key/{z}/{x}/{y}`.
 * sources: [{ kind: 'cog', url, bbox }] or [{ kind: 'image', url, bounds: [w, s, e, n] }].
 * Later sources draw over earlier ones where they have data.
 */
export function registerRaster(key, sources) {
  layers.set(key, sources);
  return `cyraster://${encodeURIComponent(key)}/{z}/{x}/{y}`;
}

export function unregisterRaster(key) {
  layers.delete(key);
}

let installed = false;
export function installProtocol() {
  if (installed) return;
  installed = true;
  maplibregl.addProtocol('cyraster', async (params, abort) => {
    const m = /^cyraster:\/\/([^/]+)\/(\d+)\/(\d+)\/(\d+)/.exec(params.url);
    if (!m) throw new Error('bad raster url');
    const sources = layers.get(decodeURIComponent(m[1]));
    if (!sources) throw new Error('raster not registered');
    const blob = await renderTile(sources, +m[2], +m[3], +m[4], abort.signal);
    return { data: await blob.arrayBuffer() };
  });
}

// ================================================================ tile rendering

const mercY = (lat) => Math.log(Math.tan(Math.PI / 4 + (lat * Math.PI) / 360));
const tileLon = (x, z) => (x / 2 ** z) * 360 - 180;
const tileLat = (y, z) => (Math.atan(Math.sinh(Math.PI * (1 - (2 * y) / 2 ** z))) * 180) / Math.PI;

async function renderTile(sources, z, x, y, signal) {
  const w = tileLon(x, z), e = tileLon(x + 1, z), n = tileLat(y, z), s = tileLat(y + 1, z);
  const out = new Uint8ClampedArray(TILE * TILE * 4);
  for (const src of sources) {
    const b = src.bbox || src.bounds;
    if (b && (b[0] > e || b[2] < w || b[1] > n || b[3] < s)) continue;
    try {
      if (src.kind === 'image') await drawImage(src, out, z, x, y, signal);
      else await drawCog(src, out, z, x, y, signal);
    } catch (err) {
      if (signal && signal.aborted) throw err;
      console.warn('raster:', src.url, err.message);
    }
  }
  const canvas = new OffscreenCanvas(TILE, TILE);
  canvas.getContext('2d').putImageData(new ImageData(out, TILE, TILE), 0, 0);
  return canvas.convertToBlob({ type: 'image/png' });
}

/** Geographic position of every GRID-th output pixel centre, as [lon, lat] pairs. */
function lonLatGrid(z, x, y) {
  const n = TILE / GRID + 1;
  const lons = new Float64Array(n), lats = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const f = Math.min(i * GRID + 0.5, TILE - 0.5) / TILE;
    lons[i] = tileLon(x + f, z);
    lats[i] = tileLat(y + f, z);
  }
  return { n, lons, lats };
}

/**
 * Fill `out` from a sampler. `toPixel(lon, lat)` gives source pixel coordinates; positions are
 * computed exactly on a grid and interpolated between, which is far below a pixel of error.
 * `sample(px, py)` returns a packed RGBA value (0 = no data) for whole-pixel coordinates.
 */
function fill(out, z, x, y, toPixel, sample) {
  const { n, lons, lats } = lonLatGrid(z, x, y);
  const gx = new Float64Array(n * n), gy = new Float64Array(n * n);
  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++) {
      const p = toPixel(lons[i], lats[j]);
      gx[j * n + i] = p[0]; gy[j * n + i] = p[1];
    }
  }
  const view = new Uint32Array(out.buffer);
  for (let j = 0; j < TILE; j++) {
    const gj = Math.min(Math.floor(j / GRID), n - 2), fj = (j + 0.5 - Math.min(gj * GRID + 0.5, TILE - 0.5)) / GRID;
    for (let i = 0; i < TILE; i++) {
      const gi = Math.min(Math.floor(i / GRID), n - 2), fi = (i + 0.5 - Math.min(gi * GRID + 0.5, TILE - 0.5)) / GRID;
      const k = gj * n + gi;
      const px = (gx[k] * (1 - fi) + gx[k + 1] * fi) * (1 - fj) + (gx[k + n] * (1 - fi) + gx[k + n + 1] * fi) * fj;
      const py = (gy[k] * (1 - fi) + gy[k + 1] * fi) * (1 - fj) + (gy[k + n] * (1 - fi) + gy[k + n + 1] * fi) * fj;
      const v = sample(Math.floor(px), Math.floor(py));
      if (v) view[j * TILE + i] = v;
    }
  }
}

// ---------------------------------------------------------------- plain images with geographic bounds

async function drawImage(src, out, z, x, y, signal) {
  const img = await loadImage(src.url, signal);
  const [w, s, e, n] = src.bounds;
  const sx = img.w / (e - w), sy = img.h / (n - s);
  const px32 = new Uint32Array(img.data.buffer);
  fill(out, z, x, y, (lon, lat) => [(lon - w) * sx, (n - lat) * sy], (px, py) => {
    if (px < 0 || py < 0 || px >= img.w || py >= img.h) return 0;
    return px32[py * img.w + px];
  });
}

function loadImage(url, signal) {
  if (!images.has(url)) {
    const job = (async () => {
      const res = await fetch(url, { signal });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const bmp = await createImageBitmap(await res.blob());
      const c = new OffscreenCanvas(bmp.width, bmp.height);
      const g = c.getContext('2d', { willReadFrequently: true });
      g.drawImage(bmp, 0, 0);
      const data = g.getImageData(0, 0, bmp.width, bmp.height).data;
      blackToClear(data);
      return { w: bmp.width, h: bmp.height, data };
    })();
    job.catch(() => images.delete(url));
    images.set(url, job);
    if (images.size > 6) images.delete(images.keys().next().value);
  }
  return images.get(url);
}

/** Browse images and visual products without an alpha band use black for "no data". */
function blackToClear(data) {
  for (let i = 0; i < data.length; i += 4) {
    if (data[i] + data[i + 1] + data[i + 2] <= 6) data[i + 3] = 0;
  }
}

// ---------------------------------------------------------------- cloud-optimised GeoTIFF

async function drawCog(src, out, z, x, y, signal) {
  const tif = await openTiff(src.url, signal);
  // Ground size of one output pixel in source units, measured at the tile centre.
  const lonC = tileLon(x + 0.5, z), latC = tileLat(y + 0.5, z);
  const a = tif.project(lonC, latC), b = tif.project(tileLon(x + 0.5 + 1 / TILE, z), latC);
  const want = Math.hypot(b[0] - a[0], b[1] - a[1]);
  // Coarsest level that is still at least as sharp as the screen (the full image if none is).
  let level = tif.levels[0];
  for (const lv of tif.levels) if (lv.res <= want * 1.25) level = lv;

  const toPixel = (lon, lat) => {
    const p = tif.project(lon, lat);
    return [(p[0] - tif.x0) / level.res, (tif.y0 - p[1]) / level.resY];
  };
  // Which internal tiles the output tile touches.
  const corners = [[0, 0], [1, 0], [0, 1], [1, 1], [0.5, 0], [0.5, 1], [0, 0.5], [1, 0.5]]
    .map(([fx, fy]) => toPixel(tileLon(x + fx, z), tileLat(y + fy, z)));
  const minX = Math.max(0, Math.floor(Math.min(...corners.map((c) => c[0])) / level.tw) - 0);
  const maxX = Math.min(level.across - 1, Math.floor(Math.max(...corners.map((c) => c[0])) / level.tw));
  const minY = Math.max(0, Math.floor(Math.min(...corners.map((c) => c[1])) / level.th));
  const maxY = Math.min(level.down - 1, Math.floor(Math.max(...corners.map((c) => c[1])) / level.th));
  if (minX > maxX || minY > maxY) return;
  if ((maxX - minX + 1) * (maxY - minY + 1) > 36) return;      // should not happen with a matching level

  const wanted = new Map();
  for (let ty = minY; ty <= maxY; ty++) {
    for (let tx = minX; tx <= maxX; tx++) wanted.set(ty * level.across + tx, readTile(tif, level, ty * level.across + tx, signal));
  }
  const got = new Map();
  await Promise.all([...wanted].map(([idx, p]) => p.then((t) => got.set(idx, t))));

  const { tw, th, across } = level;
  fill(out, z, x, y, toPixel, (px, py) => {
    if (px < 0 || py < 0 || px >= level.w || py >= level.h) return 0;
    const tx = (px / tw) | 0, ty = (py / th) | 0;
    const t = got.get(ty * across + tx);
    if (!t) return 0;
    return t[(py - ty * th) * tw + (px - tx * tw)];
  });
}

// ---------------------------------------------------------------- HTTP ranges

async function range(url, start, length, signal) {
  const res = await fetch(url, { headers: { Range: `bytes=${start}-${start + length - 1}` }, signal });
  if (res.status !== 206 && res.status !== 200) throw new Error(`HTTP ${res.status}`);
  if (res.status === 200) {
    // The server ignored the range. Only accept that for small files.
    const len = +res.headers.get('Content-Length') || 0;
    if (len > 64e6) throw new Error('server does not support range requests');
    return (await res.arrayBuffer()).slice(start, start + length);
  }
  return res.arrayBuffer();
}

// ---------------------------------------------------------------- TIFF structure

const TYPE_SIZE = { 1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 6: 1, 7: 1, 8: 2, 9: 4, 10: 8, 11: 4, 12: 8, 13: 4, 16: 8, 17: 8, 18: 8 };

function openTiff(url, signal) {
  if (!files.has(url)) {
    const job = parseTiff(url, signal);
    job.catch(() => files.delete(url));
    files.set(url, job);
  }
  return files.get(url);
}

async function parseTiff(url, signal) {
  let head = new Uint8Array(await range(url, 0, 65536, signal));
  const grow = async (end) => {            // make sure the header buffer reaches `end`
    if (end <= head.length) return;
    const more = new Uint8Array(await range(url, head.length, Math.max(end - head.length, 65536), signal));
    const next = new Uint8Array(head.length + more.length);
    next.set(head); next.set(more, head.length);
    head = next;
  };
  let dv = new DataView(head.buffer);
  const le = dv.getUint16(0) === 0x4949;
  const big = dv.getUint16(2, le) === 43;
  const u16 = (o) => dv.getUint16(o, le), u32 = (o) => dv.getUint32(o, le);
  const u64 = (o) => Number(dv.getBigUint64(o, le));
  let next = big ? u64(8) : u32(4);
  const ifds = [];
  while (next && ifds.length < 40) {
    await grow(next + (big ? 8 : 2));
    dv = new DataView(head.buffer);
    const count = big ? u64(next) : u16(next);
    const entrySize = big ? 20 : 12, first = next + (big ? 8 : 2);
    await grow(first + count * entrySize + (big ? 8 : 4));
    dv = new DataView(head.buffer);
    const tags = {};
    for (let i = 0; i < count; i++) {
      const o = first + i * entrySize;
      const tag = u16(o), type = u16(o + 2), n = big ? u64(o + 4) : u32(o + 4);
      const size = (TYPE_SIZE[type] || 1) * n, inline = size <= (big ? 8 : 4);
      tags[tag] = { type, n, at: inline ? o + (big ? 12 : 8) : (big ? u64(o + 12) : u32(o + 8)), inline };
    }
    ifds.push(tags);
    next = big ? u64(first + count * entrySize) : u32(first + count * entrySize);
  }

  // Read a tag's values (fetching them if they lie outside the header).
  const values = async (t) => {
    if (!t) return null;
    const size = (TYPE_SIZE[t.type] || 1) * t.n;
    let buf, base;
    if (t.inline || t.at + size <= head.length) { buf = head; base = t.at; }
    else { buf = new Uint8Array(await range(url, t.at, size, signal)); base = 0; }
    const v = new DataView(buf.buffer, buf.byteOffset);
    const out = new Array(t.n);
    for (let i = 0; i < t.n; i++) {
      const o = base + i * (TYPE_SIZE[t.type] || 1);
      switch (t.type) {
        case 3: out[i] = v.getUint16(o, le); break;
        case 4: case 13: out[i] = v.getUint32(o, le); break;
        case 16: case 18: out[i] = Number(v.getBigUint64(o, le)); break;
        case 12: out[i] = v.getFloat64(o, le); break;
        case 11: out[i] = v.getFloat32(o, le); break;
        case 5: out[i] = v.getUint32(o, le) / v.getUint32(o + 4, le); break;
        default: out[i] = v.getUint8(o);
      }
    }
    return out;
  };
  const one = async (tags, tag, dflt) => { const v = await values(tags[tag]); return v ? v[0] : dflt; };
  const bytes = async (t) => {
    if (!t) return null;
    if (t.inline || t.at + t.n <= head.length) return head.slice(t.at, t.at + t.n);
    return new Uint8Array(await range(url, t.at, t.n, signal));
  };

  const main = ifds[0];
  const scale = await values(main[33550]), tie = await values(main[33922]), xform = await values(main[34264]);
  let x0, y0, resX, resY;
  if (scale && tie) { resX = scale[0]; resY = scale[1]; x0 = tie[3] - tie[0] * resX; y0 = tie[4] + tie[1] * resY; }
  else if (xform) { resX = xform[0]; resY = -xform[5]; x0 = xform[3]; y0 = xform[7]; }
  else throw new Error('image is not georeferenced');
  const project = projection(await values(main[34735]));
  const nodataText = main[42113] ? new TextDecoder().decode(await bytes(main[42113])).replace(/\0/g, '').trim() : '';

  const levels = [];
  const width0 = await one(main, 256);
  for (const t of ifds) {
    const kind = await one(t, 254, 0);
    if (kind & 4) continue;                                    // transparency mask, not imagery
    if (!t[322] || !t[324]) continue;                          // stripped layouts are not cloud-optimised
    const w = await one(t, 256), h = await one(t, 257);
    const tw = await one(t, 322), th = await one(t, 323);
    const bits = await values(t[258]) || [8];
    if (bits[0] !== 8) continue;
    const factor = width0 / w;
    levels.push({
      w, h, tw, th, across: Math.ceil(w / tw), down: Math.ceil(h / th),
      res: resX * factor, resY: resY * factor,
      spp: await one(t, 277, 1), planar: await one(t, 284, 1), compression: await one(t, 259, 1),
      photometric: await one(t, 262, 1), predictor: await one(t, 317, 1),
      extra: await values(t[338]) || [],
      offsetsTag: t[324], countsTag: t[325], offsets: null, counts: null,
      tables: await bytes(t[347]),
    });
  }
  if (!levels.length) throw new Error('no readable 8-bit tiled image');
  levels.sort((a, b) => a.res - b.res);
  return { url, levels, x0, y0, project, nodata: nodataText === '' ? null : +nodataText, values };
}

/** Function from (lon, lat) to the image's own map coordinates. */
function projection(keys) {
  const geo = {};
  if (keys) for (let i = 4; i + 3 < keys.length; i += 4) geo[keys[i]] = keys[i + 3];
  const epsg = geo[3072] || geo[2048] || 4326;
  if (epsg === 4326 || epsg === 4269 || geo[1024] === 2 && !geo[3072]) return (lon, lat) => [lon, lat];
  if (epsg === 3857 || epsg === 900913) return (lon, lat) => [R * lon * Math.PI / 180, R * mercY(lat)];
  if (epsg >= 32601 && epsg <= 32660) return utm(epsg - 32600, false);
  if (epsg >= 32701 && epsg <= 32760) return utm(epsg - 32700, true);
  throw new Error(`unsupported projection EPSG:${epsg}`);
}

/** WGS84 transverse Mercator (UTM) forward projection. */
function utm(zone, south) {
  const a = R, f = 1 / 298.257223563, k0 = 0.9996;
  const e2 = f * (2 - f), ep2 = e2 / (1 - e2);
  const lon0 = ((zone - 1) * 6 - 180 + 3) * Math.PI / 180;
  const m = (phi) => a * ((1 - e2 / 4 - 3 * e2 * e2 / 64 - 5 * e2 ** 3 / 256) * phi
    - (3 * e2 / 8 + 3 * e2 * e2 / 32 + 45 * e2 ** 3 / 1024) * Math.sin(2 * phi)
    + (15 * e2 * e2 / 256 + 45 * e2 ** 3 / 1024) * Math.sin(4 * phi)
    - (35 * e2 ** 3 / 3072) * Math.sin(6 * phi));
  return (lon, lat) => {
    const phi = lat * Math.PI / 180, lam = lon * Math.PI / 180;
    const sin = Math.sin(phi), cos = Math.cos(phi), tan = Math.tan(phi);
    const N = a / Math.sqrt(1 - e2 * sin * sin), T = tan * tan, C = ep2 * cos * cos, A = cos * (lam - lon0);
    const x = k0 * N * (A + (1 - T + C) * A ** 3 / 6 + (5 - 18 * T + T * T + 72 * C - 58 * ep2) * A ** 5 / 120) + 500000;
    let y = k0 * (m(phi) + N * tan * (A * A / 2 + (5 - T + 9 * C + 4 * C * C) * A ** 4 / 24
      + (61 - 58 * T + T * T + 600 * C - 330 * ep2) * A ** 6 / 720));
    if (south) y += 10000000;
    return [x, y];
  };
}

// ---------------------------------------------------------------- internal tiles

/** One decoded internal tile as packed RGBA (Uint32Array, 0 = no data), or null when empty. */
function readTile(tif, level, idx, signal) {
  const key = `${tif.url}|${level.w}|${idx}`;
  if (tiles.has(key)) {
    const p = tiles.get(key);
    tiles.delete(key); tiles.set(key, p);                     // mark as recently used
    return p;
  }
  const job = (async () => {
    if (!level.offsets) {
      [level.offsets, level.counts] = await Promise.all([tif.values(level.offsetsTag), tif.values(level.countsTag)]);
    }
    const planes = level.planar === 2 ? level.spp : 1;
    const per = level.across * level.down;
    const parts = [];
    for (let p = 0; p < planes; p++) {
      const off = level.offsets[idx + p * per], len = level.counts[idx + p * per];
      if (!len) return null;                                   // sparse tile: nothing was ever written here
      parts.push(new Uint8Array(await range(tif.url, off, len, signal)));
    }
    return decode(tif, level, parts);
  })();
  job.catch(() => tiles.delete(key));
  tiles.set(key, job);
  while (tiles.size > TILE_CACHE) tiles.delete(tiles.keys().next().value);
  return job;
}

async function decode(tif, level, parts) {
  const { tw, th } = level;
  const n = tw * th;
  const rgba = new Uint8ClampedArray(n * 4);
  if (level.compression === 7 || level.compression === 50001) {
    // JPEG (with shared tables) or WebP: let the browser decode it.
    let data = parts[0];
    if (level.compression === 7 && level.tables && level.tables.length > 4) {
      const t = level.tables.subarray(0, level.tables.length - 2);              // drop EOI
      const merged = new Uint8Array(t.length + data.length - 2);
      merged.set(t); merged.set(data.subarray(2), t.length);                   // drop SOI
      data = merged;
    }
    const bmp = await createImageBitmap(new Blob([data], { type: level.compression === 7 ? 'image/jpeg' : 'image/webp' }));
    const c = new OffscreenCanvas(tw, th);
    const g = c.getContext('2d', { willReadFrequently: true });
    g.drawImage(bmp, 0, 0);
    rgba.set(g.getImageData(0, 0, tw, th).data);
    if (level.spp < 4) blackToClear(rgba);
  } else {
    const planes = [];
    for (const p of parts) {
      let raw;
      if (level.compression === 1) raw = p;
      else if (level.compression === 5) raw = lzw(p, n * (level.planar === 2 ? 1 : level.spp));
      else if (level.compression === 8 || level.compression === 32946) raw = await inflate(p);
      else throw new Error(`unsupported compression ${level.compression}`);
      const spp = level.planar === 2 ? 1 : level.spp;
      if (level.predictor === 2) {
        for (let r = 0; r < th; r++) {
          const row = r * tw * spp;
          for (let i = spp; i < tw * spp; i++) raw[row + i] = (raw[row + i] + raw[row + i - spp]) & 255;
        }
      }
      planes.push(raw);
    }
    const spp = level.spp;
    const band = (b, i) => (level.planar === 2 ? planes[b][i] : planes[0][i * spp + b]);
    const alphaBand = spp === 2 ? 1 : spp >= 4 ? 3 : -1;
    for (let i = 0; i < n; i++) {
      const o = i * 4;
      if (spp >= 3) { rgba[o] = band(0, i); rgba[o + 1] = band(1, i); rgba[o + 2] = band(2, i); }
      else { rgba[o] = rgba[o + 1] = rgba[o + 2] = band(0, i); }
      rgba[o + 3] = alphaBand >= 0 ? band(alphaBand, i) : 255;
    }
    if (tif.nodata !== null) {
      for (let o = 0; o < rgba.length; o += 4) {
        if (rgba[o] === tif.nodata && rgba[o + 1] === tif.nodata && rgba[o + 2] === tif.nodata) rgba[o + 3] = 0;
      }
    } else if (alphaBand < 0) {
      blackToClear(rgba);
    }
  }
  // Pack into 32-bit pixels; fully transparent pixels become 0 so they count as "no data".
  const px = new Uint32Array(rgba.buffer);
  for (let i = 0; i < n; i++) if (rgba[i * 4 + 3] === 0) px[i] = 0;
  return px;
}

async function inflate(bytes) {
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/** TIFF LZW (MSB-first codes, early change). */
function lzw(input, expected) {
  const out = new Uint8Array(expected);
  let pos = 0, bitPos = 0;
  const dictPrefix = new Int32Array(4096), dictChar = new Uint8Array(4096), dictLen = new Uint16Array(4096);
  let next = 258, width = 9, prev = -1;
  const read = () => {
    let v = 0;
    for (let i = 0; i < width; i++) {
      const byte = input[bitPos >> 3];
      if (byte === undefined) return 257;
      v = (v << 1) | ((byte >> (7 - (bitPos & 7))) & 1);
      bitPos++;
    }
    return v;
  };
  const write = (code) => {                    // emit a code's string; return its first byte
    const len = dictLen[code];
    let c = code;
    for (let i = len - 1; i >= 0; i--) {
      if (pos + i < expected) out[pos + i] = dictChar[c];
      c = dictPrefix[c];
    }
    pos += len;
    return out[pos - len];
  };
  for (let i = 0; i < 256; i++) { dictChar[i] = i; dictLen[i] = 1; dictPrefix[i] = -1; }
  for (;;) {
    const code = read();
    if (code === 257 || pos >= expected) break;
    if (code === 256) { next = 258; width = 9; prev = -1; continue; }
    let first;
    if (code < next) {
      first = write(code);
      if (prev >= 0 && next < 4096) { dictPrefix[next] = prev; dictChar[next] = first; dictLen[next] = dictLen[prev] + 1; next++; }
    } else {                                    // the KwKwK case
      if (prev < 0) break;
      const pfirst = (() => { let c = prev; while (dictPrefix[c] >= 0) c = dictPrefix[c]; return dictChar[c]; })();
      dictPrefix[next] = prev; dictChar[next] = pfirst; dictLen[next] = dictLen[prev] + 1; next++;
      write(code);
    }
    prev = code;
    if (next + 1 >= 1 << width && width < 12) width++;
  }
  return out;
}

/** Suggested deepest zoom for imagery of a given ground sample distance (metres) at a latitude. */
export function zoomForGsd(gsd, lat) {
  const z = Math.log2((156543.03 * Math.cos((lat * Math.PI) / 180)) / (2 * Math.max(0.1, gsd)));
  return Math.max(10, Math.min(19, Math.ceil(z)));
}
