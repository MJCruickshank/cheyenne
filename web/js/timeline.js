// Acquisition timeline: one lane per platform, past scenes solid, future passes hollow.

import { S, on, clock } from './state.js';
import { hoverRecord, selectRecord } from './mission.js';
import { showTip, hideTip } from './hud.js';
import { $, DAY, dayMon, stamp } from './util.js';

const C = { ink: '#8ff5dd', dim: '#3f9c8b', faint: '#17564d', amber: '#ffb300', white: '#e2fff7', bg: '#010608' };
const PAD_L = 54, PAD_R = 14, PAD_T = 8, AXIS_H = 20;

let canvas, ctx, W = 0, H = 0, dpr = 1;
let lanes = [];              // platform labels
let hits = [];               // { x, y0, y1, id }

function range() {
  const m = S.resultMeta;
  const now = clock.now();
  if (m && m.t0) return [m.t0, m.t1];
  return [now - S.pastDays * DAY, now + Math.max(1, S.futureDays) * DAY];
}

function resize() {
  const box = canvas.parentElement.getBoundingClientRect();
  dpr = window.devicePixelRatio || 1;
  W = Math.max(50, Math.floor(box.width)); H = Math.max(30, Math.floor(box.height));
  canvas.width = W * dpr; canvas.height = H * dpr;
  draw();
}

export function draw() {
  if (!ctx) return;
  const [t0, t1] = range();
  const now = clock.now();
  const x = (t) => PAD_L + ((t - t0) / (t1 - t0)) * (W - PAD_L - PAD_R);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, W, H);
  const has = S.active && S.results.length > 0;
  $('#timeline-empty').style.display = has ? 'none' : 'grid';
  $('#timeline-empty').textContent = S.active ? 'NO ACQUISITIONS PLOTTED' : 'SELECT A CONSTELLATION TO PLOT ACQUISITIONS';
  hits = [];
  if (!has) return;

  lanes = [...new Set(S.results.map((r) => r.platform))].sort((a, b) => a.localeCompare(b, 'en', { numeric: true }));
  const shown = lanes.slice(0, 7);
  const laneH = (H - PAD_T - AXIS_H) / shown.length;
  const laneOf = (p) => Math.min(shown.length - 1, Math.max(0, shown.indexOf(p)));

  // future shading and axis
  ctx.fillStyle = 'rgba(255,179,0,0.05)';
  ctx.fillRect(x(now), PAD_T, Math.max(0, W - PAD_R - x(now)), H - PAD_T - AXIS_H);
  ctx.font = '9px "IBM Plex Mono", monospace';
  ctx.textBaseline = 'middle';
  const days = (t1 - t0) / DAY;
  const pxPerDay = (W - PAD_L - PAD_R) / days;
  const every = [1, 2, 7, 14, 28, 91, 182, 364].find((n) => n * pxPerDay >= 58) || 728;
  const minor = pxPerDay >= 6 ? 1 : every;                 // skip daily ticks when they would smear together
  const first = Math.ceil(t0 / DAY) * DAY;
  for (let t = first; t <= t1; t += DAY) {
    const idx = Math.round(t / DAY);
    if (idx % minor !== 0) continue;
    const px = Math.round(x(t)) + 0.5;
    const major = idx % every === 0;
    ctx.strokeStyle = major ? C.faint : 'rgba(23,86,77,0.45)';
    ctx.beginPath(); ctx.moveTo(px, PAD_T); ctx.lineTo(px, H - AXIS_H + (major ? 4 : 0)); ctx.stroke();
    if (major) { ctx.fillStyle = C.dim; ctx.textAlign = 'left'; ctx.fillText(days > 300 ? `${dayMon(t)}${String(new Date(t).getUTCFullYear()).slice(2)}` : dayMon(t), px + 3, H - AXIS_H / 2 + 1); }
  }
  ctx.strokeStyle = C.faint;
  ctx.beginPath(); ctx.moveTo(PAD_L, H - AXIS_H + 0.5); ctx.lineTo(W - PAD_R, H - AXIS_H + 0.5); ctx.stroke();

  // lanes
  shown.forEach((p, i) => {
    const y = PAD_T + i * laneH;
    ctx.fillStyle = C.ink; ctx.textAlign = 'right';
    ctx.fillText(p + (i === shown.length - 1 && lanes.length > shown.length ? '+' : ''), PAD_L - 8, y + laneH / 2);
    if (i > 0) { ctx.strokeStyle = 'rgba(23,86,77,0.35)'; ctx.beginPath(); ctx.moveTo(PAD_L, Math.round(y) + 0.5); ctx.lineTo(W - PAD_R, Math.round(y) + 0.5); ctx.stroke(); }
  });

  // marks
  const mark = (r, style) => {
    const px = x(r.time);
    if (px < PAD_L - 2 || px > W - PAD_R + 2) return;
    const y = PAD_T + laneOf(r.platform) * laneH;
    const y0 = y + Math.max(1.5, laneH * 0.14), y1 = y + laneH - Math.max(1.5, laneH * 0.14);
    hits.push({ x: px, y0: y, y1: y + laneH, id: r.id });
    if (style === 'sel' || style === 'hover') {
      ctx.fillStyle = style === 'sel' ? C.amber : C.white;
      ctx.fillRect(Math.round(px) - 2, y0 - 1, 4, y1 - y0 + 2);
      if (style === 'sel') { ctx.beginPath(); ctx.moveTo(px - 5, PAD_T - 6); ctx.lineTo(px + 5, PAD_T - 6); ctx.lineTo(px, PAD_T); ctx.fill(); }
    } else if (r.kind === 'scene') {
      ctx.globalAlpha = r.cloud !== null ? 1 - Math.min(0.75, r.cloud / 130) : 0.9;
      ctx.fillStyle = r.color;
      ctx.fillRect(Math.round(px) - 1, y0, 2, y1 - y0);
      ctx.globalAlpha = 1;
    } else {
      ctx.strokeStyle = r.color; ctx.globalAlpha = r.past ? 0.4 : 1; ctx.lineWidth = 1;
      ctx.strokeRect(Math.round(px) - 1.5, y0 + 0.5, 3, y1 - y0 - 1);
      ctx.globalAlpha = 1;
    }
  };
  for (const r of S.results) if (r.id !== S.selected && r.id !== S.hovered) mark(r);
  const hov = S.hovered && S.results.find((r) => r.id === S.hovered);
  const sel = S.selected && S.results.find((r) => r.id === S.selected);
  if (hov) mark(hov, 'hover');
  if (sel) mark(sel, 'sel');

  // now line
  const nx = Math.round(x(now)) + 0.5;
  if (nx >= PAD_L && nx <= W - PAD_R) {
    ctx.strokeStyle = C.amber; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(nx, 2); ctx.lineTo(nx, H - AXIS_H + 4); ctx.stroke();
    ctx.fillStyle = C.amber; ctx.textAlign = nx > W - 60 ? 'right' : 'left';
    ctx.fillText('NOW', nx + (nx > W - 60 ? -4 : 4), H - AXIS_H / 2 + 1);
  }
}

