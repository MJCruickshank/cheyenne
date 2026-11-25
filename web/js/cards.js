// SHARE CARDS: PNG images for social media, drawn in the board's own style.
//
//  Alert card: one Intel report on the map as it stands, with whatever imagery, FIRMS
//  detections and AIS ships are already on the board, plus the report text.
//  Before / after card: two acquired scenes of the same area side by side (or stacked),
//  each with its date and sensor. The scenes can come from different fleets.
//
// The map is captured from the board's own canvas, so the card shows exactly what is drawn.
// Imagery for before / after is fetched afresh at card resolution (see frames.js).

import { S } from './state.js';
import { map } from './globe.js';
import { firms } from './firms.js';
import { ais } from './ais.js';
import { presetsFor } from './viz.js';
import { drawScene, creditFor, nonCommercial, boxAround, sameDay, coverage } from './frames.js';
import { $, h, toast, isoDay, stamp, fmtPos, clamp, DAY } from './util.js';

const INK = '#8ff5dd', INK_HI = '#e2fff7', INK_DIM = '#3f9c8b', INK_FAINT = '#1f5a50';
const LINE = '#17564d', LINE_HI = '#2a9482', AMBER = '#ffb300', BG = '#010608', PANEL = 'rgba(2, 12, 14, 0.92)';
const MONO = '"IBM Plex Mono", ui-monospace, monospace';
const DISPLAY = '"Share Tech Mono", "IBM Plex Mono", ui-monospace, monospace';

const FORMATS = {
  wide: { W: 1600, H: 900, u: 1, label: '16:9', hint: 'X, Bluesky, LinkedIn, Telegram' },
  square: { W: 1080, H: 1080, u: 0.86, label: '1:1', hint: 'Instagram, Mastodon' },
  tall: { W: 1080, H: 1350, u: 0.86, label: '4:5', hint: 'Instagram portrait' },
};
const MONTHS = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];
const dayText = (ms) => { const d = new Date(ms); return `${String(d.getUTCDate()).padStart(2, '0')} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`; };
const hhmm = (ms) => new Date(ms).toISOString().slice(11, 16);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------- drawing primitives

function setFont(g, size, { weight = 400, display = false, ls = 0.04 } = {}) {
  g.font = `${weight} ${size}px ${display ? DISPLAY : MONO}`;
  if ('letterSpacing' in g) g.letterSpacing = `${(size * ls).toFixed(2)}px`;
}

function text(g, str, x, y, size, color, opts = {}) {
  setFont(g, size, opts);
  g.fillStyle = color;
  g.textAlign = opts.align || 'left';
  g.textBaseline = opts.base || 'alphabetic';
  if (opts.glow) { g.shadowColor = opts.glow; g.shadowBlur = size * 0.45; }
  g.fillText(str, x, y);
  g.shadowBlur = 0;
  g.textAlign = 'left';
  return g.measureText(str).width;
}

/** Breaks `str` into lines no wider than `w`; the last allowed line ends in an ellipsis if cut. */
function wrap(g, str, w, maxLines, size, opts = {}) {
  setFont(g, size, opts);
  const words = String(str).replace(/\s+/g, ' ').trim().split(' ');
  const lines = [];
  let cur = '';
  for (let i = 0; i < words.length; i++) {
    let word = words[i];
    while (g.measureText(word).width > w) {                     // a single over-long word: hard-break it
      let k = word.length - 1;
      while (k > 1 && g.measureText(word.slice(0, k)).width > w) k--;
      if (cur) { lines.push(cur); cur = ''; }
      lines.push(word.slice(0, k)); word = word.slice(k);
    }
    const next = cur ? `${cur} ${word}` : word;
    if (g.measureText(next).width <= w) cur = next;
    else { lines.push(cur); cur = word; }
  }
  if (cur) lines.push(cur);
  if (lines.length > maxLines) {
    const kept = lines.slice(0, maxLines);
    let last = kept[maxLines - 1];
    while (last && g.measureText(`${last}…`).width > w) last = last.slice(0, -1);
    kept[maxLines - 1] = `${last.trimEnd()}…`;
    return kept;
  }
  return lines;
}

function background(g, W, H) {
  g.fillStyle = BG; g.fillRect(0, 0, W, H);
  const glow = g.createRadialGradient(W / 2, H / 2, 0, W / 2, H / 2, Math.max(W, H) * 0.62);
  glow.addColorStop(0, 'rgba(18, 74, 66, 0.20)'); glow.addColorStop(0.6, 'rgba(4, 22, 22, 0.08)'); glow.addColorStop(1, 'rgba(0, 0, 0, 0)');
  g.fillStyle = glow; g.fillRect(0, 0, W, H);
  g.fillStyle = 'rgba(23, 86, 77, 0.10)';
  for (let x = 47; x < W; x += 48) g.fillRect(x, 0, 1, H);
  for (let y = 47; y < H; y += 48) g.fillRect(0, y, W, 1);
}

function brandMark(g, cx, cy, r) {
  g.save();
  g.beginPath(); g.arc(cx, cy, r, 0, Math.PI * 2); g.closePath();
  const fill = g.createRadialGradient(cx, cy, 0, cx, cy, r);
  fill.addColorStop(0, 'rgba(143, 245, 221, 0.18)'); fill.addColorStop(1, 'rgba(143, 245, 221, 0)');
  g.fillStyle = fill; g.fill();
  g.clip();
  if (g.createConicGradient) {
    const sweep = g.createConicGradient(-Math.PI / 2 + 0.9, cx, cy);
    sweep.addColorStop(0, 'rgba(143, 245, 221, 0.75)'); sweep.addColorStop(0.28, 'rgba(143, 245, 221, 0)'); sweep.addColorStop(1, 'rgba(143, 245, 221, 0)');
    g.fillStyle = sweep; g.fillRect(cx - r, cy - r, r * 2, r * 2);
  }
  g.fillStyle = LINE_HI; g.fillRect(cx - 0.5, cy - r, 1, r * 2);
  g.restore();
  g.strokeStyle = INK; g.lineWidth = 1.5;
  g.beginPath(); g.arc(cx, cy, r, 0, Math.PI * 2); g.stroke();
}

/** Top band: the board's brand on the left, the card kind and a time on the right. Returns its height. */
function header(g, W, u, kind, when) {
  const M = 32 * u, hh = 84 * u;
  brandMark(g, M + 21 * u, hh / 2, 21 * u);
  text(g, 'CHEYENNE', M + 56 * u, hh / 2 + 4 * u, 32 * u, INK_HI, { display: true, ls: 0.3, glow: 'rgba(143, 245, 221, 0.55)' });
  text(g, 'EARTH OBSERVATION TRACKING BOARD', M + 57 * u, hh / 2 + 22 * u, 10.5 * u, INK_DIM, { ls: 0.22 });
  // Kind as a solid amber tag, time beneath it.
  setFont(g, 13 * u, { weight: 600, ls: 0.12 });
  const tw = g.measureText(kind).width + 16 * u;
  const tx = W - M - tw, ty = hh / 2 - 22 * u;
  g.fillStyle = AMBER; g.fillRect(tx, ty, tw, 22 * u);
  text(g, kind, tx + 8 * u, ty + 15.5 * u, 13 * u, BG, { weight: 600, ls: 0.12 });
  if (when) text(g, when, W - M, hh / 2 + 22 * u, 13 * u, INK, { align: 'right', ls: 0.1 });
  g.fillStyle = LINE; g.fillRect(M, hh, W - 2 * M, 1);
  return hh;
}

