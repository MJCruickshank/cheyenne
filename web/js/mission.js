// Right-hand panel and the controller behind it: constellation facts, acquisition scan,
// results, scene detail (visualise / download) and daily global mosaics.

import { S, on, emit, clock } from './state.js';
import { map, showRaster, hideRaster, setRasterOpacity, fitTo, syncPadding } from './globe.js';
import { fleet } from './tracker.js';
import { live } from './board.js';
import { currentAOI, aoiCentre, searchScenes, fetchPlans, predictAccess, fetchItem, BOX_ZOOM } from './archive.js';
import { presetsFor, QUALITY, tileTemplate, quicklookUrl, exportUrl, downloadUrl, gibsTemplate, primaryAssets, PC } from './viz.js';
import { setLamp } from './hud.js';
import { $, h, DAY, stamp, dtg, tRel, fmtPos, fmtLat, fmtLon, isoDay, toast } from './util.js';

const PAST = [[1, '24H'], [3, '3D'], [7, '7D'], [14, '14D'], [30, '30D'], [90, '90D']];
const FUTURE = [[0, 'OFF'], [3, '+3D'], [7, '+7D'], [14, '+14D']];
const MAX_RENDERED = 6;

let view = 'main';                    // 'main' | 'detail'
let tab = 'acquired';                 // 'acquired' | 'future'
let busy = false;
let progress = null;
let abort = null;
let aoiStale = false;
let satRefs = new Map();
const detail = { item: null, itemFor: null, itemErr: null, vizId: null, quality: 'std', opacity: 1 };
const gibs = { layer: null, date: isoDay(Date.now() - DAY), opacity: 1 };

const con = () => (S.active ? S.cons.get(S.active) : null);
const canScan = (c) => !!c && !!c.geom && !c.gibs;          // daily-mosaic sensors see everywhere every day
const recById = (id) => S.results.find((r) => r.id === id) || (S.rendered.get(id) || {}).rec || null;

// ================================================================ controller

export function setActive(cid) {
  if (S.active === cid) return;
  if (abort) abort.abort();
  S.active = cid;
  S.results = []; S.resultMeta = {}; S.selected = null; S.hovered = null;
  view = 'main'; tab = 'acquired'; busy = false; aoiStale = false;
  if (cid) S.visible.add(cid);
  emit('visible'); emit('active'); emit('results'); emit('selected');
  if (cid) scan();
}

export function setTarget(pt, fly = false) {
  S.target = pt;
  S.aoiMode = pt ? 'target' : 'view';
  S.designating = false;
  $('#globe').classList.remove('designating');
  emit('aoi');
  if (pt && fly) map.flyTo({ center: pt, zoom: Math.max(map.getZoom(), 8), duration: 1800 });
  if (S.active) scan(); else render();
}

export function hoverRecord(id) {
  if (S.hovered === id) return;
  S.hovered = id;
  emit('hovered');
}

export function selectRecord(id, { fly = true } = {}) {
  S.selected = id;
  const rec = id && recById(id);
  if (rec) {
    view = 'detail';
    if (rec.kind === 'scene' && detail.itemFor !== rec.id) {
      detail.item = null; detail.itemErr = null; detail.itemFor = rec.id;
      const r = S.rendered.get(rec.id);
      detail.vizId = r ? r.vizId : (presetsFor(rec.collection, rec.props)[0] || {}).id;
      if (r) { detail.quality = r.quality; detail.opacity = r.opacity; }
      fetchItem(rec).then((item) => {
        if (detail.itemFor === rec.id) { detail.item = item; if (view === 'detail') render(); }
      }).catch((e) => {
        if (detail.itemFor === rec.id) { detail.itemErr = e.message; if (view === 'detail') render(); }
      });
    }
    if (fly && rec.kind === 'scene') {
      const b = map.getBounds();
      const [w, s, e, n] = rec.bbox;
      const inView = w < b.getEast() && e > b.getWest() && s < b.getNorth() && n > b.getSouth();
      if (!inView) fitTo(rec.bbox, { maxZoom: 8 });
    }
  } else {
    view = 'main';
  }
  emit('selected');
}

