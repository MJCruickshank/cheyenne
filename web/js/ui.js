// Top bar, constellation roster, satellite card, gazetteer and globe pointer interaction.

import { S, on, emit, clock } from './state.js';
import { map, setBasemap, setGridVisible, updateNight } from './globe.js';
import { IMAGERY } from './basemap.js';
import { LIVE, liveStatus } from './live.js';
import { fireAt, describeFire } from './firms.js';
import { fleet, sunlit } from './tracker.js';
import { live, invalidate } from './board.js';
import { setActive, setTarget, hoverRecord, selectRecord } from './mission.js';
import { currentAOI } from './archive.js';
import { showTip, hideTip, placePicker, closePicker } from './hud.js';
import { intelAt, describeSite, openSite } from './intel.js';
import { shipAt, describeShip, openShip, clearShip } from './ais.js';
import { $, h, hms, dmy, stamp, tRel, fmtLat, fmtLon, fmtPos, parseCoords, pointInGeom, getJSON, toast, DAY } from './util.js';

// ---------------------------------------------------------------- top bar

function initTopbar() {
  const paintClock = () => {
    const now = clock.now();
    $('#clock-time').textContent = hms(now);
    $('#clock-date').textContent = dmy(now);
    $('#clock-mode').textContent = clock.live ? 'LIVE' : `SIM ${clock.rate}X ${tRel(now, Date.now()).slice(1)}`;
    $('#clock').classList.toggle('sim', !clock.live);
  };
  const paintButtons = () => {
    $('#btn-live').classList.toggle('on', clock.live);
    for (const b of document.querySelectorAll('.timectl [data-rate]')) b.classList.toggle('on', +b.dataset.rate === clock.rate);
  };
  on('tick', paintClock);
  on('clock', () => { paintClock(); paintButtons(); invalidate(); });
  for (const b of document.querySelectorAll('.timectl [data-jump]')) b.addEventListener('click', () => clock.jump(+b.dataset.jump * 1000));
  for (const b of document.querySelectorAll('.timectl [data-rate]')) b.addEventListener('click', () => clock.setRate(+b.dataset.rate));
  $('#btn-live').addEventListener('click', () => clock.goLive());

  // Basemap: three views, with a source picker for the two that have alternatives.
  const variants = $('#base-variant');
  const paintBase = () => {
    for (const mode of ['vector', 'imagery', 'live']) $(`#btn-base-${mode}`).classList.toggle('on', S.basemap === mode);
    const options = S.basemap === 'imagery' ? IMAGERY : S.basemap === 'live' ? LIVE : null;
    variants.hidden = !options || Object.keys(options).length < 2;       // nothing to pick from a single source
    if (options) {
      variants.replaceChildren(...Object.entries(options).map(([id, o]) => h('option', { value: id, title: o.name }, o.label)));
      variants.value = S.basemap === 'imagery' ? S.imagery : S.live;
    }
    paintBaseReadout();
  };
  const base = (mode, variant) => {
    setBasemap(mode, variant);
    paintBase();
    if (mode === 'imagery' && IMAGERY[S.imagery].note) toast(IMAGERY[S.imagery].note);
    emit('basemap');
  };
  for (const mode of ['vector', 'imagery', 'live']) $(`#btn-base-${mode}`).addEventListener('click', () => base(mode));
  variants.addEventListener('change', () => base(S.basemap, variants.value));
  on('set-basemap', ([mode, variant]) => base(mode, variant));
  on('live', paintBaseReadout);
  $('#btn-grat').addEventListener('click', (e) => { setGridVisible(!S.showGrid); e.currentTarget.classList.toggle('on', S.showGrid); });
  $('#btn-night').addEventListener('click', (e) => { S.showNight = !S.showNight; e.currentTarget.classList.toggle('on', S.showNight); updateNight(clock.now()); });
  $('#btn-crt').addEventListener('click', (e) => { e.currentTarget.classList.toggle('on', !$('#crt').classList.toggle('off')); });
  paintClock();
}