/** A board panel: dark fill, line border and the gradient head with an amber marker. Returns the head height. */
function panel(g, x, y, w, hgt, u, title, { color = INK_HI, right = '', rightColor = INK } = {}) {
  g.fillStyle = PANEL; g.fillRect(x, y, w, hgt);
  const head = 38 * u;
  const grad = g.createLinearGradient(x, 0, x + w, 0);
  grad.addColorStop(0, 'rgba(42, 148, 130, 0.24)'); grad.addColorStop(1, 'rgba(42, 148, 130, 0.03)');
  g.fillStyle = grad; g.fillRect(x, y, w, head);
  g.fillStyle = LINE; g.fillRect(x, y + head, w, 1);
  g.strokeStyle = LINE; g.lineWidth = 1; g.strokeRect(x + 0.5, y + 0.5, w - 1, hgt - 1);
  g.fillStyle = AMBER; g.fillRect(x + 12 * u, y + 12 * u, 6 * u, 14 * u);
  text(g, title, x + 28 * u, y + 25 * u, 17 * u, color, { display: true, ls: 0.14 });
  if (right) text(g, right, x + w - 12 * u, y + 25 * u, 15 * u, rightColor, { display: true, ls: 0.1, align: 'right' });
  return head;
}

function tag(g, x, y, str, u, color = INK) {
  setFont(g, 12 * u, { weight: 500, ls: 0.1 });
  const w = g.measureText(str).width + 12 * u;
  g.strokeStyle = color; g.lineWidth = 1; g.strokeRect(x + 0.5, y + 0.5, w, 20 * u);
  text(g, str, x + 6 * u, y + 15 * u, 12 * u, color, { weight: 500, ls: 0.1 });
  return w;
}

function brackets(g, x, y, w, hgt, u, color = INK) {
  const L = 20 * u;
  g.strokeStyle = color; g.lineWidth = 2 * u;
  g.beginPath();
  for (const [cx, cy, dx, dy] of [[x, y, 1, 1], [x + w, y, -1, 1], [x, y + hgt, 1, -1], [x + w, y + hgt, -1, -1]]) {
    g.moveTo(cx, cy + dy * L); g.lineTo(cx, cy); g.lineTo(cx + dx * L, cy);
  }
  g.stroke();
}

/** Scale bar for `mPerPx` metres per card pixel, at bottom-left of the box. */
function scaleBar(g, x, y, u, mPerPx) {
  if (!(mPerPx > 0)) return;
  const target = 150 * u * mPerPx;
  const pow = 10 ** Math.floor(Math.log10(target));
  const m = [1, 2, 5, 10].map((k) => k * pow).filter((v) => v <= target).pop() || pow;
  const len = m / mPerPx;
  const label = m >= 1000 ? `${m / 1000} KM` : `${m} M`;
  setFont(g, 13 * u, { weight: 500, ls: 0.08 });
  g.fillStyle = 'rgba(1, 6, 8, 0.72)'; g.fillRect(x - 8 * u, y - 24 * u, len + g.measureText(label).width + 26 * u, 34 * u);
  g.fillStyle = INK_HI;
  g.fillRect(x, y, len, 2 * u); g.fillRect(x, y - 6 * u, 2 * u, 8 * u); g.fillRect(x + len - 2 * u, y - 6 * u, 2 * u, 8 * u);
  text(g, label, x + len + 8 * u, y + 3 * u, 13 * u, INK_HI, { weight: 500, ls: 0.08 });
}

function northArrow(g, x, y, u, bearing) {
  g.save(); g.translate(x, y); g.rotate((-bearing * Math.PI) / 180);
  g.fillStyle = 'rgba(1, 6, 8, 0.72)'; g.beginPath(); g.arc(0, 0, 17 * u, 0, Math.PI * 2); g.fill();
  g.fillStyle = INK_HI; g.beginPath(); g.moveTo(0, -12 * u); g.lineTo(6 * u, 6 * u); g.lineTo(0, 2 * u); g.lineTo(-6 * u, 6 * u); g.closePath(); g.fill();
  g.restore();
  text(g, 'N', x, y - 21 * u, 11 * u, INK_HI, { align: 'center', weight: 600 });
}

function scanlines(g, W, H) {
  g.fillStyle = 'rgba(0, 0, 0, 0.09)';
  for (let y = 0; y < H; y += 3) g.fillRect(0, y, W, 1);
  const v = g.createRadialGradient(W / 2, H / 2, Math.min(W, H) * 0.45, W / 2, H / 2, Math.max(W, H) * 0.75);
  v.addColorStop(0, 'rgba(0, 0, 0, 0)'); v.addColorStop(1, 'rgba(0, 0, 0, 0.35)');
  g.fillStyle = v; g.fillRect(0, 0, W, H);
}

/** Credits along the bottom: wrapped to two lines, with the generation time on the right. */
function footer(g, W, H, u, credits, note) {
  const M = 32 * u, top = H - 58 * u;
  g.fillStyle = LINE; g.fillRect(M, top, W - 2 * M, 1);
  const right = `CHEYENNE // ${stamp(Date.now())}`;
  setFont(g, 11 * u, { ls: 0.08 });
  const rw = g.measureText(right).width;
  const lines = wrap(g, credits, W - 2 * M - rw - 30 * u, note ? 1 : 2, 11 * u, { ls: 0.08 });
  lines.forEach((l, i) => text(g, l, M, top + 22 * u + i * 17 * u, 11 * u, INK_DIM, { ls: 0.08 }));
  if (note) text(g, note, M, top + 39 * u, 11 * u, AMBER, { ls: 0.08 });
  text(g, right, W - M, top + 22 * u, 11 * u, INK_DIM, { align: 'right', ls: 0.08 });
}

/** Metres per pixel of Web Mercator at a latitude, for an image spanning `lonSpan` degrees over `px` pixels. */
const mPerPx = (lonSpan, px, lat) => (lonSpan / 360) * 40075016.686 * Math.cos((lat * Math.PI) / 180) / px;

async function fontsReady() {
  try {
    await Promise.all(['400 20px "Share Tech Mono"', '400 20px "IBM Plex Mono"', '500 20px "IBM Plex Mono"', '600 20px "IBM Plex Mono"']
      .map((f) => document.fonts.load(f)));
  } catch { /* system fallback fonts are fine */ }
}

// ---------------------------------------------------------------- capturing the board

let capturing = false;
/** True while a card is being captured: the camera moves briefly and should not count as the user's. */
export const isCapturing = () => capturing;

function grabFrame() {
  return new Promise((resolve) => {
    map.once('render', () => {
      const c = map.getCanvas();
      const copy = document.createElement('canvas');
      copy.width = c.width; copy.height = c.height;
      copy.getContext('2d').drawImage(c, 0, 0);
      resolve(copy);
    });
    map.triggerRepaint();
  });
}