function nearest(ev) {
  const box = canvas.getBoundingClientRect();
  const mx = ev.clientX - box.left, my = ev.clientY - box.top;
  let best = null, bd = 7;
  for (const hgt of hits) {
    const inLane = my >= hgt.y0 && my <= hgt.y1;
    const d = Math.abs(hgt.x - mx) + (inLane ? 0 : 3);
    if (d < bd) { bd = d; best = hgt; }
  }
  return best;
}

export function initTimeline() {
  canvas = $('#timeline-canvas');
  ctx = canvas.getContext('2d');
  new ResizeObserver(resize).observe(canvas.parentElement);
  canvas.addEventListener('mousemove', (ev) => {
    const hit = nearest(ev);
    hoverRecord(hit ? hit.id : null);
    if (hit) {
      const r = S.results.find((q) => q.id === hit.id);
      showTip(ev.clientX, ev.clientY, `${r.platform}  ${stamp(r.time)}`, r.kind === 'scene' ? (r.cloud !== null ? `${r.cloud.toFixed(0)}% CLOUD` : r.sub.join(' ')) : (r.kind === 'planned' ? 'PLANNED' : 'PREDICTED'));
    } else hideTip();
  });
  canvas.addEventListener('mouseleave', () => { hoverRecord(null); hideTip(); });
  canvas.addEventListener('click', (ev) => { const hit = nearest(ev); if (hit) selectRecord(hit.id); });
  on('results', draw);
  on('selected', draw);
  on('hovered', draw);
  on('active', draw);
  let last = 0;
  on('tick', (now) => { if (Math.abs(now - last) > 15000) { last = now; draw(); } });
  on('clock', draw);
  document.fonts && document.fonts.ready.then(draw);
  resize();
}