function paintBaseReadout() {
  const el = $('#ro-base');
  if (S.basemap === 'vector') { el.textContent = 'VECTOR BOARD'; el.title = ''; return; }
  if (S.basemap === 'imagery') { el.textContent = IMAGERY[S.imagery].name; el.title = ''; return; }
  const st = liveStatus();
  el.textContent = st ? `${st.label} ${st.newest ? `${hms(st.newest).slice(0, 5)}Z` : 'LATEST'}` : 'LIVE';
  el.title = st ? st.detail : '';
}

// ---------------------------------------------------------------- roster

function renderRoster() {
  const body = $('#roster-body');
  const keep = body.scrollTop;
  const kids = [];
  let shown = 0;
  for (const g of S.catalog.groups) {
    const cons = S.catalog.constellations.filter((c) => c.group === g.id);
    if (!cons.length) continue;
    const allOn = cons.every((c) => S.visible.has(c.id));
    kids.push(h('div', { class: 'grp' },
      h('div', { class: 'grp-head', title: g.note }, h('b', null, g.label),
        h('button', { class: 'x', title: allOn ? 'Hide group' : 'Show group', onclick: () => {
          for (const c of cons) { if (allOn) { if (c.id !== S.active) S.visible.delete(c.id); } else S.visible.add(c.id); }
          emit('visible');
        } }, allOn ? 'HIDE' : 'SHOW')),
      cons.map((c) => {
        const n = (fleet.byCons.get(c.id) || []).length;
        const vis = S.visible.has(c.id);
        if (vis) shown += n;
        return h('div', {
          class: 'row-c' + (S.active === c.id ? ' active' : '') + (vis ? '' : ' off'), style: { '--c': c.color },
          title: `${c.operator} – ${c.instrument}`, onclick: () => setActive(S.active === c.id ? null : c.id),
        },
        h('button', { class: 'lampbtn' + (vis ? ' lit' : ''), title: vis ? 'Hide from board' : 'Show on board', 'aria-pressed': String(vis),
          onclick: (e) => {
            e.stopPropagation();
            if (vis) { if (S.active === c.id) setActive(null); S.visible.delete(c.id); } else S.visible.add(c.id);
            emit('visible');
          } }),
        h('span', { class: 'nm' }, c.name),
        h('span', { class: 'tag' }, c.sensor === 'sar' ? 'SAR' : c.sensor === 'multi' ? 'MIX' : 'OPT'),
        h('span', { class: 'ct' }, n));
      })));
  }
  body.replaceChildren(...kids);
  body.scrollTop = keep;
  $('#roster-count').textContent = shown;
  $('#ro-tracks').textContent = `${shown} / ${fleet.sats.length}`;
}

function renderRosterFoot() {
  const foot = $('#roster-foot');
  if (!fleet.fetchedAt) { foot.replaceChildren(h('span', { class: 'red' }, 'NO ORBITAL ELEMENTS')); return; }
  const hrs = (Date.now() - fleet.fetchedAt) / 3600000;
  foot.replaceChildren('ELEMENTS: CELESTRAK, ', h('span', { class: fleet.stale ? 'amber' : '' }, `${hrs < 1 ? '<1' : hrs.toFixed(0)} H OLD${fleet.stale ? ' (STALE)' : ''}`),
    h('br'), '◇ OPTICAL  △ RADAR  □ MIXED');
}

// ---------------------------------------------------------------- satellite card

function pickSat(id) {
  S.selSat = S.selSat === id ? null : id;
  if (!S.selSat) S.follow = false;
  const sat = S.selSat && fleet.byId.get(S.selSat);
  if (sat && !S.visible.has(sat.cid)) { S.visible.add(sat.cid); emit('visible'); }
  emit('selsat');
  invalidate();
}

let cardRefs = null;