async function settle(signal, maxMs = 12000) {
  const t0 = performance.now();
  await sleep(700);                                        // let FIRMS and AIS start reloading for the new view
  while (performance.now() - t0 < maxMs && !signal.aborted) {
    if (map.isStyleLoaded() && map.areTilesLoaded()) { await sleep(300); if (map.areTilesLoaded()) return; }
    await sleep(150);
  }
}

// Board furniture that means nothing on a shared image: the focus marker, scan outline,
// hover / selection highlights, result footprints and the live sensor swath.
const UI_LAYERS = ['cy-target', 'cy-aoi', 'cy-hl-hover-fill', 'cy-hl-hover', 'cy-hl-sel-glow', 'cy-hl-sel', 'cy-plan-fill',
  'cy-foot-line', 'cy-plan-line', 'cy-swath-fill', 'cy-swath-bar', 'cy-sat-select'];

function visibleLayers(ids) {
  return ids.filter((id) => map.getLayer(id) && map.getLayoutProperty(id, 'visibility') !== 'none');
}

function countIn(rect, ids, key) {
  const layers = visibleLayers(ids);
  if (!layers.length) return 0;
  const seen = new Set();
  for (const f of map.queryRenderedFeatures(rect, { layers })) seen.add(key(f));
  return seen.size;
}

/** Source credits for every visible layer of the board style. */
function styleCredits() {
  const out = new Set();
  for (const l of map.getStyle().layers) {
    if (!l.source || (l.layout && l.layout.visibility === 'none')) continue;
    const src = map.getSource(l.source);
    const a = src && (src.attribution || (src._options && src._options.attribution));
    if (a && typeof a === 'string') out.add(a.replace(/<[^>]+>/g, '').replace(/&copy;/g, '©').trim().toUpperCase());
  }
  return [...out];
}

/**
 * Captures the board around `center` with the given width / height, at the current zoom plus
 * `zoomDelta`. The crop is the size of the open part of the board (between the panels), so the
 * card shows about what the user sees. The camera is put back afterwards.
 */
let captureQueue = Promise.resolve();
function captureMap(...args) {
  const run = captureQueue.then(() => captureNow(...args));
  captureQueue = run.catch(() => {});
  return run;
}

async function captureNow(center, aspect, zoomDelta, signal) {
  const canvas = map.getCanvas();
  const cw = canvas.clientWidth, ch = canvas.clientHeight;
  const pad = map.getPadding();
  const visW = Math.max(240, cw - pad.left - pad.right), visH = Math.max(240, ch - pad.top - pad.bottom);
  let cropW = visW, cropH = visW / aspect;
  if (cropH > visH) { cropH = visH; cropW = visH * aspect; }
  const cam = { center: map.getCenter(), zoom: map.getZoom(), bearing: map.getBearing(), pitch: map.getPitch() };
  // Leave the camera alone when the area already fits on the canvas at this zoom.
  const at = map.project(center);
  const fits = !zoomDelta && cam.pitch < 1 && at.x - cropW / 2 >= 0 && at.x + cropW / 2 <= cw && at.y - cropH / 2 >= 0 && at.y + cropH / 2 <= ch;
  capturing = true;
  const hidden = visibleLayers(UI_LAYERS);
  for (const id of hidden) map.setLayoutProperty(id, 'visibility', 'none');
  try {
    let x0, y0;
    if (fits) {
      x0 = at.x - cropW / 2; y0 = at.y - cropH / 2;
      await settle(signal, 6000);
    } else {
      map.setPadding({ top: 0, bottom: 0, left: 0, right: 0 });
      map.jumpTo({ center, zoom: clamp(cam.zoom + zoomDelta, 1, 17), pitch: 0, bearing: cam.bearing });
      x0 = (cw - cropW) / 2; y0 = (ch - cropH) / 2;
      await settle(signal);
    }
    if (signal.aborted) return null;
    const full = await grabFrame();
    const dpr = full.width / cw;
    const crop = document.createElement('canvas');
    crop.width = Math.round(cropW * dpr); crop.height = Math.round(cropH * dpr);
    crop.getContext('2d').drawImage(full, x0 * dpr, y0 * dpr, cropW * dpr, cropH * dpr, 0, 0, crop.width, crop.height);
    const rect = [[x0, y0], [x0 + cropW, y0 + cropH]];
    const nw = map.unproject([x0, y0]), se = map.unproject([x0 + cropW, y0 + cropH]);
    const bounds = [nw.lng, se.lat, se.lng, nw.lat];
    const pt = map.project(center);
    const shot = {
      crop, bounds, bearing: map.getBearing(), pitch: map.getPitch(), zoom: map.getZoom(),
      pt: [(pt.x - x0) / cropW, (pt.y - y0) / cropH],
      // metres per crop CSS pixel at the centre (Web Mercator, 512 px tiles)
      mPerCss: (40075016.686 * Math.cos((center[1] * Math.PI) / 180)) / (512 * 2 ** map.getZoom()), cropW,
      fires: firms.on ? countIn(rect, ['cy-firms'], (f) => f.geometry.coordinates.join(',')) : 0,
      ships: ais.on ? countIn(rect, ['cy-ais', 'cy-ais-dot'], (f) => f.properties.mmsi || f.geometry.coordinates.join(',')) : 0,
      reports: countIn(rect, ['cy-intel'], (f) => f.properties.id),
      credits: styleCredits(),
      scenes: [...S.rendered.values()].filter(({ rec }) => !(rec.bbox[0] > bounds[2] || rec.bbox[2] < bounds[0] || rec.bbox[1] > bounds[3] || rec.bbox[3] < bounds[1])),
    };
    return shot;
  } finally {
    for (const id of hidden) map.setLayoutProperty(id, 'visibility', 'visible');
    if (!fits) { map.setPadding(pad); map.jumpTo(cam); }
    capturing = false;
  }
}

// ---------------------------------------------------------------- alert card

function alertLayout(fmt) {
  const { W, H, u } = fmt;
  const M = 32 * u, top = 84 * u + 18 * u, bottom = H - 58 * u - 14 * u;
  if (W > H) {
    const mapW = Math.round(W * 0.62);
    return { map: [M, top, mapW, bottom - top], side: [M + mapW + 20 * u, top, W - 2 * M - mapW - 20 * u, bottom - top] };
  }
  const mapH = Math.round((bottom - top) * (H > W ? 0.56 : 0.5));
  return { map: [M, top, W - 2 * M, mapH], side: [M, top + mapH + 16 * u, W - 2 * M, bottom - top - mapH - 16 * u] };
}

function sceneLabel(rec, vizId) {
  const c = S.cons.get(rec.cid);
  const preset = presetsFor(rec.collection, rec.props).find((p) => p.id === vizId);
  const name = c ? c.name : rec.platform;
  return `${name}${rec.platform && rec.platform !== name ? ` ${rec.platform}` : ''}${preset ? `, ${preset.label}` : ''}, ${dayText(rec.time)}`;
}