export async function scan() {
  const c = con();
  if (!canScan(c)) return;
  if (abort) abort.abort();
  abort = new AbortController();
  const signal = abort.signal;
  const aoi = currentAOI();
  const now = clock.now();
  const wide = aoi.type === 'global';
  // Timeline window: the lookback only applies where there is an archive to look back into.
  const ranged = S.custom && S.from && S.to && c.archive && !wide;
  const from = ranged ? Date.parse(`${S.from}T00:00:00Z`) : now - S.pastDays * DAY;
  const until = ranged ? Math.min(Date.parse(`${S.to}T23:59:59Z`), Date.now() + 60000) : Math.min(now, Date.now()) + 60000;
  const back = c.archive && !wide ? now - from : c.plan ? DAY : 3600000;
  const meta = {
    aoi, now, t0: now - back, notes: [], futureKind: null,
    t1: ranged && S.futureDays === 0 ? until : now + Math.max(S.futureDays * DAY, 3600000),
  };
  const found = [];
  const jobs = [];
  busy = true; progress = null; aoiStale = false;
  emit('aoi');
  render();

  if (c.archive) {
    if (wide) {
      meta.notes.push({ cls: 'warn', text: 'WIDE VIEW. ARCHIVE SCENES NEED AN AREA: ZOOM IN OR DESIGNATE A FOCUS. SHOWING GLOBAL TASKING ONLY.' });
      setLamp('archive', '');
    } else {
      setLamp('archive', 'busy');
      jobs.push(searchScenes(c, aoi, from, until, S.cloudMax, signal).then((r) => {
        found.push(...r.records);
        if (r.truncated) meta.notes.push({ cls: 'warn', text: `SHOWING THE ${r.records.length} MOST RECENT SCENES. NARROW THE AREA OR LOOKBACK FOR THE REST.` });
        setLamp('archive', 'ok');
      }).catch((e) => {
        if (signal.aborted) return;
        meta.notes.push({ cls: 'err', text: `ARCHIVE SEARCH FAILED: ${e.message}` });
        setLamp('archive', 'down', e.message);
      }));
    }
  }

  if (S.futureDays > 0 && c.geom) {
    const predicted = () => {
      const centre = aoiCentre(aoi);
      meta.futureKind = 'predicted';
      if (aoi.type !== 'point') meta.notes.push({ cls: '', text: `ACCESS PREDICTED FOR VIEW CENTRE ${fmtPos(centre, 2)}. DESIGNATE A FOCUS FOR A FIXED POINT.` });
      return predictAccess(c, centre, now, now + S.futureDays * DAY, (p) => { progress = p; paintProgress(); }).then((recs) => {
        if (!signal.aborted) found.push(...recs);
      });
    };
    if (c.plan) {
      setLamp('tasking', 'busy');
      const ahead = wide ? Math.min(S.futureDays, 2) : S.futureDays;
      meta.futureKind = 'planned';
      if (wide) meta.t1 = now + ahead * DAY;
      jobs.push(fetchPlans(c, aoi, now - DAY, now + ahead * DAY, signal).then((r) => {
        found.push(...r.records);
        meta.planSources = r.sources;
        if (r.truncated) meta.notes.push({ cls: 'warn', text: 'TASKING PLAN TRUNCATED. ZOOM IN FOR THE FULL SCHEDULE.' });
        setLamp('tasking', 'ok');
      }).catch((e) => {
        if (signal.aborted) return null;
        meta.notes.push({ cls: 'warn', text: `ESA TASKING PLAN UNAVAILABLE (${e.message}). FALLING BACK TO ORBITAL PREDICTION.` });
        setLamp('tasking', 'warn', e.message);
        return predicted();
      }));
    } else {
      jobs.push(predicted());
    }
  }

  await Promise.all(jobs);
  if (signal.aborted) return;
  busy = false; progress = null;
  const keepSel = S.selected && (found.some((r) => r.id === S.selected) || S.rendered.has(S.selected));
  S.results = found;
  S.resultMeta = meta;
  if (!keepSel) { S.selected = null; view = 'main'; }
  const nAcq = found.filter((r) => r.kind === 'scene').length;
  if (!nAcq && found.length) tab = 'future';
  if (nAcq && !c.plan && !found.some((r) => r.kind !== 'scene')) tab = 'acquired';
  emit('results');
  emit('selected');
}

// ---------------------------------------------------------------- rendering scenes on the board

function applyRender(id) {
  const r = S.rendered.get(id);
  if (!r) return;
  const c = S.cons.get(r.rec.cid);
  const preset = presetsFor(r.rec.collection, r.rec.props).find((p) => p.id === r.vizId);
  if (!preset) return;
  const q = QUALITY[r.quality];
  showRaster(id, {
    tiles: [tileTemplate(r.rec.collection, r.rec.id, preset.q, r.quality)],
    bounds: r.rec.bbox, minzoom: c.archive.minzoom, maxzoom: c.archive.maxzoom,
    tileSize: q.tileSize, opacity: r.opacity, attribution: 'Microsoft Planetary Computer',
  });
  setLamp('imagery', 'ok', `${S.rendered.size} scene(s) on board`);
}

