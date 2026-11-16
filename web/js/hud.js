// Small heads-up-display pieces shared by every panel: link lamps, tooltip, boot log.

import { $, h } from './util.js';

const LAMPS = [
  ['orbit', 'ORBIT DATA'],
  ['archive', 'ARCHIVE'],
  ['tasking', 'TASKING'],
  ['imagery', 'IMAGERY'],
  ['intel', 'INTEL'],
];

export function initLamps() {
  $('#lamps').replaceChildren(...LAMPS.map(([id, label]) => h('div', { class: 'lamp', id: `lamp-${id}`, title: `${label}: standby` }, h('i'), label)));
}

/** state: '' (standby) | 'ok' | 'busy' | 'warn' | 'down' */
export function setLamp(id, state, note) {
  const el = $(`#lamp-${id}`);
  if (!el) return;
  el.className = `lamp ${state}`.trim();
  const label = LAMPS.find((l) => l[0] === id)[1];
  el.title = `${label}: ${note || { ok: 'nominal', busy: 'working', warn: 'degraded', down: 'no link', '': 'standby' }[state]}`;
}

const tip = () => $('#tooltip');

export function showTip(x, y, title, sub) {
  const el = tip();
  el.replaceChildren(title, sub ? h('span', { class: 'muted' }, sub) : '');
  el.hidden = false;
  const w = el.offsetWidth, ht = el.offsetHeight;
  el.style.left = `${Math.min(window.innerWidth - w - 8, x + 14)}px`;
  el.style.top = `${Math.max(8, Math.min(window.innerHeight - ht - 8, y - ht - 10))}px`;
}

export function hideTip() {
  tip().hidden = true;
}

// The floating card shared by footprint lists, fire detections and Intel reports.
export function closePicker() {
  const el = $('#picker');
  el.hidden = true;
  el.classList.remove('wide');
}

export function placePicker(x, y) {
  const el = $('#picker');
  el.hidden = false;
  hideTip();
  const w = el.offsetWidth, ht = el.offsetHeight;
  el.style.left = `${Math.max(10, Math.min(window.innerWidth - w - 10, x + 12))}px`;
  el.style.top = `${Math.max(70, Math.min(window.innerHeight - ht - 120, y - 20))}px`;
}

export function bootLine(text, cls) {
  const log = $('#boot-log');
  if (!log) return;
  log.append(h('span', { class: cls || '' }, `> ${text}\n`));
}

export function bootDone() {
  const el = $('#boot');
  el.classList.add('done');
  setTimeout(() => el.remove(), 800);
}