function onMapLines(shot) {
  const lines = [];
  for (const { rec, vizId } of shot.scenes.slice(0, 2)) lines.push(['IMAGERY', sceneLabel(rec, vizId)]);
  if (shot.scenes.length > 2) lines.push(['IMAGERY', `+${shot.scenes.length - 2} MORE SCENES`]);
  if (firms.on) lines.push(['FIRES', `${shot.fires.toLocaleString('en')} FIRMS DETECTION${shot.fires === 1 ? '' : 'S'}, LAST ${firms.win.toUpperCase()}`]);
  if (ais.on) lines.push(['SHIPS', `${shot.ships.toLocaleString('en')} AIS POSITION${shot.ships === 1 ? '' : 'S'}`]);
  if (shot.reports > 1) lines.push(['REPORTS', `${shot.reports - 1} OTHER PLACE${shot.reports === 2 ? '' : 'S'} WITH REPORTS`]);
  return lines;
}

function alertCredits(a, shot) {
  const parts = [`REPORT: ${a.channel.toUpperCase()} (PUBLIC TELEGRAM), PLACED BY CHEYENNE`];
  const seen = new Set();
  for (const { rec } of shot.scenes) { const c = creditFor(rec); if (c && !seen.has(c)) { seen.add(c); parts.push(c); } }
  if (firms.on) parts.push('FIRES: NASA FIRMS');
  if (ais.on) {
    const m = ais.meta || {};
    const feeds = (m.sources || []).filter((s) => s.status === 'RECEIVING').map((s) => s.label);
    parts.push(`SHIPS: AIS${feeds.length ? ` VIA ${feeds.join(', ')}` : ''}${m.attribution && m.attribution.length ? ` (${m.attribution.join('; ')})` : ''}`.toUpperCase());
  }
  // Scene sources are already credited above; the rest are the basemap and overlays.
  const base = shot.credits.filter((c) => !/PLANETARY COMPUTER|VANTOR|PLANET LABS|ASF DAAC|NASA\/JPL/i.test(c));
  if (base.length) parts.push(`MAP: ${base.join(', ')}`);
  return parts.join('  ·  ');
}

async function drawAlertCard(fmt, a, shot, opts) {
  const { W, H, u } = fmt;
  const cv = document.createElement('canvas');
  cv.width = W; cv.height = H;
  const g = cv.getContext('2d');
  background(g, W, H);
  header(g, W, u, 'INTEL ALERT', `REPORTED ${stamp(a.t)}`);
  const L = alertLayout(fmt);

  // Map, with the report's place marked.
  const [mx, my, mw, mh] = L.map;
  g.fillStyle = '#000'; g.fillRect(mx, my, mw, mh);
  g.imageSmoothingQuality = 'high';
  g.drawImage(shot.crop, mx, my, mw, mh);
  const px = mx + shot.pt[0] * mw, py = my + shot.pt[1] * mh;
  g.strokeStyle = a.color; g.lineWidth = 2 * u; g.shadowColor = a.color; g.shadowBlur = 10 * u;
  g.beginPath(); g.arc(px, py, 34 * u, 0, Math.PI * 2); g.stroke();
  g.shadowBlur = 0;
  for (const [dx, dy] of [[0, -1], [1, 0], [0, 1], [-1, 0]]) {
    g.beginPath(); g.moveTo(px + dx * 40 * u, py + dy * 40 * u); g.lineTo(px + dx * 54 * u, py + dy * 54 * u); g.stroke();
  }
  g.strokeStyle = LINE_HI; g.lineWidth = 1; g.strokeRect(mx + 0.5, my + 0.5, mw - 1, mh - 1);
  brackets(g, mx - 4 * u, my - 4 * u, mw + 8 * u, mh + 8 * u, u);
  // position chip, top left
  const pos = fmtPos(a.pt, 4);
  setFont(g, 13 * u, { weight: 500, ls: 0.08 });
  const cw = g.measureText(pos).width + 20 * u;
  g.fillStyle = 'rgba(1, 6, 8, 0.78)'; g.fillRect(mx + 12 * u, my + 12 * u, cw, 26 * u);
  text(g, pos, mx + 22 * u, my + 30 * u, 13 * u, INK_HI, { weight: 500, ls: 0.08 });
  if (shot.pitch < 5 && shot.zoom >= 4.5) scaleBar(g, mx + 24 * u, my + mh - 20 * u, u, (shot.mPerCss * shot.cropW) / mw);
  if (Math.abs(shot.bearing) > 0.5) northArrow(g, mx + mw - 30 * u, my + 40 * u, u, shot.bearing);

  // Report panel.
  const [sx, sy, sw, sh] = L.side;
  const head = panel(g, sx, sy, sw, sh, u, `REPORTED ${a.label}`, { color: a.color, right: `${hhmm(a.t)}Z` });
  const pad = 16 * u, inner = sw - 2 * pad;
  let y = sy + head + pad;
  let ix = sx + pad;
  if (a.icon) { g.drawImage(a.icon, ix, y, 46 * u, 46 * u); ix += 58 * u; }
  const headLines = wrap(g, opts.headline || a.place, sx + sw - pad - ix, 2, 27 * u, { display: true, ls: 0.06 });
  headLines.forEach((l, i) => text(g, l, ix, y + 24 * u + i * 30 * u, 27 * u, INK_HI, { display: true, ls: 0.06, glow: 'rgba(143, 245, 221, 0.35)' }));
  y += Math.max(46 * u, 30 * u * headLines.length) + 6 * u;
  const sub = wrap(g, a.placeLine, sx + sw - pad - ix, 1, 12.5 * u, { ls: 0.08 });
  if (sub.length) { text(g, sub[0], ix, y + 8 * u, 12.5 * u, INK_DIM, { ls: 0.08 }); y += 18 * u; }
  y += 12 * u;

  // Bottom-up: warning, then what is on the map, then the facts; the summary takes what is left.
  const warn = wrap(g, 'UNVERIFIED REPORT FROM A PUBLIC TELEGRAM CHANNEL. PLACE AND CATEGORY WERE EXTRACTED AUTOMATICALLY.', inner, 3, 12 * u, { ls: 0.06 });
  const facts = [
    ['SOURCE', a.channel.toUpperCase()],
    ['POSTED', stamp(a.t)],
    ['PLACED', a.precision],
    a.conf ? ['CONFIDENCE', a.conf] : null,
  ].filter(Boolean);
  const onMap = onMapLines(shot);
  const rowH = 21 * u, keyW = 112 * u;
  let bottom = sy + sh - pad;
  const warnH = warn.length * 17 * u + 8 * u;
  bottom -= warnH;
  const warnTop = bottom;
  const blockH = (rows) => (rows.length ? rows.length * rowH + 26 * u : 0);
  const sumLine = 26 * u;
  const room = (rows) => bottom - blockH(rows) - y;
  let mapRows = onMap, factRows = facts;
  while (mapRows.length && room([...factRows, ...mapRows]) < sumLine * 3) mapRows = mapRows.slice(0, -1);
  while (factRows.length > 2 && room([...factRows, ...mapRows]) < sumLine * 3) factRows = factRows.slice(0, -1);
  const drawRows = (rows, title, top) => {
    text(g, title, sx + pad, top + 12 * u, 11 * u, INK_DIM, { ls: 0.16 });
    g.fillStyle = LINE; g.fillRect(sx + pad + g.measureText(title).width + 10 * u, top + 8 * u, inner - g.measureText(title).width - 10 * u, 1);
    rows.forEach(([k, v], i) => {
      const ry = top + 26 * u + i * rowH + 14 * u;
      text(g, k, sx + pad, ry, 12.5 * u, INK_DIM, { ls: 0.08 });
      const vv = wrap(g, v, inner - keyW, 1, 14 * u, { weight: 500, ls: 0.05 });
      text(g, vv[0] || '', sx + pad + keyW, ry, 14 * u, INK_HI, { weight: 500, ls: 0.05 });
    });
  };
  const mapTop = bottom - blockH(mapRows);
  const factTop = mapTop - blockH(factRows) - (mapRows.length ? 4 * u : 0);
  // The summary takes the room left, in the largest size at which it fits whole.
  const roomH = factTop - y - 12 * u;
  let size = 20 * u, sumLines = [];
  for (const k of [30, 27, 24, 22, 20]) {
    size = k * u;
    sumLines = wrap(g, a.summary, inner, 99, size, { weight: 500, ls: 0.03 });
    if (sumLines.length * size * 1.38 <= roomH) break;
  }
  sumLines = wrap(g, a.summary, inner, Math.max(1, Math.floor(roomH / (size * 1.38))), size, { weight: 500, ls: 0.03 });
  sumLines.forEach((l, i) => text(g, l, sx + pad, y + size + i * size * 1.38, size, INK_HI, { weight: 500, ls: 0.03 }));
  if (factRows.length) drawRows(factRows, 'REPORT', factTop);
  if (mapRows.length) drawRows(mapRows, 'ON THE MAP', mapTop);
  g.fillStyle = 'rgba(255, 179, 0, 0.08)'; g.fillRect(sx + pad, warnTop, inner, warnH - 4 * u);
  g.fillStyle = AMBER; g.fillRect(sx + pad, warnTop, 3 * u, warnH - 4 * u);
  warn.forEach((l, i) => text(g, l, sx + pad + 12 * u, warnTop + 16 * u + i * 17 * u, 12 * u, AMBER, { ls: 0.06 }));

  const nc = shot.scenes.some(({ rec }) => nonCommercial(rec));
  footer(g, W, H, u, alertCredits(a, shot), nc ? 'IMAGERY CC BY-NC 4.0: NON-COMMERCIAL USE ONLY' : '');
  if (opts.scanlines) scanlines(g, W, H);
  return cv;
}