export function renderScene(rec, vizId, quality, opacity) {
  if (!S.rendered.has(rec.id) && S.rendered.size >= MAX_RENDERED) {
    const oldest = S.rendered.keys().next().value;
    unrenderScene(oldest, true);
    toast(`BOARD LIMIT ${MAX_RENDERED}: OLDEST SCENE CLEARED`);
  }
  S.rendered.set(rec.id, { rec, vizId, quality, opacity });
  applyRender(rec.id);
  const c = S.cons.get(rec.cid);
  const b = map.getBounds();
  const [w, s, e, n] = rec.bbox;
  const inView = w < b.getEast() && e > b.getWest() && s < b.getNorth() && n > b.getSouth();
  if (map.getZoom() < c.archive.minzoom + 0.5 || !inView) fitTo(rec.bbox, { maxZoom: 10 });
  emit('rendered');
}

export function unrenderScene(id, quiet = false) {
  hideRaster(id);
  S.rendered.delete(id);
  if (!S.rendered.size && !gibs.layer) setLamp('imagery', '');
  if (!quiet) emit('rendered');
}

function applyGibs() {
  if (!gibs.layer) { hideRaster('gibs'); if (!S.rendered.size) setLamp('imagery', ''); return; }
  showRaster('gibs', {
    tiles: [gibsTemplate(gibs.layer, gibs.date)], maxzoom: gibs.layer.level, tileSize: 256,
    opacity: gibs.opacity, attribution: 'NASA GIBS', base: true,
  });
  setLamp('imagery', 'ok', `${gibs.layer.label} ${gibs.date}`);
}

// ================================================================ view

function seg(options, current, onPick) {
  return h('div', { class: 'seg' }, options.map(([val, label, title]) => h('button', {
    class: val === current ? 'on' : '', title, onclick: () => onPick(val),
  }, label)));
}

function factsSection(c) {
  const g = c.geom || {};
  const swath = g.mode === 'agile' ? `${g.swathKm} KM (STEERABLE ±${g.reachKm} KM)` : `${g.swathKm} KM${g.mode === 'side' ? ` (${g.side.toUpperCase()}-LOOKING)` : ''}`;
  return h('div', { class: 'sect' },
    h('dl', { class: 'facts' },
      h('dt', null, 'OPERATOR'), h('dd', null, c.operator),
      h('dt', null, 'SENSOR'), h('dd', null, c.instrument),
      h('dt', null, 'GSD'), h('dd', null, c.gsd),
      h('dt', null, 'SWATH'), h('dd', null, swath),
      h('dt', null, 'REVISIT'), h('dd', null, c.revisit),
    ),
    h('p', { class: 'blurb' }, h('span', { class: 'tag', style: { color: c.color } }, c.archive || c.gibs ? 'OPEN DATA' : c.group === 'opentrack' ? 'OPEN / EXTERNAL' : 'TRACK ONLY'), ' ', c.access),
  );
}

function satsSection(c) {
  const sats = fleet.byCons.get(c.id) || [];
  satRefs = new Map();
  return h('div', { class: 'sect' },
    h('h3', null, 'SATELLITES', h('span', null, `${sats.length} TRACKED`)),
    h('div', { class: 'satlist' + (sats.length > 7 ? ' long' : '') }, sats.map((sat) => {
      const pos = h('span', { class: 'pos' }, '');
      satRefs.set(sat.id, pos);
      return h('div', { class: 'satrow' + (sat.id === S.selSat ? ' sel' : ''), dataset: { sat: sat.id }, onclick: () => emit('pick-sat', sat.id) },
        h('span', null, sat.name), pos);
    })),
  );
}

function paintSatPositions() {
  for (const [id, el] of satRefs) {
    const p = live.get(id);
    if (p) el.textContent = `${fmtLat(p.lat, 1)} ${fmtLon(p.lon, 1)} ${p.alt.toFixed(0)}KM`;
  }
}