function renderSatCard() {
  const el = $('#satcard');
  const sat = S.selSat && fleet.byId.get(S.selSat);
  if (!sat) { el.hidden = true; cardRefs = null; return; }
  const c = S.cons.get(sat.cid);
  const v = (k) => h('dd', { class: 'num', dataset: { k } }, '');
  el.hidden = false;
  el.replaceChildren(
    h('div', { class: 'panel-head' }, h('span', { style: { color: c.color } }, sat.name),
      h('button', { class: 'x', title: 'Deselect satellite', onclick: () => pickSat(sat.id) }, 'X')),
    h('dl', { class: 'facts' },
      h('dt', null, 'NORAD ID'), h('dd', { class: 'num' }, sat.id),
      h('dt', null, 'FLEET'), h('dd', null, c.name),
      h('dt', null, 'POSITION'), v('pos'),
      h('dt', null, 'ALTITUDE'), v('alt'),
      h('dt', null, 'VELOCITY'), v('vel'),
      h('dt', null, 'ORBIT'), h('dd', { class: 'num' }, `${sat.periodMin.toFixed(1)} MIN / ${sat.incl.toFixed(1)}°`),
      h('dt', null, 'ILLUM'), v('sun'),
      h('dt', null, 'ELSET AGE'), v('age'),
    ),
    h('div', { class: 'btnrow' },
      h('button', { class: S.follow ? 'on' : '', onclick: () => { S.follow = !S.follow; renderSatCard(); invalidate(); } }, 'FOLLOW'),
      h('button', { onclick: () => { const p = live.get(sat.id); if (p) map.flyTo({ center: [p.lon, p.lat], zoom: Math.max(map.getZoom(), 3), duration: 1200 }); } }, 'CENTRE'),
      h('button', { onclick: () => setActive(sat.cid) }, 'FLEET'),
    ),
  );
  cardRefs = Object.fromEntries([...el.querySelectorAll('[data-k]')].map((n) => [n.dataset.k, n]));
  paintSatCard(clock.now());
}

function paintSatCard(now) {
  if (!cardRefs || !S.selSat) return;
  const sat = fleet.byId.get(S.selSat);
  const p = live.get(S.selSat);
  if (!sat || !p) return;
  cardRefs.pos.textContent = `${fmtLat(p.lat, 2)} ${fmtLon(p.lon, 2)}`;
  cardRefs.alt.textContent = `${p.alt.toFixed(1)} KM`;
  cardRefs.vel.textContent = `${p.speed.toFixed(2)} KM/S`;
  cardRefs.sun.textContent = sunlit(sat, now, p) ? 'SUNLIT' : 'ECLIPSE';
  const age = (now - sat.epochMs) / DAY;
  cardRefs.age.textContent = `${age.toFixed(1)} D`;
  cardRefs.age.classList.toggle('amber', Math.abs(age) > 5);
}

// ---------------------------------------------------------------- gazetteer

function initGazetteer() {
  const form = $('#gazetteer'), input = $('#gaz-input'), box = $('#gaz-results');
  const close = () => { box.hidden = true; box.replaceChildren(); };
  const go = (pt, label) => {
    close(); input.value = label || ''; input.blur();
    setTarget(pt, true);
    toast(`FOCUS DESIGNATED ${fmtPos(pt, 3)}`);
  };
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const text = input.value.trim();
    if (!text) return;
    const pt = parseCoords(text);
    if (pt) return go(pt, text);
    box.hidden = false;
    box.replaceChildren(h('div', { class: 'gaz-none' }, 'SEARCHING…'));
    try {
      const res = await getJSON(`https://nominatim.openstreetmap.org/search?format=jsonv2&limit=6&accept-language=en&q=${encodeURIComponent(text)}`);
      if (!res.length) { box.replaceChildren(h('div', { class: 'gaz-none' }, 'NO MATCH')); return; }
      box.replaceChildren(...res.map((r) => h('button', { type: 'button', onclick: () => go([+r.lon, +r.lat], r.display_name.split(',')[0]) }, r.display_name)));
    } catch (err) {
      box.replaceChildren(h('div', { class: 'gaz-none red' }, `GAZETTEER UNAVAILABLE: ${err.message}`));
    }
  });
  input.addEventListener('keydown', (e) => { if (e.key === 'Escape') { close(); input.blur(); } });
  document.addEventListener('click', (e) => { if (!form.contains(e.target)) close(); });
}

// ---------------------------------------------------------------- globe pointer

function footprintsAt(lngLat) {
  const pt = [lngLat.lng, lngLat.lat];
  const now = clock.now();
  const recs = S.results.filter((r) => {
    const [w, s, e, n] = r.bbox;
    if (pt[1] < s || pt[1] > n) return false;
    if (e - w < 180 && (pt[0] < w - 0.001 || pt[0] > e + 0.001) && e <= 180 && w >= -180) return false;
    return pointInGeom(pt, r.geometry);
  });
  // most recent acquired scene first, then upcoming passes soonest first
  recs.sort((a, b) => (a.kind === 'scene' ? 0 : 1) - (b.kind === 'scene' ? 0 : 1)
    || (a.kind === 'scene' ? b.time - a.time : Math.abs(a.time - now) - Math.abs(b.time - now)));
  return recs;
}