function alertPostText(a, shot) {
  const lines = [
    `${a.label}: ${a.place}${a.placeLine && a.placeLine !== a.place ? ` (${a.placeLine})` : ''}`,
    a.summary,
    `Reported ${stamp(a.t)} by ${a.channel}: ${a.link}`,
    'Unverified. Place and category extracted automatically.',
  ];
  const extra = onMapLines(shot).filter(([k]) => k !== 'REPORTS').map(([k, v]) => `${k[0]}${k.slice(1).toLowerCase()}: ${v.toLowerCase()}`);
  if (extra.length) lines.push(extra.join('. '));
  lines.push(`Credits: ${alertCredits(a, shot).toLowerCase()}`);
  return lines.filter(Boolean).join('\n');
}

/**
 * Opens the share card for one Intel report. `a`: { label, color, iconUrl, place, placeLine,
 * precision, pt: [lon, lat], t, channel, link, summary, conf }.
 */
export async function openAlertCard(a) {
  await fontsReady();
  let icon = null;
  if (a.iconUrl) { icon = new Image(); icon.src = a.iconUrl; try { await icon.decode(); } catch { icon = null; } }
  const state = { fmt: 'wide', zoom: 0, headline: '', scanlines: !$('#crt').classList.contains('off') };
  const shots = new Map();
  let lastShot = null;
  openDialog({
    title: 'SHARE CARD // INTEL ALERT',
    name: () => `cheyenne_alert_${a.place.replace(/[^A-Za-z0-9]+/g, '-').slice(0, 30)}_${isoDay(a.t)}.png`,
    controls: (redraw) => [
      ['FORMAT', seg(Object.entries(FORMATS).map(([k, f]) => [k, f.label, f.hint]), state.fmt, (v) => { state.fmt = v; redraw(); })],
      ['MAP', seg([[-1, 'WIDER'], [0, 'AS SHOWN'], [1, 'CLOSER'], [2, 'CLOSER +']], state.zoom, (v) => { state.zoom = v; redraw(); })],
      ['HEADLINE', h('input', { type: 'text', value: state.headline, placeholder: a.place, maxlength: 60, 'aria-label': 'Headline', oninput: (e) => { state.headline = e.target.value.toUpperCase(); redraw(400); } })],
      ['STYLE', check('SCANLINES', state.scanlines, (v) => { state.scanlines = v; redraw(); })],
    ],
    note: 'THE MAP IS CAPTURED FROM THE BOARD AS IT IS NOW: TURN ON FIRMS, AIS OR IMAGERY FIRST TO INCLUDE THEM.',
    draw: async (signal) => {
      const fmt = FORMATS[state.fmt];
      const [, , mw, mh] = alertLayout(fmt).map;
      const key = `${state.fmt}/${state.zoom}`;
      if (!shots.has(key)) {
        const shot = await captureMap(a.pt, mw / mh, state.zoom, signal);
        if (!shot) return null;
        shots.set(key, shot);
      }
      if (signal.aborted) return null;
      lastShot = shots.get(key);
      return drawAlertCard(fmt, { ...a, icon }, lastShot, state);
    },
    postText: () => (lastShot ? alertPostText(a, lastShot) : ''),
  });
}

// ---------------------------------------------------------------- before / after

/** Picks for the before / after card. Each is { rec, parts } with same-day scenes to stitch. */
export const cmp = { before: null, after: null, vizId: null, km: null };

export function pickCompare(which, rec, vizId) {
  cmp[which] = { rec, parts: sameDay(rec, S.results) };
  if (vizId) cmp.vizId = vizId;
  const other = which === 'before' ? cmp.after : cmp.before;
  toast(other ? `${which.toUpperCase()} SET. BOTH PICKED: MAKE THE CARD FROM THE SCAN PANEL OR HERE` : `${which.toUpperCase()} SET. NOW PICK THE ${which === 'before' ? 'AFTER' : 'BEFORE'} SCENE`);
}

const presetOf = (rec, vizId) => {
  const list = presetsFor(rec.collection, rec.props);
  return list.find((p) => p.id === vizId) || list[0];
};

function gsdText(rec, c) {
  if (rec.collection === 'opendata') return rec.props.gsd ? `${rec.props.gsd} M` : '';
  if (rec.collection === 'nisar-gcov') return 'BROWSE ~120 M';
  if (rec.collection === 'landsat-c2-l2') return '30 M';
  return c && c.gsd ? c.gsd.replace(/\s*\(.*\)/, '') : '';
}

function compareLayout(fmt) {
  const { W, H, u } = fmt;
  const M = 32 * u, top = 84 * u + 78 * u, bottom = H - 58 * u - 14 * u, gap = 20 * u;
  if (W > H) {
    const pw = (W - 2 * M - gap) / 2;
    return [[M, top, pw, bottom - top], [M + pw + gap, top, pw, bottom - top]];
  }
  const ph = (bottom - top - gap) / 2;
  return [[M, top, W - 2 * M, ph], [M, top + ph + gap, W - 2 * M, ph]];
}