function gibsSection(c) {
  const shift = (days) => { gibs.date = isoDay(Date.parse(gibs.date) + days * DAY); applyGibs(); render(); };
  return h('div', { class: 'sect' },
    h('h3', null, 'DAILY GLOBAL MOSAIC', gibs.layer ? h('span', { class: 'tag amber' }, 'ON BOARD') : null),
    h('div', { class: 'ctl' },
      h('label', { for: 'gibs-date' }, 'DATE (UTC)'),
      h('div', { class: 'inline' },
        h('button', { title: 'Previous day', onclick: () => shift(-1) }, '◀'),
        h('input', { id: 'gibs-date', type: 'date', value: gibs.date, max: isoDay(Date.now()),
          onchange: (e) => { if (e.target.value) { gibs.date = e.target.value; applyGibs(); render(); } } }),
        h('button', { title: 'Next day', disabled: gibs.date >= isoDay(Date.now()), onclick: () => shift(1) }, '▶'),
      ),
      h('label', { for: 'gibs-op' }, 'OPACITY'),
      h('div', { class: 'inline' }, h('input', { id: 'gibs-op', type: 'range', min: 0.1, max: 1, step: 0.05, value: gibs.opacity,
        oninput: (e) => { gibs.opacity = +e.target.value; setRasterOpacity('gibs', gibs.opacity); } })),
    ),
    h('div', { class: 'vizlist', style: { marginTop: '8px' } }, c.gibs.map((l) => h('div', {
      class: 'viz' + (gibs.layer && gibs.layer.id === l.id ? ' on' : ''), tabindex: 0, role: 'button',
      onclick: () => { gibs.layer = gibs.layer && gibs.layer.id === l.id ? null : l; applyGibs(); render(); },
    }, h('span', { class: 'dot' }), h('span', { class: 'vn' }, l.label), h('span', { class: 'vh' }, l.hint)))),
    h('p', { class: 'blurb muted' }, 'TODAY’S MOSAIC FILLS IN AS EACH ORBIT IS PROCESSED. MAX DETAIL ZOOM ' + Math.max(...c.gibs.map((l) => l.level)) + '.'),
  );
}

function aoiText(aoi) {
  if (aoi.type === 'point') return ['FOCUS ', h('b', null, fmtPos([aoi.lon, aoi.lat], 3))];
  if (aoi.type === 'box') return ['VIEW BOX ', h('b', null, `${fmtPos([aoi.bbox[0], aoi.bbox[1]], 1)} / ${fmtPos([aoi.bbox[2], aoi.bbox[3]], 1)}`)];
  return ['WIDE VIEW ', h('b', null, 'GLOBAL'), ` (BOX SEARCH FROM ZOOM ${BOX_ZOOM})`];
}

function scanSection(c) {
  const aoi = currentAOI();
  const rescan = () => scan();
  const today = isoDay(Date.now());
  return h('div', { class: 'sect' },
    h('h3', null, 'ACQUISITION SCAN', busy ? h('span', { class: 'tag amber', id: 'scan-prog' }, 'SCANNING') : null),
    h('div', { class: 'ctl' },
      h('span', { class: 'k' }, 'AREA'),
      h('div', { class: 'inline' },
        seg([['view', 'VIEW', 'Search the area currently on screen'], ['target', 'FOCUS', 'Search a fixed point']], S.aoiMode, (m) => {
          if (m === 'target' && !S.target) { beginDesignate(); return; }
          S.aoiMode = m; emit('aoi'); scan();
        }),
        h('button', { class: S.designating ? 'on' : '', title: 'Click the globe to place the focus point', onclick: () => (S.designating ? endDesignate() : beginDesignate()) }, S.designating ? 'CLICK GLOBE' : 'DESIGNATE'),
        S.target ? h('button', { class: 'x', title: 'Clear focus point', onclick: () => setTarget(null) }, 'X') : null,
      ),
      h('div', { class: 'aoi-note' }, aoiText(aoi)),
      c.archive ? h('span', { class: 'k' }, 'LOOKBACK') : null,
      c.archive ? seg([...PAST, ['custom', 'DATES', 'Search an explicit date range']], S.custom ? 'custom' : S.pastDays, (d) => {
        if (d === 'custom') {
          S.custom = true;
          if (!S.to) S.to = isoDay(Date.now());
          if (!S.from) S.from = isoDay(Date.now() - 30 * DAY);
        } else { S.custom = false; S.pastDays = d; }
        rescan();
      }) : null,
      c.archive && S.custom ? h('span', { class: 'k' }, 'FROM / TO') : null,
      c.archive && S.custom ? h('div', { class: 'inline' },
        h('input', { type: 'date', 'aria-label': 'From date (UTC)', value: S.from, max: S.to || today, onchange: (e) => { if (e.target.value) { S.from = e.target.value; rescan(); } } }),
        h('input', { type: 'date', 'aria-label': 'To date (UTC)', value: S.to, min: S.from, max: today, onchange: (e) => { if (e.target.value) { S.to = e.target.value; rescan(); } } }),
      ) : null,
      h('span', { class: 'k' }, 'LOOKAHEAD'),
      seg(FUTURE, S.futureDays, (d) => { S.futureDays = d; rescan(); }),
      c.archive && c.archive.cloud ? h('label', { for: 'cloud' }, 'CLOUD ≤') : null,
      c.archive && c.archive.cloud ? h('div', { class: 'inline' },
        h('input', { id: 'cloud', type: 'range', min: 5, max: 100, step: 5, value: S.cloudMax,
          oninput: (e) => { S.cloudMax = +e.target.value; $('#cloud-val').textContent = `${S.cloudMax}%`; },
          onchange: rescan }),
        h('span', { id: 'cloud-val', class: 'num' }, `${S.cloudMax}%`)) : null,
    ),
    h('div', { class: 'btnrow' },
      h('button', { class: 'primary wide' + (aoiStale && !busy ? ' stale' : ''), id: 'btn-scan', disabled: busy, onclick: rescan },
        busy ? 'SCANNING…' : aoiStale ? 'VIEW MOVED – RE-SCAN' : 'SCAN'),
    ),
  );
}