function satAt(point) {
  const pad = 9;
  const hit = map.queryRenderedFeatures([[point.x - pad, point.y - pad], [point.x + pad, point.y + pad]], { layers: ['cy-sats'] })[0];
  return hit ? fleet.byId.get(hit.properties.id) : null;
}

function openPicker(recs, x, y) {
  const el = $('#picker');
  const now = clock.now();
  el.classList.remove('wide');
  el.replaceChildren(
    h('div', { class: 'panel-head' }, h('span', null, `${recs.length} FOOTPRINTS HERE`), h('button', { class: 'x', onclick: closePicker }, 'X')),
    h('div', { class: 'panel-body' }, recs.slice(0, 40).map((r) => h('div', {
      class: 'res' + (r.kind !== 'scene' && !r.past ? ' future' : ''), style: { '--c': r.color },
      onmouseenter: () => hoverRecord(r.id), onmouseleave: () => hoverRecord(null),
      onclick: () => { closePicker(); selectRecord(r.id, { fly: false }); },
    }, h('span', { class: 'plat' }, r.platform), h('span', { class: 'when' }, stamp(r.time)),
    h('span', { class: 'sub' }, r.kind === 'scene' ? (r.cloud !== null ? `${r.cloud.toFixed(0)}% CLD` : r.sub.slice(0, 2).join(' ')) : (r.kind === 'planned' ? 'PLANNED' : 'PREDICTED'), ' ', tRel(r.time, now))))),
  );
  placePicker(x, y);
}

function openFireCard(feature, x, y) {
  const d = describeFire(feature);
  const pt = [+d.lonlat[0].toFixed(5), +d.lonlat[1].toFixed(5)];
  $('#picker').classList.remove('wide');
  $('#picker').replaceChildren(
    h('div', { class: 'panel-head' }, h('span', { class: 'red' }, 'THERMAL DETECTION'), h('button', { class: 'x', onclick: closePicker }, 'X')),
    h('dl', { class: 'facts' },
      h('dt', null, 'POSITION'), h('dd', { class: 'num' }, fmtPos(pt, 4)),
      d.facts.map(([k, v]) => [h('dt', null, k), h('dd', null, v)])),
    h('div', { class: 'btnrow' },
      h('button', { class: 'primary', title: 'Search imagery of this point with the selected fleet',
        onclick: () => { closePicker(); setTarget(pt); toast(`FOCUS DESIGNATED ${fmtPos(pt, 3)}`); } }, 'DESIGNATE FOCUS'),
      h('button', { title: 'Move the board clock to the detection time', onclick: () => { closePicker(); clock.set(d.time); } }, 'CLOCK TO')),
  );
  placePicker(x, y);
}