const HEAD = 38, CAPTION = 64;
const imageRect = ([x, y, w, hh], u) => [x + 1, y + HEAD * u + 1, w - 2, hh - HEAD * u - CAPTION * u - 2];

/** Centre and half-size (km, of the shorter side) of the compared area. */
function compareArea(aoi) {
  const a = cmp.after.rec, b = cmp.before.rec;
  let lon, lat;
  if (aoi && aoi.type === 'point') { lon = aoi.lon; lat = aoi.lat; }
  else if (aoi && aoi.type === 'box') { lon = (aoi.bbox[0] + aoi.bbox[2]) / 2; lat = (aoi.bbox[1] + aoi.bbox[3]) / 2; }
  else {
    const w = Math.max(a.bbox[0], b.bbox[0]), s = Math.max(a.bbox[1], b.bbox[1]), e = Math.min(a.bbox[2], b.bbox[2]), n = Math.min(a.bbox[3], b.bbox[3]);
    [lon, lat] = e > w && n > s ? [(w + e) / 2, (s + n) / 2] : [(a.bbox[0] + a.bbox[2]) / 2, (a.bbox[1] + a.bbox[3]) / 2];
  }
  return { lon, lat, point: !!(aoi && aoi.type === 'point') };
}

async function renderSide(pick, vizId, box, W, H, signal) {
  const cv = document.createElement('canvas');
  cv.width = W; cv.height = H;
  const g = cv.getContext('2d', { willReadFrequently: true });
  const touches = (r) => !(r.bbox[0] > box[2] || r.bbox[2] < box[0] || r.bbox[1] > box[3] || r.bbox[3] < box[1]);
  const parts = pick.parts.filter((r) => r === pick.rec || touches(r)).sort((x, y) => (y.cloud ?? 0) - (x.cloud ?? 0));
  let err = null;
  for (const r of parts) {
    try { await drawScene(g, r, presetOf(r, vizId), box, W, H, signal); } catch (e) { if (signal.aborted) throw e; err = e; }
  }
  return { cv, cover: coverage(g, W, H), err };
}

async function drawCompareCard(fmt, area, km, sides, opts) {
  const { W, H, u } = fmt;
  const cv = document.createElement('canvas');
  cv.width = W; cv.height = H;
  const g = cv.getContext('2d');
  background(g, W, H);
  header(g, W, u, 'BEFORE / AFTER', '');
  const M = 32 * u;
  const [b, a] = [cmp.before.rec, cmp.after.rec];
  const days = Math.round(Math.abs(a.time - b.time) / DAY);
  // Title row.
  const title = opts.headline || (a.props.event ? a.props.event.title.replace(/[-_]+/g, ' ').toUpperCase() : fmtPos([area.lon, area.lat], 3));
  const coords = fmtPos([area.lon, area.lat], 3);
  const right = `${title === coords ? '' : `${coords}  //  `}${(km * 2).toFixed(km < 2.5 ? 1 : 0)} KM ACROSS`;
  setFont(g, 13 * u, { ls: 0.1 });
  const rw = g.measureText(right).width;
  const tl = wrap(g, title, W - 2 * M - rw - 40 * u, 1, 30 * u, { display: true, ls: 0.08 });
  text(g, tl[0] || '', M, 84 * u + 46 * u, 30 * u, INK_HI, { display: true, ls: 0.08, glow: 'rgba(143, 245, 221, 0.35)' });
  text(g, right, W - M, 84 * u + 30 * u, 13 * u, INK_DIM, { align: 'right', ls: 0.1 });
  text(g, `${days} DAY${days === 1 ? '' : 'S'} APART`, W - M, 84 * u + 50 * u, 13 * u, AMBER, { align: 'right', ls: 0.12, weight: 600 });

  const rects = compareLayout(fmt);
  const credits = new Set();
  ['before', 'after'].forEach((which, i) => {
    const pick = cmp[which], rec = pick.rec, c = S.cons.get(rec.cid);
    const side = sides[i];
    const [x, y, w, hh] = rects[i];
    panel(g, x, y, w, hh, u, which.toUpperCase(), { right: isoDay(rec.time), rightColor: AMBER });
    const [ix, iy, iw, ih] = imageRect(rects[i], u);
    g.fillStyle = '#000'; g.fillRect(ix, iy, iw, ih);
    g.drawImage(side.cv, ix, iy, iw, ih);
    if (side.cover < 0.02) text(g, side.err ? 'IMAGE UNAVAILABLE' : 'NO DATA OVER THIS AREA', ix + iw / 2, iy + ih / 2, 16 * u, AMBER, { align: 'center', ls: 0.12 });
    if (area.point) {
      const cx = ix + iw / 2, cy = iy + ih / 2;
      g.strokeStyle = 'rgba(226, 255, 247, 0.75)'; g.lineWidth = 1.5 * u;
      for (const [dx, dy] of [[0, -1], [1, 0], [0, 1], [-1, 0]]) { g.beginPath(); g.moveTo(cx + dx * 14 * u, cy + dy * 14 * u); g.lineTo(cx + dx * 30 * u, cy + dy * 30 * u); g.stroke(); }
    }
    scaleBar(g, ix + 18 * u, iy + ih - 18 * u, u, mPerPx(side.box[2] - side.box[0], iw, area.lat));
    // Caption: date large, sensor and visualisation beneath.
    const capY = iy + ih + 1;
    g.fillStyle = LINE; g.fillRect(x, capY, w, 1);
    const dateW = text(g, dayText(rec.time), x + 16 * u, capY + 30 * u, 24 * u, INK_HI, { display: true, ls: 0.1 });
    text(g, `${hhmm(rec.time)}Z`, x + 26 * u + dateW, capY + 30 * u, 15 * u, INK, { display: true, ls: 0.1 });
    const name = c ? c.name : rec.platform;
    const sensor = [name, rec.platform && rec.platform !== name ? rec.platform : '', presetOf(rec, cmp.vizId).label, gsdText(rec, c)].filter(Boolean).join('  ·  ');
    const sl = wrap(g, sensor, w - 32 * u, 1, 13 * u, { weight: 500, ls: 0.08 });
    text(g, sl[0] || '', x + 16 * u, capY + 52 * u, 13 * u, INK, { weight: 500, ls: 0.08 });
    if (rec.cloud !== null && rec.cloud !== undefined) {
      setFont(g, 12 * u, { weight: 500, ls: 0.1 });
      const t = `${Math.round(rec.cloud)}% CLOUD`;
      tag(g, x + w - 16 * u - g.measureText(t).width - 12 * u, capY + 14 * u, t, u, rec.cloud > 30 ? AMBER : INK);
    }
    brackets(g, x - 4 * u, y - 4 * u, w + 8 * u, hh + 8 * u, u, which === 'after' ? AMBER : INK);
    credits.add(creditFor(rec));
  });
  const nc = nonCommercial(b) || nonCommercial(a);
  footer(g, W, H, u, [...credits].filter(Boolean).join('  ·  '), nc ? 'IMAGERY CC BY-NC 4.0: NON-COMMERCIAL USE ONLY, CREDIT THE PROVIDER' : '');
  if (opts.scanlines) scanlines(g, W, H);
  return cv;
}