function paintProgress() {
  const el = $('#scan-prog');
  if (el && progress !== null) el.textContent = `PREDICTING ${Math.round(progress * 100)}%`;
}

function resultRow(r, now) {
  const future = r.kind !== 'scene';
  return h('div', {
    class: 'res' + (future && !r.past ? ' future' : '') + (r.id === S.selected ? ' sel' : ''), style: { '--c': r.color }, dataset: { id: r.id },
    onmouseenter: () => hoverRecord(r.id), onmouseleave: () => hoverRecord(null), onclick: () => selectRecord(r.id),
  },
  h('span', { class: 'plat' }, r.platform),
  h('span', { class: 'when' }, stamp(r.time)),
  h('span', { class: 'rel' }, tRel(r.time, now)),
  h('span', { class: 'sub' },
    r.cloud !== null ? h('span', null, h('span', { class: 'cloudbar' }, h('i', { style: { width: `${r.cloud}%` } })), `${r.cloud.toFixed(0)}% CLD`) : null,
    r.kind === 'planned' ? h('span', null, r.past ? 'TASKED' : 'PLANNED') : null,
    r.kind === 'predicted' ? h('span', null, 'PREDICTED') : null,
    r.sub.map((s) => h('span', null, s)),
    S.rendered.has(r.id) ? h('span', { class: 'on-board' }, '■ ON BOARD') : null,
  ));
}

function resultsSection(c) {
  const now = clock.now();
  const acquired = S.results.filter((r) => r.kind === 'scene').sort((a, b) => b.time - a.time);
  const future = S.results.filter((r) => r.kind !== 'scene').sort((a, b) => a.time - b.time);
  const meta = S.resultMeta;
  const futureLabel = meta.futureKind === 'predicted' || !c.plan ? 'PREDICTED' : 'TASKING';
  const list = tab === 'acquired' ? acquired : future;
  const out = [];
  if (c.archive) {
    out.push(h('div', { class: 'tabs' },
      h('button', { class: tab === 'acquired' ? 'on' : '', onclick: () => { tab = 'acquired'; render(); } }, `ACQUIRED (${acquired.length})`),
      h('button', { class: tab === 'future' ? 'on' : '', onclick: () => { tab = 'future'; render(); } }, `${futureLabel} (${future.length})`),
    ));
  } else {
    out.push(h('div', { class: 'tabs' }, h('button', { class: 'on' }, `PREDICTED ACCESS (${future.length})`)));
  }
  for (const n of meta.notes || []) out.push(h('div', { class: `note ${n.cls}` }, n.text));
  const shown = c.archive ? list : future;
  if (!busy && !shown.length) {
    out.push(h('div', { class: 'note' }, tab === 'acquired' && c.archive
      ? (meta.aoi && meta.aoi.type === 'global' ? 'NO AREA SELECTED.' : 'NO SCENES IN THIS WINDOW. WIDEN THE LOOKBACK OR RAISE THE CLOUD LIMIT.')
      : (S.futureDays === 0 ? 'LOOKAHEAD IS OFF.' : 'NO ACCESS IN THIS WINDOW.')));
  }
  if (tab === 'future' || !c.archive) {
    if (shown.length && (meta.futureKind === 'predicted' || !c.plan)) {
      out.push(h('div', { class: 'note' }, c.geom.mode === 'agile'
        ? 'GEOMETRIC ACCESS ONLY: THE SENSOR COULD BE POINTED AT THE AREA. WHETHER IT IS TASKED IS NOT PUBLIC.'
        : 'PREDICTED FROM ORBIT AND SWATH GEOMETRY. THIS SENSOR IMAGES CONTINUOUSLY OVER LAND IN DAYLIGHT.'));
    }
  }
  out.push(h('div', { class: 'results' }, shown.map((r) => resultRow(r, now))));
  return out;
}