function initPointer() {
  let pending = null;
  map.on('mousemove', (e) => {
    pending = e;
    requestAnimationFrame(() => {
      if (!pending) return;
      const ev = pending; pending = null;
      $('#ro-cursor').textContent = fmtPos([ev.lngLat.lng, ev.lngLat.lat], 3);
      const { clientX: x, clientY: y } = ev.originalEvent;
      if (!$('#picker').hidden) { hideTip(); return; }          // a card is open; keep it unobstructed
      const sat = satAt(ev.point);
      if (sat) {
        const p = live.get(sat.id);
        map.getCanvas().style.cursor = 'pointer';
        hoverRecord(null);
        showTip(x, y, sat.name, `${S.cons.get(sat.cid).name}${p ? `  ALT ${p.alt.toFixed(0)} KM` : ''}`);
        return;
      }
      const site = S.designating ? null : intelAt(ev.point);
      if (site) {
        const d = describeSite(site);
        map.getCanvas().style.cursor = 'pointer';
        hoverRecord(null);
        showTip(x, y, d.title, d.sub);
        return;
      }
      const ship = S.designating ? null : shipAt(ev.point);
      if (ship) {
        const d = describeShip(ship);
        map.getCanvas().style.cursor = 'pointer';
        hoverRecord(null);
        showTip(x, y, d.title, d.sub);
        return;
      }
      const fire = S.designating ? null : fireAt(ev.point);
      if (fire) {
        const d = describeFire(fire);
        map.getCanvas().style.cursor = 'pointer';
        hoverRecord(null);
        showTip(x, y, d.title, d.sub);
        return;
      }
      const recs = S.designating ? [] : footprintsAt(ev.lngLat);
      if (recs.length) {
        const r = recs[0];
        map.getCanvas().style.cursor = 'pointer';
        hoverRecord(r.id);
        showTip(x, y, `${r.platform}  ${stamp(r.time)}`, `${r.kind === 'scene' ? 'ACQUIRED' : r.kind.toUpperCase()}${recs.length > 1 ? `  (+${recs.length - 1} MORE HERE)` : ''}`);
      } else {
        map.getCanvas().style.cursor = '';
        hoverRecord(null);
        hideTip();
      }
    });
  });
  map.on('mouseout', () => { pending = null; hideTip(); hoverRecord(null); $('#ro-cursor').textContent = '---'; });
  map.on('movestart', closePicker);
  map.on('click', (e) => {
    closePicker();
    if (S.designating) { setTarget([+e.lngLat.lng.toFixed(5), +e.lngLat.lat.toFixed(5)]); toast(`FOCUS DESIGNATED ${fmtPos([e.lngLat.lng, e.lngLat.lat], 3)}`); return; }
    const sat = satAt(e.point);
    if (sat) { pickSat(sat.id); return; }
    const site = intelAt(e.point);
    if (site) { openSite(site.properties.id, e.originalEvent.clientX, e.originalEvent.clientY); return; }
    const ship = shipAt(e.point);
    if (ship) { openShip(ship.properties.m, e.originalEvent.clientX, e.originalEvent.clientY); return; }
    clearShip();
    const fire = fireAt(e.point);
    if (fire) { openFireCard(fire, e.originalEvent.clientX, e.originalEvent.clientY); return; }
    const recs = footprintsAt(e.lngLat);
    if (recs.length === 1) selectRecord(recs[0].id, { fly: false });
    else if (recs.length > 1) openPicker(recs, e.originalEvent.clientX, e.originalEvent.clientY);
  });
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape' || /INPUT|SELECT|TEXTAREA/.test(document.activeElement.tagName)) return;
    if (!$('#picker').hidden) closePicker();
    else if (S.designating) { S.designating = false; $('#globe').classList.remove('designating'); emit('results'); }
    else if (S.selected) selectRecord(null);
    else if (S.selSat) pickSat(S.selSat);
  });
}

function paintAoiReadout() {
  const aoi = currentAOI();
  $('#ro-aoi').textContent = aoi.type === 'point' ? `FOCUS ${fmtPos([aoi.lon, aoi.lat], 2)}` : aoi.type === 'box' ? 'VIEW BOX' : 'GLOBAL';
}

export function initUI() {
  initTopbar();
  initGazetteer();
  initPointer();
  renderRoster();
  renderRosterFoot();
  on('visible', () => { renderRoster(); invalidate(); });
  on('active', () => { renderRoster(); invalidate(); });
  on('selsat', renderSatCard);
  on('pick-sat', pickSat);
  on('tick', paintSatCard);
  on('aoi', paintAoiReadout);
  map.on('moveend', paintAoiReadout);
  paintAoiReadout();
  $('#credits').replaceChildren(
    'Orbits: CelesTrak. Scenes: Microsoft Planetary Computer (Copernicus Sentinel, USGS Landsat); NISAR: NASA/JPL-Caltech and ISRO via ASF DAAC. Tasking: ESA. ',
    'Free releases: Vantor (formerly Maxar) and Planet Labs PBC, CC BY-NC 4.0. ',
    'Mosaics and live view: NASA GIBS, NOAA, EUMETSAT. Fires: NASA FIRMS. Ships: aisstream.io, Fintraffic / digitraffic.fi (CC BY 4.0), Open Waters AIS, Pelyr (see AIS panel). Intel: public Telegram channels; places: GeoNames. ',
    'Basemap: OpenFreeMap © OpenStreetMap; imagery © Esri.');
}