const RADII = [[0.25, '0.5 KM'], [0.5, '1 KM'], [1, '2 KM'], [2.5, '5 KM'], [5, '10 KM'], [12.5, '25 KM'], [25, '50 KM']];

/** Opens the share card for the current before / after picks. `aoi` is the area of the last scan. */
export async function openCompareCard(aoi) {
  if (!cmp.before || !cmp.after) return;
  if (cmp.before.rec.time > cmp.after.rec.time) {
    [cmp.before, cmp.after] = [cmp.after, cmp.before];
    toast('BEFORE WAS THE LATER SCENE: SWAPPED SO THE CARD READS IN DATE ORDER');
  }
  await fontsReady();
  const area = compareArea(aoi);
  const vhr = [cmp.before.rec, cmp.after.rec].some((r) => r.collection === 'opendata');
  const radar = [cmp.before.rec, cmp.after.rec].every((r) => r.collection === 'nisar-gcov');
  const state = { fmt: 'wide', km: cmp.km || (vhr ? 0.5 : radar ? 12.5 : 2.5), headline: '', scanlines: !$('#crt').classList.contains('off') };
  const cache = new Map();
  openDialog({
    title: 'SHARE CARD // BEFORE / AFTER',
    name: () => `cheyenne_before-after_${isoDay(cmp.before.rec.time)}_${isoDay(cmp.after.rec.time)}.png`,
    controls: (redraw) => [
      ['FORMAT', seg(Object.entries(FORMATS).map(([k, f]) => [k, f.label, f.hint]), state.fmt, (v) => { state.fmt = v; redraw(); })],
      ['AREA', seg(RADII.map(([k, l]) => [k, l]), state.km, (v) => { state.km = v; cmp.km = v; redraw(); })],
      ['HEADLINE', h('input', { type: 'text', value: state.headline, placeholder: 'EVENT OR PLACE NAME', maxlength: 60, 'aria-label': 'Headline', oninput: (e) => { state.headline = e.target.value.toUpperCase(); redraw(400); } })],
      ['STYLE', check('SCANLINES', state.scanlines, (v) => { state.scanlines = v; redraw(); })],
    ],
    note: `AREA IS THE WIDTH OF THE SHORTER SIDE, ${area.point ? 'CENTRED ON THE FOCUS POINT' : 'CENTRED ON THE SCANNED AREA'}. IMAGES ARE FETCHED AT CARD RESOLUTION.`,
    draw: async (signal, progress) => {
      const fmt = FORMATS[state.fmt];
      const rects = compareLayout(fmt).map((r) => imageRect(r, fmt.u));
      const sides = [];
      for (const [i, which] of ['before', 'after'].entries()) {
        const [, , iw, ih] = rects[i];
        const W = Math.round(iw), H = Math.round(ih);
        const half = iw >= ih ? state.km : state.km * (ih / iw);
        const box = boxAround(area.lon, area.lat, half, iw / ih);
        const key = `${which}/${cmp[which].rec.id}/${cmp.vizId}/${state.km}/${W}x${H}`;
        if (!cache.has(key)) {
          progress(`FETCHING ${which.toUpperCase()} IMAGE…`);
          cache.set(key, await renderSide(cmp[which], cmp.vizId, box, W, H, signal));
        }
        sides.push({ ...cache.get(key), box });
        if (signal.aborted) return null;
      }
      return drawCompareCard(fmt, area, state.km, sides, state);
    },
    postText: () => {
      const line = (which) => { const r = cmp[which].rec, c = S.cons.get(r.cid); return `${which[0].toUpperCase()}${which.slice(1)}: ${dayText(r.time)}, ${c ? c.name : r.platform} ${r.platform}, ${presetOf(r, cmp.vizId).label.toLowerCase()}`; };
      const credits = [...new Set([creditFor(cmp.before.rec), creditFor(cmp.after.rec)])].filter(Boolean).join('; ');
      return [state.headline || '', `${fmtPos([area.lon, area.lat], 3)}`, line('before'), line('after'), `Credits: ${credits.toLowerCase()}`].filter(Boolean).join('\n');
    },
  });
}

/** BEFORE / AFTER buttons for a scene's detail panel. */
export function compareButtons(rec, vizId, rerender, aoi) {
  const is = (w) => cmp[w] && cmp[w].rec.id === rec.id;
  const both = cmp.before && cmp.after && cmp.before.rec.id !== cmp.after.rec.id;
  return h('div', { class: 'sect' },
    h('h3', null, 'BEFORE / AFTER CARD', both ? h('span', null, `${isoDay(cmp.before.rec.time)} > ${isoDay(cmp.after.rec.time)}`) : null),
    h('div', { class: 'btnrow' },
      h('button', { class: is('before') ? 'on' : '', title: 'Use this scene as the earlier image of a before / after card', onclick: () => { pickCompare('before', rec, vizId); rerender(); } }, is('before') ? 'BEFORE ✓' : 'SET AS BEFORE'),
      h('button', { class: is('after') ? 'on' : '', title: 'Use this scene as the later image of a before / after card', onclick: () => { pickCompare('after', rec, vizId); rerender(); } }, is('after') ? 'AFTER ✓' : 'SET AS AFTER'),
      both ? h('button', { class: 'primary', onclick: () => openCompareCard(aoi) }, 'MAKE CARD') : null),
    h('div', { class: 'note', style: { padding: '6px 0 0' } }, 'PICK TWO SCENES, FROM ANY FLEET, TO SHOW SIDE BY SIDE WITH THEIR DATES AND SENSORS.'));
}