function linksSection(c) {
  if (!c.links || !c.links.length) return null;
  return h('div', { class: 'sect' }, h('h3', null, 'EXTERNAL CATALOGUES'),
    h('div', { class: 'links' }, c.links.map((l) => h('a', { href: l.url, target: '_blank', rel: 'noopener' }, l.label))));
}

function onBoardSection() {
  if (!S.rendered.size) return null;
  return h('div', { class: 'sect' },
    h('h3', null, 'SCENES ON BOARD', h('button', { class: 'x', onclick: () => { [...S.rendered.keys()].forEach((id) => unrenderScene(id, true)); emit('rendered'); } }, 'CLEAR ALL')),
    h('div', { class: 'onboard' }, [...S.rendered.values()].map(({ rec }) => h('span', {
      class: 'chip', title: rec.id, onclick: () => selectRecord(rec.id),
    }, `${rec.platform} ${dtg(rec.time)}`, h('button', { title: 'Remove from board', onclick: (e) => { e.stopPropagation(); unrenderScene(rec.id); } }, 'X')))),
  );
}

// ---------------------------------------------------------------- detail views

function detailHead(title) {
  return h('div', { class: 'detail-head' },
    h('button', { onclick: () => selectRecord(null), title: 'Back to results' }, '◀ LIST'),
    h('span', { class: 'ttl' }, title));
}

