// TIME-LAPSE: an animated GIF of one area through the scenes found by the last scan.
//
// Each frame is a rendered PNG of the area, cut out and reprojected to Web Mercator by the
// Planetary Computer, so every frame lines up whichever tile or orbit it came from. Scenes
// taken on the same UTC day are stitched into one frame. Frames that barely cover the area
// (scene edges, missing data) are left out. The GIF is encoded in the browser.

import { presetsFor, cropUrl } from './viz.js';
import { h, toast, isoDay } from './util.js';
import { GIFEncoder, quantize, applyPalette } from '../vendor/gifenc-1.0.3.esm.js';

const MAX_FRAMES = 60;
const MAX_KM = 160;                         // widest area a frame may cover
const RADII = [[2, '2 KM'], [5, '5 KM'], [10, '10 KM'], [25, '25 KM']];
const SIZES = [[480, '480'], [720, '720'], [1024, '1024']];
const SPEEDS = [[350, 'FAST'], [700, 'NORMAL'], [1300, 'SLOW']];
const PASSES = [['all', 'ALL'], ['ascending', 'ASC'], ['descending', 'DESC']];
const MIN_COVER = 0.6;                      // share of the frame that must hold data

const CREDIT = {
  'sentinel-2-l2a': 'CONTAINS MODIFIED COPERNICUS SENTINEL DATA',
  'sentinel-1-grd': 'CONTAINS MODIFIED COPERNICUS SENTINEL DATA',
  'landsat-c2-l2': 'LANDSAT IMAGERY COURTESY OF USGS / NASA',
};

const tl = {
  vizId: null, radius: 5, size: 720, delay: 700, pass: 'all',
  job: null, progress: 0, note: '', url: null, name: null, frames: 0, used: [],
};

const mercY = (lat) => Math.log(Math.tan(Math.PI / 4 + (lat * Math.PI) / 360));

/** Area of the GIF: around the focus point, or the scanned view box. */
function areaOf(aoi) {
  if (aoi.type === 'point') {
    const dy = tl.radius / 111.32, dx = dy / Math.max(0.15, Math.cos((aoi.lat * Math.PI) / 180));
    return [aoi.lon - dx, aoi.lat - dy, aoi.lon + dx, aoi.lat + dy];
  }
  return aoi.bbox;
}

function widthKm(b) {
  return (b[2] - b[0]) * 111.32 * Math.cos((((b[1] + b[3]) / 2) * Math.PI) / 180);
}

function frameSize(b) {
  const w = tl.size;
  const ratio = (mercY(b[3]) - mercY(b[1])) / (((b[2] - b[0]) * Math.PI) / 180);
  const hgt = Math.round(Math.max(0.35, Math.min(1.5, ratio)) * w / 2) * 2;
  return [w, hgt];
}

const loadImage = (url, signal) => new Promise((resolve, reject) => {
  const img = new Image();
  img.crossOrigin = 'anonymous';
  const done = () => signal.removeEventListener('abort', stop);
  const stop = () => { img.src = ''; reject(new DOMException('aborted', 'AbortError')); };
  signal.addEventListener('abort', stop);
  img.onload = () => { done(); resolve(img); };
  img.onerror = () => { done(); reject(new Error('frame unavailable')); };
  img.src = url;
});

async function pool(items, n, fn) {
  const out = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i], i);
    }
  }));
  return out;
}

function stampFrame(g, w, hgt, lines, credit) {
  const pad = Math.round(w / 64), fs = Math.max(11, Math.round(w / 46));
  g.font = `600 ${fs}px "IBM Plex Mono", ui-monospace, monospace`;
  g.textBaseline = 'top';
  const boxW = Math.max(...lines.map((t) => g.measureText(t).width)) + pad * 2;
  g.fillStyle = 'rgba(1, 6, 8, 0.72)';
  g.fillRect(0, 0, boxW, pad * 1.5 + lines.length * fs * 1.25);
  lines.forEach((t, i) => { g.fillStyle = i ? '#8ff5dd' : '#ffb300'; g.fillText(t, pad, pad * 0.8 + i * fs * 1.25); });
  const cs = Math.max(9, Math.round(fs * 0.68));
  g.font = `500 ${cs}px "IBM Plex Mono", ui-monospace, monospace`;
  const cw = g.measureText(credit).width + pad * 2;
  g.fillStyle = 'rgba(1, 6, 8, 0.62)';
  g.fillRect(w - cw, hgt - cs - pad, cw, cs + pad);
  g.fillStyle = '#e2fff7';
  g.fillText(credit, w - cw + pad, hgt - cs - pad * 0.5);
}