/** The BEFORE / AFTER section of the mission panel: quick picks from the last scan's scenes. */
export function compareSection(con, aoi, scenes, rerender) {
  if (!scenes.length && !cmp.before && !cmp.after) return null;
  const sorted = [...scenes].sort((x, y) => y.time - x.time);
  // Defaults until the user picks: for free releases the newest pre-event and post-event images,
  // otherwise oldest and newest. A default from another fleet's scan is replaced.
  const stale = (w) => !cmp[w] || (cmp[w].auto && !sorted.includes(cmp[w].rec));
  // Clearest scene of the older half and of the newer half (ties go to the older / newer).
  const clearest = (list) => list.reduce((best, r) => ((r.cloud ?? 0) < (best.cloud ?? 0) - 2 ? r : best), list[0]);
  const half = Math.ceil(sorted.length / 2);
  if (stale('before')) {
    const pre = sorted.filter((r) => r.props.phase === 'pre');
    cmp.before = sorted.length > 1 ? { rec: pre[0] || clearest(sorted.slice(half).reverse()) || sorted[sorted.length - 1], parts: null, auto: true } : null;
  }
  if (stale('after')) {
    const post = sorted.filter((r) => r.props.phase === 'post');
    cmp.after = sorted.length ? { rec: post[0] || clearest(sorted.slice(0, half)), parts: null, auto: true } : null;
  }
  if (!cmp.before && !cmp.after) return null;
  for (const w of ['before', 'after']) if (cmp[w] && !cmp[w].parts) cmp[w].parts = sameDay(cmp[w].rec, S.results);
  const label = (r) => `${isoDay(r.time)}  ${r.platform}${r.cloud !== null && r.cloud !== undefined ? `  ${Math.round(r.cloud)}%` : ''}${r.props.phase ? `  ${r.props.phase.toUpperCase()}` : ''}`;
  const select = (which) => {
    const cur = cmp[which];
    const extra = cur && !sorted.some((r) => r.id === cur.rec.id) ? [cur.rec] : [];
    return h('select', { 'aria-label': `${which} scene`, onchange: (e) => {
      const rec = [...extra, ...sorted].find((r) => r.id === e.target.value);
      if (rec) { cmp[which] = { rec, parts: sameDay(rec, S.results) }; rerender(); }
    } },
    extra.map((r) => h('option', { value: r.id, selected: true }, `${(S.cons.get(r.cid) || {}).name || ''}: ${label(r)}`)),
    sorted.map((r) => h('option', { value: r.id, selected: cur && cur.rec.id === r.id }, label(r))));
  };
  const ref = (cmp.after || cmp.before).rec;
  const presets = presetsFor(ref.collection, ref.props);
  if (!presets.some((p) => p.id === cmp.vizId)) cmp.vizId = presets[0] ? presets[0].id : null;
  const same = cmp.before && cmp.after && cmp.before.rec.id === cmp.after.rec.id;
  const ready = cmp.before && cmp.after && !same;
  return h('div', { class: 'sect' },
    h('h3', null, 'BEFORE / AFTER', h('span', null, 'SHARE CARD')),
    h('div', { class: 'ctl' },
      h('span', { class: 'k' }, 'BEFORE'), select('before'),
      h('span', { class: 'k' }, 'AFTER'), select('after'),
      presets.length > 1 ? h('span', { class: 'k' }, 'RENDER') : null,
      presets.length > 1 ? h('select', { 'aria-label': 'Visualisation', onchange: (e) => { cmp.vizId = e.target.value; } },
        presets.map((p) => h('option', { value: p.id, selected: p.id === cmp.vizId }, p.label))) : null),
    h('div', { class: 'aoi-note', style: { marginTop: '6px' } }, same ? 'BEFORE AND AFTER ARE THE SAME SCENE.'
      : 'OR USE SET AS BEFORE / AFTER IN ANY SCENE’S DETAIL, FROM ANY FLEET. SAME-DAY SCENES ARE STITCHED.'),
    h('div', { class: 'btnrow' }, h('button', { class: 'primary wide', disabled: !ready, onclick: () => openCompareCard(aoi) }, 'MAKE CARD')));
}

// ---------------------------------------------------------------- dialog

function seg(options, current, onPick) {
  return h('div', { class: 'seg' }, options.map(([val, label, title]) => h('button', { class: val === current ? 'on' : '', title,
    onclick: (e) => { for (const b of e.currentTarget.parentNode.children) b.classList.remove('on'); e.currentTarget.classList.add('on'); onPick(val); } }, label)));
}

function check(label, on, onChange) {
  return h('label', { class: 'c-check' }, h('input', { type: 'checkbox', checked: on, onchange: (e) => onChange(e.target.checked) }), label);
}

let keys = null;
function closeDialog() {
  $('#modal').hidden = true;
  $('#modal').replaceChildren();
  if (keys) { document.removeEventListener('keydown', keys); keys = null; }
}

function openDialog({ title, controls, note, draw, postText, name }) {
  const preview = h('img', { alt: 'Share card preview' });
  const status = h('div', { class: 'c-status' }, 'COMPOSING…');
  const post = h('textarea', { rows: 6, spellcheck: 'false', 'aria-label': 'Suggested post text' });
  let blob = null, job = null, timer = null, url = null;
  const buttons = {};
  const setBusy = (busy) => { for (const b of Object.values(buttons)) b.disabled = busy || !blob; };
  const redraw = (delay = 0) => {
    clearTimeout(timer);
    timer = setTimeout(async () => {
      if (job) job.abort();
      const ctrl = job = new AbortController();
      blob = null; status.className = 'c-status'; status.textContent = 'COMPOSING…'; setBusy(true);
      try {
        const cv = await draw(ctrl.signal, (msg) => { status.textContent = msg; });
        if (!cv || ctrl.signal.aborted) return;
        blob = await new Promise((r) => cv.toBlob(r, 'image/png'));
        if (url) URL.revokeObjectURL(url);
        url = URL.createObjectURL(blob);
        preview.src = url;
        post.value = postText();
        status.textContent = `${cv.width} × ${cv.height} PNG, ${(blob.size / 1e6).toFixed(1)} MB`;
        status.className = 'c-status done';
      } catch (e) {
        if (ctrl.signal.aborted) return;
        status.textContent = `COULD NOT COMPOSE: ${e.message}`.toUpperCase(); status.className = 'c-status err';
      } finally {
        if (job === ctrl) { job = null; setBusy(false); }
      }
    }, delay);
  };
  const save = () => { const a = h('a', { href: url, download: name() }); document.body.append(a); a.click(); a.remove(); };
  const copy = async () => {
    try { await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]); toast('CARD COPIED TO THE CLIPBOARD'); }
    catch (e) { toast(`COPY FAILED: ${e.message}`.toUpperCase(), true, 4000); }
  };
  const share = async () => {
    const file = new File([blob], name(), { type: 'image/png' });
    try { await navigator.share({ files: [file], text: post.value }); } catch (e) { if (e.name !== 'AbortError') toast(`SHARE FAILED: ${e.message}`.toUpperCase(), true, 4000); }
  };
  const canShare = !!(navigator.canShare && navigator.canShare({ files: [new File([new Blob()], 'x.png', { type: 'image/png' })] }));
  buttons.save = h('button', { class: 'primary', onclick: save }, 'SAVE PNG');
  buttons.copy = window.ClipboardItem ? h('button', { onclick: copy }, 'COPY IMAGE') : null;
  buttons.share = canShare ? h('button', { onclick: share }, 'SHARE…') : null;
  for (const k of Object.keys(buttons)) if (!buttons[k]) delete buttons[k];
  const close = () => { if (job) job.abort(); clearTimeout(timer); if (url) URL.revokeObjectURL(url); closeDialog(); };
  const box = $('#modal');
  box.replaceChildren(h('div', { class: 'modal-box panel card-box', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'c-title' },
    h('div', { class: 'panel-head' }, h('span', { id: 'c-title' }, title), h('button', { class: 'x', title: 'Close', onclick: close }, 'X')),
    h('div', { class: 'panel-body c-body' },
      h('div', { class: 'c-preview' }, preview, status),
      h('div', { class: 'c-side' },
        h('div', { class: 'ctl' }, controls(redraw).map(([k, el]) => [h('span', { class: 'k' }, k), el])),
        h('div', { class: 'aoi-note', style: { marginTop: '8px' } }, note),
        h('div', { class: 'c-post' }, h('span', { class: 'k' }, 'SUGGESTED POST TEXT'), post,
          h('button', { onclick: () => navigator.clipboard.writeText(post.value).then(() => toast('TEXT COPIED')) }, 'COPY TEXT')))),
    h('div', { class: 'g-foot' }, h('div', { class: 'g-actions' }, Object.values(buttons), h('button', { onclick: close }, 'CLOSE')))));
  box.hidden = false;
  if (keys) document.removeEventListener('keydown', keys);
  keys = (e) => { if (e.key === 'Escape') close(); };
  document.addEventListener('keydown', keys);
  redraw();
}