function sceneDetail(rec) {
  const c = S.cons.get(rec.cid);
  const p = rec.props;
  const presets = presetsFor(rec.collection, p);
  const preset = presets.find((x) => x.id === detail.vizId) || presets[0];
  const on = S.rendered.has(rec.id);
  const now = clock.now();
  const sunEl = p['view:sun_elevation'] ?? (p['s2:mean_solar_zenith'] !== undefined ? 90 - p['s2:mean_solar_zenith'] : null);

  const update = () => {
    if (S.rendered.has(rec.id)) {
      Object.assign(S.rendered.get(rec.id), { vizId: detail.vizId, quality: detail.quality, opacity: detail.opacity });
      applyRender(rec.id);
    }
    render();
  };

  const facts = [
    ['ACQUIRED', stamp(rec.time)], ['DTG', `${dtg(rec.time)}  (${tRel(rec.time, now)})`],
    rec.cloud !== null ? ['CLOUD', `${rec.cloud.toFixed(1)}%`] : null,
    sunEl !== null ? ['SUN ELEV', `${sunEl.toFixed(1)}°`] : null,
    p['sat:orbit_state'] ? ['PASS', `${p['sat:orbit_state']}${p['sat:relative_orbit'] ? `, REL ORBIT ${p['sat:relative_orbit']}` : ''}`] : null,
    p['sar:instrument_mode'] ? ['MODE', `${p['sar:instrument_mode']} ${(p['sar:polarizations'] || []).join('+')}`] : null,
    p['s2:mgrs_tile'] ? ['MGRS TILE', p['s2:mgrs_tile']] : null,
    p['landsat:wrs_path'] ? ['WRS-2', `PATH ${p['landsat:wrs_path']} ROW ${p['landsat:wrs_row']}`] : null,
    p['s2:processing_baseline'] ? ['BASELINE', p['s2:processing_baseline']] : null,
  ].filter(Boolean);

  let downloads;
  if (detail.itemErr) downloads = h('div', { class: 'note err' }, `ASSET LIST UNAVAILABLE: ${detail.itemErr}`);
  else if (!detail.item) downloads = h('div', { class: 'note' }, 'RETRIEVING ASSET LIST…');
  else {
    const { primary, rest } = primaryAssets(rec.collection, detail.item.assets);
    const row = (k) => {
      const a = detail.item.assets[k];
      return h('div', { class: 'dlrow' }, h('span', { class: 'an' }, k), h('span', { class: 'ad', title: a.title || '' }, a.title || a.type || ''),
        h('a', { href: downloadUrl(rec.collection, rec.id, k), download: '' }, 'SAVE'));
    };
    downloads = h('div', { class: 'dl' }, primary.map(row),
      rest.length ? h('details', null, h('summary', null, `ALL OTHER ASSETS (${rest.length})`), rest.map(row)) : null);
  }

  const day = isoDay(rec.time);
  const ctr = [(rec.bbox[0] + rec.bbox[2]) / 2, (rec.bbox[1] + rec.bbox[3]) / 2];
  const cdse = rec.cid === 'landsat' ? null
    : `https://browser.dataspace.copernicus.eu/?zoom=10&lat=${ctr[1].toFixed(4)}&lng=${ctr[0].toFixed(4)}&fromTime=${day}T00%3A00%3A00.000Z&toTime=${day}T23%3A59%3A59.999Z&datasetId=${rec.cid === 'sentinel-2' ? 'S2_L2A_CDAS' : 'S1_CDAS_IW_VVVH'}`;

  return [
    detailHead(`${rec.platform} // ${dtg(rec.time)}`),
    h('div', { class: 'sect' },
      h('div', { class: 'quicklook' }, 'QUICKLOOK',
        h('img', { src: quicklookUrl(rec.collection, rec.id, preset.q), alt: `Quicklook of ${rec.id}`, loading: 'lazy', onerror: (e) => e.target.remove() })),
      h('div', { class: 'sceneid', title: 'Click to copy scene ID', onclick: () => { navigator.clipboard.writeText(rec.id).then(() => toast('SCENE ID COPIED')); } }, rec.id),
      h('dl', { class: 'facts', style: { marginTop: '6px' } }, facts.map(([k, v]) => [h('dt', null, k), h('dd', null, v)])),
    ),
    h('div', { class: 'sect' },
      h('h3', null, c.sensor === 'sar' ? 'RADAR VISUALISATION' : 'OPTICAL VISUALISATION', on ? h('span', { class: 'tag amber' }, 'ON BOARD') : null),
      h('div', { class: 'vizlist' }, presets.map((v) => h('div', {
        class: 'viz' + (v.id === preset.id ? ' on' : ''), tabindex: 0, role: 'button',
        onclick: () => { detail.vizId = v.id; update(); },
        onkeydown: (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); detail.vizId = v.id; update(); } },
      }, h('span', { class: 'dot' }), h('span', { class: 'vn' }, v.label), h('span', { class: 'vh' }, v.hint)))),
      h('div', { class: 'ctl', style: { marginTop: '8px' } },
        h('span', { class: 'k' }, 'DETAIL'),
        seg(Object.entries(QUALITY).map(([k, q]) => [k, q.label, q.hint]), detail.quality, (k) => { detail.quality = k; update(); }),
        h('label', { for: 'scene-op' }, 'OPACITY'),
        h('div', { class: 'inline' }, h('input', { id: 'scene-op', type: 'range', min: 0.1, max: 1, step: 0.05, value: detail.opacity,
          oninput: (e) => {
            detail.opacity = +e.target.value;
            if (S.rendered.has(rec.id)) { S.rendered.get(rec.id).opacity = detail.opacity; setRasterOpacity(rec.id, detail.opacity); }
          } })),
      ),
      h('div', { class: 'btnrow' },
        on ? h('button', { class: 'wide', onclick: () => unrenderScene(rec.id) }, 'REMOVE FROM BOARD')
          : h('button', { class: 'primary wide', onclick: () => renderScene(rec, preset.id, detail.quality, detail.opacity) }, 'RENDER ON BOARD'),
        h('button', { class: 'wide', title: 'Centre the board on this footprint', onclick: () => fitTo(rec.bbox, { maxZoom: 10 }) }, 'GO TO'),
      ),
    ),
    onBoardSection(),
    h('div', { class: 'sect' },
      h('h3', null, 'DOWNLOAD TO DISK', h('span', null, 'CLOUD-OPTIMISED GEOTIFF')),
      downloads,
      h('div', { class: 'btnrow' },
        h('a', { class: 'tag', style: { textAlign: 'center', lineHeight: '20px' }, href: exportUrl(rec.collection, rec.id, preset.q, preset.id), download: '' }, `SAVE ${preset.label} AS PNG`)),
    ),
    h('div', { class: 'sect' }, h('h3', null, 'SOURCE RECORD'),
      h('div', { class: 'links' },
        h('a', { href: `${PC}/stac/v1/collections/${rec.collection}/items/${rec.id}`, target: '_blank', rel: 'noopener' }, 'STAC ITEM'),
        cdse ? h('a', { href: cdse, target: '_blank', rel: 'noopener' }, 'COPERNICUS BROWSER (SAME DAY)') : null,
      )),
  ];
}