async function build(con, aoi, scenes, rerender) {
  const box = areaOf(aoi);
  if (widthKm(box) > MAX_KM) { toast(`AREA TOO WIDE FOR A TIME-LAPSE (MAX ${MAX_KM} KM). ZOOM IN OR DESIGNATE A FOCUS.`, true, 5000); return; }
  const presets = presetsFor(scenes[0].collection, scenes[0].props);
  const vizId = presets.some((p) => p.id === tl.vizId) ? tl.vizId : presets[0].id;
  const label = presets.find((p) => p.id === vizId).label;
  // One frame per UTC day, oldest first. Scenes without this visualisation (other polarisations) are skipped.
  const days = new Map();
  for (const r of scenes) {
    if (con.id === 'sentinel-1' && tl.pass !== 'all' && (r.props['sat:orbit_state'] || '') !== tl.pass) continue;
    const preset = presetsFor(r.collection, r.props).find((p) => p.id === vizId);
    if (!preset) continue;
    const [w, s, e, n] = r.bbox;
    if (w > box[2] || e < box[0] || s > box[3] || n < box[1]) continue;
    const day = isoDay(r.time);
    if (!days.has(day)) days.set(day, []);
    days.get(day).push({ r, preset });
  }
  let list = [...days.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1));
  if (list.length > MAX_FRAMES) list = list.slice(-MAX_FRAMES);
  if (list.length < 2) { toast('FEWER THAN TWO USABLE DATES. WIDEN THE LOOKBACK OR RAISE THE CLOUD LIMIT.', true, 5000); return; }

  const ctrl = new AbortController();
  if (tl.url) URL.revokeObjectURL(tl.url);
  Object.assign(tl, { job: ctrl, progress: 0, note: `FETCHING ${list.length} DATES…`, url: null, frames: 0, used: [] });
  rerender();
  const [W, H] = frameSize(box);
  let done = 0;
  try {
    const frames = await pool(list, 4, async ([day, parts]) => {
      const canvas = document.createElement('canvas');
      canvas.width = W; canvas.height = H;
      const g = canvas.getContext('2d', { willReadFrequently: true });
      // Least cloudy last, so it ends up on top where same-day scenes overlap.
      parts.sort((a, b) => (b.r.cloud ?? 0) - (a.r.cloud ?? 0));
      for (const { r, preset } of parts) {
        try { g.drawImage(await loadImage(cropUrl(r.collection, r.id, preset.q, box, W, H), ctrl.signal), 0, 0, W, H); }
        catch (err) { if (ctrl.signal.aborted) throw err; }
      }
      const px = g.getImageData(0, 0, W, H).data;
      let filled = 0;
      for (let i = 3; i < px.length; i += 16) if (px[i] > 0) filled++;
      done++;
      tl.progress = done / list.length;
      tl.note = `FETCHED ${done} OF ${list.length} DATES`;
      paintProgress();
      if (filled / (px.length / 16) < MIN_COVER) return null;
      const out = document.createElement('canvas');
      out.width = W; out.height = H;
      const o = out.getContext('2d', { willReadFrequently: true });
      o.fillStyle = '#000'; o.fillRect(0, 0, W, H);
      o.drawImage(canvas, 0, 0);
      const plats = [...new Set(parts.map((p) => p.r.platform))].join('+');
      const cloud = parts.find((p) => p.r.cloud !== null);
      stampFrame(o, W, H, [`${day}`, `${plats}  ${label}${cloud ? `  ${Math.round(cloud.r.cloud)}% CLD` : ''}`], `${CREDIT[parts[0].r.collection] || ''}  //  CHEYENNE`);
      return { day, data: o.getImageData(0, 0, W, H).data };
    });
    const good = frames.filter(Boolean);
    if (good.length < 2) throw new Error('FEWER THAN TWO DATES COVER THE AREA. MOVE THE FOCUS OR CHOOSE A SMALLER AREA.');
    tl.note = `ENCODING ${good.length} FRAMES…`;
    paintProgress();
    await new Promise((r) => setTimeout(r, 30));
    const gif = GIFEncoder();
    good.forEach((f, i) => {
      const palette = quantize(f.data, 256, { format: 'rgb565' });
      const index = applyPalette(f.data, palette, 'rgb565');
      gif.writeFrame(index, W, H, { palette, delay: i === good.length - 1 ? tl.delay * 3 : tl.delay });
    });
    gif.finish();
    const blob = new Blob([gif.bytes()], { type: 'image/gif' });
    const first = good[0].day, last = good[good.length - 1].day;
    Object.assign(tl, {
      job: null, url: URL.createObjectURL(blob), frames: good.length, used: good.map((f) => f.day),
      name: `cheyenne_${con.id}_${vizId}_${first}_${last}.gif`,
      note: `${good.length} FRAMES ${first} TO ${last}, ${(blob.size / 1e6).toFixed(1)} MB${good.length < list.length ? `. ${list.length - good.length} DATE(S) LEFT OUT: SCENE EDGE OR NO DATA OVER THE AREA` : ''}`,
    });
  } catch (err) {
    Object.assign(tl, { job: null, note: ctrl.signal.aborted ? 'CANCELLED.' : err.message.toUpperCase() });
  }
  rerender();
}