function futureDetail(rec) {
  const c = S.cons.get(rec.cid);
  const now = clock.now();
  const p = rec.props;
  const planned = rec.kind === 'planned';
  const src = planned && (S.resultMeta.planSources || []).find((s) => s.sat === p.platform);
  const facts = [
    ['STATUS', planned ? (rec.past ? 'TASKED (PLAN WINDOW PASSED)' : 'PLANNED ACQUISITION') : 'PREDICTED ACCESS'],
    [rec.tot ? 'OVER AREA' : 'STARTS', stamp(rec.time)],
    ['COUNTDOWN', tRel(rec.time, now)],
    planned ? ['STRIP', `${stamp(rec.start)} → ${stamp(rec.end).slice(-6)}`] : null,
    p.mode ? ['MODE', `${p.mode}${p.pol ? ` / ${p.pol}` : ''}`] : null,
    p.relOrbit ? ['REL ORBIT', p.relOrbit] : null,
    !planned ? ['GEOMETRY', rec.sub.join(' / ')] : null,
    src ? ['PLAN FILE', src.file] : null,
  ].filter(Boolean);
  return [
    detailHead(`${rec.platform} // ${planned ? 'TASKING' : 'ACCESS'}`),
    h('div', { class: 'sect' },
      h('dl', { class: 'facts' }, facts.map(([k, v]) => [h('dt', null, k), h('dd', null, v)])),
      h('p', { class: 'blurb muted' }, planned
        ? 'FROM THE ESA ACQUISITION PLAN. PLANS ARE REVISED WITHOUT NOTICE; A PLANNED STRIP IS NOT A GUARANTEED PRODUCT, AND OPTICAL PASSES MAY BE CLOUDED OUT.'
        : c.geom.mode === 'agile'
          ? 'GEOMETRIC OPPORTUNITY ONLY. THE SATELLITE PASSES WITHIN POINTING RANGE; TASKING IS AT THE OPERATOR’S DISCRETION AND IS NOT PUBLISHED.'
          : 'DERIVED FROM CURRENT ORBITAL ELEMENTS AND NOMINAL SWATH WIDTH. ACCURACY DEGRADES BEYOND A FEW DAYS AS ELEMENTS AGE.'),
      h('div', { class: 'btnrow' },
        h('button', { class: 'primary wide', title: 'Move the board clock to this pass', onclick: () => { clock.set(rec.time - 45000); if (rec.sat) emit('pick-sat', rec.sat.id); } }, 'RUN CLOCK TO PASS'),
        h('button', { class: 'wide', onclick: () => fitTo(rec.bbox, { maxZoom: 7 }) }, 'GO TO'),
      ),
    ),
    onBoardSection(),
  ];
}

// ---------------------------------------------------------------- top-level render

export function render() {
  const panel = $('#mission');
  const c = con();
  const wasHidden = panel.hidden;
  panel.hidden = !c;
  if (wasHidden !== panel.hidden) syncPadding();
  if (!c) return;
  $('#mission-title').textContent = c.name;
  const body = $('#mission-body');
  const keepScroll = body.dataset.view === view ? body.scrollTop : 0;
  const rec = view === 'detail' && S.selected ? recById(S.selected) : null;
  if (rec) {
    satRefs = new Map();
    body.replaceChildren(...[rec.kind === 'scene' ? sceneDetail(rec) : futureDetail(rec)].flat(Infinity).filter(Boolean));
  } else {
    view = 'main';
    body.replaceChildren(...[
      factsSection(c), satsSection(c), c.gibs ? gibsSection(c) : null,
      canScan(c) ? scanSection(c) : null, onBoardSection(), canScan(c) ? resultsSection(c) : null, linksSection(c),
    ].flat(Infinity).filter(Boolean));
    paintSatPositions();
  }
  body.dataset.view = view;
  body.scrollTop = keepScroll;
}

function beginDesignate() {
  S.designating = true;
  $('#globe').classList.add('designating');
  toast('CLICK THE GLOBE TO DESIGNATE FOCUS');
  render();
}

function endDesignate() {
  S.designating = false;
  $('#globe').classList.remove('designating');
  render();
}

export function initMission() {
  $('#mission-close').addEventListener('click', () => setActive(null));
  on('active', render);
  on('results', render);
  on('selected', render);
  on('rendered', render);
  on('selsat', () => { if (view === 'main') render(); });
  on('hovered', () => {
    for (const el of document.querySelectorAll('#mission .res.hover')) el.classList.remove('hover');
    if (S.hovered) {
      const el = document.querySelector(`#mission .res[data-id="${CSS.escape(S.hovered)}"]`);
      if (el) el.classList.add('hover');
    }
  });
  on('tick', () => { if (view === 'main') paintSatPositions(); });
  map.on('moveend', () => {
    if (S.active && S.aoiMode === 'view' && !busy && !S.follow && canScan(con())) {
      const was = S.resultMeta.aoi;
      const nowAoi = currentAOI();
      const changed = !was || JSON.stringify(was) !== JSON.stringify(nowAoi);
      if (changed && !aoiStale) { aoiStale = true; if (view === 'main') render(); }
      emit('aoi');
    }
  });
}