let progEl = null, noteEl = null;
function paintProgress() {
  if (progEl) progEl.style.width = `${Math.round(tl.progress * 100)}%`;
  if (noteEl) noteEl.textContent = tl.note;
}

function seg(options, current, onPick) {
  return h('div', { class: 'seg' }, options.map(([val, label]) => h('button', { class: val === current ? 'on' : '', onclick: () => onPick(val) }, label)));
}

/** The TIME-LAPSE section of the mission panel. `scenes` are the acquired scenes of the last scan. */
export function timelapseSection(con, aoi, scenes, rerender) {
  if (!aoi || aoi.type === 'global' || scenes.length < 2) return null;
  const presets = presetsFor(scenes[0].collection, scenes[0].props);
  if (!presets.some((p) => p.id === tl.vizId)) tl.vizId = presets[0].id;
  const box = areaOf(aoi);
  const km = widthKm(box);
  progEl = h('i');
  noteEl = h('div', { class: 'note' + (tl.job ? ' amber' : '') }, tl.note);
  const busy = !!tl.job;
  return h('div', { class: 'sect' },
    h('h3', null, 'TIME-LAPSE', h('span', null, `${scenes.length} SCENES IN WINDOW`)),
    h('div', { class: 'ctl' },
      aoi.type === 'point' ? h('span', { class: 'k' }, 'RADIUS') : null,
      aoi.type === 'point' ? seg(RADII, tl.radius, (v) => { tl.radius = v; rerender(); }) : null,
      h('label', { for: 'tl-viz' }, 'RENDER'),
      h('select', { id: 'tl-viz', onchange: (e) => { tl.vizId = e.target.value; } },
        presets.map((p) => h('option', { value: p.id, selected: p.id === tl.vizId }, p.label))),
      con.id === 'sentinel-1' ? h('span', { class: 'k' }, 'PASS') : null,
      con.id === 'sentinel-1' ? seg(PASSES, tl.pass, (v) => { tl.pass = v; rerender(); }) : null,
      h('span', { class: 'k' }, 'WIDTH PX'), seg(SIZES, tl.size, (v) => { tl.size = v; rerender(); }),
      h('span', { class: 'k' }, 'SPEED'), seg(SPEEDS, tl.delay, (v) => { tl.delay = v; rerender(); }),
    ),
    h('div', { class: 'aoi-note' }, `AREA ${km.toFixed(km < 10 ? 1 : 0)} KM ACROSS${km > MAX_KM ? ' (TOO WIDE: ZOOM IN)' : ''}. ONE FRAME PER DATE, OLDEST FIRST, UP TO ${MAX_FRAMES}.`),
    h('div', { class: 'btnrow' },
      busy ? h('button', { class: 'wide', onclick: () => tl.job.abort() }, 'CANCEL')
        : h('button', { class: 'primary wide', disabled: km > MAX_KM, onclick: () => build(con, aoi, scenes, rerender) }, 'BUILD GIF')),
    busy ? h('div', { class: 'tl-prog' }, progEl) : null,
    tl.note ? noteEl : null,
    tl.url && !busy ? h('div', { class: 'tl-preview' }, h('img', { src: tl.url, alt: `Time-lapse of ${tl.frames} frames` })) : null,
    tl.url && !busy ? h('div', { class: 'btnrow' }, h('a', { class: 'tag', style: { textAlign: 'center', lineHeight: '20px', flex: '1' }, href: tl.url, download: tl.name }, 'SAVE GIF')) : null,
  );
}
