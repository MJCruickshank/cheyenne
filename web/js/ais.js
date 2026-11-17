// AIS: live ship positions merged from several free feeds by the local server (see ais.py),
// and a map of where free AIS coverage actually exists.

import { emit } from './state.js';
import { map, setData } from './globe.js';
import { ANCHOR_OVERLAY, INK } from './basemap.js';
import { setTarget } from './mission.js';
import { setLamp, placePicker, closePicker } from './hud.js';
import { $, h, getJSON, stamp, fmtPos, toast, clamp, wrapLon } from './util.js';

const REFRESH_MS = 10000;
const COVERAGE_REFRESH_MS = 120000;
const ICON_ZOOM = 6;                      // below this, ships are dots
const GLOBAL_BELOW_ZOOM = 3;

export const CATS = [
  ['CARGO', '#6fdc8c'], ['TANKER', '#ff6b6b'], ['PASSENGER', '#5ac8fa'], ['FISHING', '#ffb347'],
  ['MILITARY / LAW ENFORCEMENT', '#f4f4f4'], ['TUG / SERVICE', '#40e0d0'], ['LEISURE', '#c49cff'], ['OTHER / UNKNOWN', '#8a9ba8'],
];

const NAV = {
  0: 'UNDER WAY (ENGINE)', 1: 'AT ANCHOR', 2: 'NOT UNDER COMMAND', 3: 'RESTRICTED MANOEUVRABILITY', 4: 'CONSTRAINED BY DRAUGHT',
  5: 'MOORED', 6: 'AGROUND', 7: 'FISHING', 8: 'UNDER WAY (SAIL)', 11: 'TOWING ASTERN', 12: 'PUSHING / TOWING ALONGSIDE', 14: 'AIS-SART ACTIVE',
};

// Maritime Identification Digits: the first three digits of an MMSI give the flag the transponder was registered under.
const MID = (() => {
  const src = '201:ALBANIA|202:ANDORRA|203:AUSTRIA|204,255:PORTUGAL (AZORES/MADEIRA)|205:BELGIUM|206:BELARUS|207:BULGARIA|208:VATICAN|'
    + '209,210,212:CYPRUS|211,218:GERMANY|213:GEORGIA|214:MOLDOVA|215,229,248,249,256:MALTA|216:ARMENIA|219,220:DENMARK|224,225:SPAIN|'
    + '226,227,228:FRANCE|230:FINLAND|231:FAROE ISLANDS|232,233,234,235:UNITED KINGDOM|236:GIBRALTAR|237,239,240,241:GREECE|238:CROATIA|'
    + '242:MOROCCO|243:HUNGARY|244,245,246:NETHERLANDS|247:ITALY|250:IRELAND|251:ICELAND|252:LIECHTENSTEIN|253:LUXEMBOURG|254:MONACO|'
    + '257,258,259:NORWAY|261:POLAND|262:MONTENEGRO|263:PORTUGAL|264:ROMANIA|265,266:SWEDEN|267:SLOVAKIA|268:SAN MARINO|269:SWITZERLAND|'
    + '270:CZECHIA|271:TURKEY|272:UKRAINE|273:RUSSIA|274:NORTH MACEDONIA|275:LATVIA|276:ESTONIA|277:LITHUANIA|278:SLOVENIA|279:SERBIA|'
    + '301:ANGUILLA|303,338,366,367,368,369:UNITED STATES|304,305:ANTIGUA AND BARBUDA|306:CURACAO / SINT MAARTEN|307:ARUBA|308,309,311:BAHAMAS|'
    + '310:BERMUDA|312:BELIZE|314:BARBADOS|316:CANADA|319:CAYMAN ISLANDS|321:COSTA RICA|323:CUBA|325:DOMINICA|327:DOMINICAN REPUBLIC|'
    + '329:GUADELOUPE|330:GRENADA|331:GREENLAND|332:GUATEMALA|334:HONDURAS|336:HAITI|339:JAMAICA|341:ST KITTS AND NEVIS|343:ST LUCIA|'
    + '345:MEXICO|347:MARTINIQUE|348:MONTSERRAT|350:NICARAGUA|351,352,353,354,355,356,357,370,371,372,373,374:PANAMA|358:PUERTO RICO|'
    + '359:EL SALVADOR|361:ST PIERRE AND MIQUELON|362:TRINIDAD AND TOBAGO|364:TURKS AND CAICOS|375,376,377:ST VINCENT AND GRENADINES|'
    + '378:BRITISH VIRGIN ISLANDS|379:US VIRGIN ISLANDS|401:AFGHANISTAN|403:SAUDI ARABIA|405:BANGLADESH|408:BAHRAIN|410:BHUTAN|'
    + '412,413,414:CHINA|416:TAIWAN|417:SRI LANKA|419:INDIA|422:IRAN|423:AZERBAIJAN|425:IRAQ|428:ISRAEL|431,432:JAPAN|434:TURKMENISTAN|'
    + '436:KAZAKHSTAN|437:UZBEKISTAN|438:JORDAN|440,441:SOUTH KOREA|443:PALESTINE|445:NORTH KOREA|447:KUWAIT|450:LEBANON|451:KYRGYZSTAN|'
    + '453:MACAO|455:MALDIVES|457:MONGOLIA|459:NEPAL|461:OMAN|463:PAKISTAN|466:QATAR|468:SYRIA|470,471:UNITED ARAB EMIRATES|472:TAJIKISTAN|'
    + '473,475:YEMEN|477:HONG KONG|478:BOSNIA AND HERZEGOVINA|501:ADELIE LAND|503:AUSTRALIA|506:MYANMAR|508:BRUNEI|510:MICRONESIA|511:PALAU|'
    + '512:NEW ZEALAND|514,515:CAMBODIA|516:CHRISTMAS ISLAND|518:COOK ISLANDS|520:FIJI|523:COCOS ISLANDS|525:INDONESIA|529:KIRIBATI|531:LAOS|'
    + '533:MALAYSIA|536:NORTHERN MARIANA ISLANDS|538:MARSHALL ISLANDS|540:NEW CALEDONIA|542:NIUE|544:NAURU|546:FRENCH POLYNESIA|548:PHILIPPINES|'
    + '550:TIMOR-LESTE|553:PAPUA NEW GUINEA|555:PITCAIRN|557:SOLOMON ISLANDS|559:AMERICAN SAMOA|561:SAMOA|563,564,565,566:SINGAPORE|567:THAILAND|'
    + '570:TONGA|572:TUVALU|574:VIETNAM|576,577:VANUATU|578:WALLIS AND FUTUNA|601:SOUTH AFRICA|603:ANGOLA|605:ALGERIA|609:BURUNDI|610:BENIN|'
    + '611:BOTSWANA|612:CENTRAL AFRICAN REPUBLIC|613:CAMEROON|615:CONGO|616,620:COMOROS|617:CABO VERDE|619:COTE D\'IVOIRE|621:DJIBOUTI|622:EGYPT|'
    + '624:ETHIOPIA|625:ERITREA|626:GABON|627:GHANA|629:GAMBIA|630:GUINEA-BISSAU|631:EQUATORIAL GUINEA|632:GUINEA|633:BURKINA FASO|634:KENYA|'
    + '636,637:LIBERIA|638:SOUTH SUDAN|642:LIBYA|644:LESOTHO|645:MAURITIUS|647:MADAGASCAR|649:MALI|650:MOZAMBIQUE|654:MAURITANIA|655:MALAWI|'
    + '656:NIGER|657:NIGERIA|659:NAMIBIA|660:REUNION|661:RWANDA|662:SUDAN|663:SENEGAL|664:SEYCHELLES|665:ST HELENA|666:SOMALIA|667:SIERRA LEONE|'
    + '668:SAO TOME AND PRINCIPE|669:ESWATINI|670:CHAD|671:TOGO|672:TUNISIA|674,677:TANZANIA|675:UGANDA|676:DR CONGO|678:ZAMBIA|679:ZIMBABWE|'
    + '701:ARGENTINA|710:BRAZIL|720:BOLIVIA|725:CHILE|730:COLOMBIA|735:ECUADOR|740:FALKLAND ISLANDS|745:FRENCH GUIANA|750:GUYANA|755:PARAGUAY|'
    + '760:PERU|765:SURINAME|770:URUGUAY|775:VENEZUELA';
  const out = {};
  for (const part of src.split('|')) {
    const [codes, name] = part.split(':');
    for (const c of codes.split(',')) out[c] = name;
  }
  return out;
})();

function flagOf(mmsi) {
  const s = String(mmsi);
  if (s.length !== 9) return null;
  return MID[s.slice(0, 3)] || null;
}

function typeText(t) {
  if (!t) return 'NOT REPORTED';
  const hz = { 1: ' (HAZARDOUS CAT. X)', 2: ' (HAZARDOUS CAT. Y)', 3: ' (HAZARDOUS CAT. Z)', 4: ' (HAZARDOUS CAT. OS)' };
  const d = t % 10, tens = Math.floor(t / 10);
  const fixed = { 30: 'FISHING', 31: 'TOWING', 32: 'TOWING (LARGE)', 33: 'DREDGING / UNDERWATER OPS', 34: 'DIVING OPS', 35: 'MILITARY OPS',
    36: 'SAILING', 37: 'PLEASURE CRAFT', 50: 'PILOT', 51: 'SEARCH AND RESCUE', 52: 'TUG', 53: 'PORT TENDER', 54: 'ANTI-POLLUTION',
    55: 'LAW ENFORCEMENT', 58: 'MEDICAL TRANSPORT', 59: 'NONCOMBATANT' };
  if (fixed[t]) return fixed[t];
  const base = { 2: 'WING IN GROUND', 4: 'HIGH-SPEED CRAFT', 6: 'PASSENGER', 7: 'CARGO', 8: 'TANKER', 9: 'OTHER' }[tens];
  return base ? base + (hz[d] || '') : `CODE ${t}`;
}

export const ais = { on: false, ships: true, cov: false, hidden: new Set(), moving: false, meta: null, busy: false, error: null, sel: null, covMeta: null };

let refreshTimer = null, covTimer = null, moveTimer = null, request = 0, lastBox = null;

// ---------------------------------------------------------------- icons and layers

function drawIcon(color, moving) {
  const size = moving ? 22 : 14, px = size * 2;
  const cv = document.createElement('canvas');
  cv.width = cv.height = px;
  const g = cv.getContext('2d');
  g.scale(2, 2);
  const c = size / 2;
  g.fillStyle = color; g.strokeStyle = 'rgba(1,6,8,0.9)'; g.lineWidth = 1.2; g.lineJoin = 'round';
  g.beginPath();
  if (moving) {
    g.moveTo(c, 1.5); g.lineTo(c + 5, c + 4); g.lineTo(c + 4, size - 2); g.lineTo(c - 4, size - 2); g.lineTo(c - 5, c + 4); g.closePath();
  } else {
    g.arc(c, c, 4, 0, Math.PI * 2);
  }
  g.fill(); g.stroke();
  return { width: px, height: px, data: g.getImageData(0, 0, px, px).data, url: cv.toDataURL() };
}

const iconUrl = {};

function addLayers() {
  CATS.forEach(([, color], k) => {
    for (const mv of [true, false]) {
      const id = `ais-${k}${mv ? 'm' : 's'}`;
      const img = drawIcon(color, mv);
      if (mv) iconUrl[k] = img.url;
      if (map.hasImage(id)) map.removeImage(id);
      map.addImage(id, img, { pixelRatio: 2 });
    }
  });
  const empty = { type: 'FeatureCollection', features: [] };
  const colour = ['match', ['get', 'k'], ...CATS.flatMap(([, c], k) => [k, c]), '#8a9ba8'];
  const fade = ['interpolate', ['linear'], ['get', 'a'], 0, 1, 20, 0.75, 60, 0.4];

  const covColour = ['interpolate', ['linear'], ['log10', ['max', ['get', 'r'], 0.1]], -1, '#123d38', 0, '#1d6b62', 1, '#2fa391', 2, '#8ff5dd', 3, '#ffd27a'];
  // Half-degree cells are too small to see on the whole globe, so wide views draw each cell as a dot.
  map.addSource('cy-ais-cov-pt', { type: 'geojson', data: empty });
  map.addLayer({ id: 'cy-ais-cov-pt', type: 'circle', source: 'cy-ais-cov-pt', maxzoom: 4, layout: { visibility: 'none' },
    paint: { 'circle-color': covColour, 'circle-radius': ['interpolate', ['linear'], ['zoom'], 1, 1.6, 4, 3.2], 'circle-opacity': 0.85, 'circle-blur': 0.3 } }, ANCHOR_OVERLAY);
  map.addSource('cy-ais-cov', { type: 'geojson', data: empty });
  map.addLayer({ id: 'cy-ais-cov', type: 'fill', source: 'cy-ais-cov', minzoom: 4, layout: { visibility: 'none' },
    paint: {
      'fill-color': covColour,
      'fill-opacity': ['interpolate', ['linear'], ['get', 'ago'], 0, 0.55, 24, 0.35, 168, 0.2],
      'fill-antialias': false,
    } }, ANCHOR_OVERLAY);

  map.addSource('cy-ais-track', { type: 'geojson', data: empty });
  map.addLayer({ id: 'cy-ais-track', type: 'line', source: 'cy-ais-track', filter: ['==', ['geometry-type'], 'LineString'],
    paint: { 'line-color': INK.amber, 'line-width': 1.4, 'line-opacity': 0.85, 'line-dasharray': [3, 2] } }, 'cy-target');
  map.addLayer({ id: 'cy-ais-track-pt', type: 'circle', source: 'cy-ais-track', filter: ['==', ['geometry-type'], 'Point'],
    paint: { 'circle-radius': 2, 'circle-color': INK.amber, 'circle-opacity': 0.8 } }, 'cy-target');

  map.addSource('cy-ais', { type: 'geojson', data: empty, buffer: 32 });
  map.addLayer({ id: 'cy-ais-dot', type: 'circle', source: 'cy-ais', maxzoom: ICON_ZOOM, layout: { visibility: 'none' },
    paint: { 'circle-radius': ['interpolate', ['linear'], ['zoom'], 1, 1, 4, 1.8, 6, 2.6], 'circle-color': colour, 'circle-opacity': fade } }, 'cy-target');
  map.addLayer({ id: 'cy-ais', type: 'symbol', source: 'cy-ais', minzoom: ICON_ZOOM,
    layout: {
      visibility: 'none',
      'icon-image': ['concat', 'ais-', ['to-string', ['get', 'k']], ['case', ['get', 'mv'], 'm', 's']],
      'icon-rotate': ['case', ['get', 'mv'], ['get', 'h'], 0], 'icon-rotation-alignment': 'map',
      'icon-allow-overlap': true, 'icon-ignore-placement': true,
      'icon-size': ['interpolate', ['linear'], ['zoom'], 6, 0.75, 10, 1, 14, 1.2],
      'text-field': ['step', ['zoom'], '', 10, ['get', 'n']], 'text-font': ['Noto Sans Regular'], 'text-size': 9.5,
      'text-offset': [0, 1.4], 'text-anchor': 'top', 'text-optional': true,
    },
    paint: { 'icon-opacity': fade, 'text-color': INK.white, 'text-halo-color': INK.halo, 'text-halo-width': 1.4, 'text-opacity': fade } }, 'cy-target');

  map.addSource('cy-ais-sel', { type: 'geojson', data: empty });
  map.addLayer({ id: 'cy-ais-sel', type: 'circle', source: 'cy-ais-sel',
    paint: { 'circle-radius': 13, 'circle-color': 'rgba(0,0,0,0)', 'circle-stroke-color': INK.amber, 'circle-stroke-width': 1.6 } }, 'cy-target');
}

function applyVisibility() {
  const vis = (v) => (v ? 'visible' : 'none');
  map.setLayoutProperty('cy-ais', 'visibility', vis(ais.on && ais.ships));
  map.setLayoutProperty('cy-ais-dot', 'visibility', vis(ais.on && ais.ships));
  map.setLayoutProperty('cy-ais-cov', 'visibility', vis(ais.on && ais.cov));
  map.setLayoutProperty('cy-ais-cov-pt', 'visibility', vis(ais.on && ais.cov));
  const filter = ['all', ['!', ['in', ['get', 'k'], ['literal', [...ais.hidden]]]], ais.moving ? ['get', 'mv'] : true];
  map.setFilter('cy-ais', filter);
  map.setFilter('cy-ais-dot', filter);
}

// ---------------------------------------------------------------- data

function viewBox() {
  if (map.getZoom() < GLOBAL_BELOW_ZOOM) return null;
  const b = map.getBounds();
  let w = b.getWest(), e = b.getEast(), s = b.getSouth(), n = b.getNorth();
  const dx = (e - w) * 0.25, dy = (n - s) * 0.25;
  w -= dx; e += dx; s -= dy; n += dy;
  if (!(e > w) || e - w > 300) return null;
  return [wrapLon(w), clamp(s, -90, 90), wrapLon(e), clamp(n, -90, 90)].map((v) => +v.toFixed(3));
}

/** The visible area, sent so the feeds that cannot take the whole globe can follow it. */
function visibleArea() {
  const b = map.getBounds();
  let w = b.getWest(), e = b.getEast();
  if (e - w >= 360) { w = -180; e = 180; }
  return [wrapLon(w), clamp(b.getSouth(), -85, 85), wrapLon(e), clamp(b.getNorth(), -85, 85)].map((v) => +v.toFixed(3));
}

async function load() {
  if (!ais.on) return;
  const mine = ++request;
  const box = viewBox();
  const q = `view=${visibleArea().join(',')}${box ? `&bbox=${box.join(',')}` : ''}`;
  try {
    const meta = await getJSON(`/api/ais?meta=1&${q}`);
    if (mine !== request || !ais.on) return;
    ais.meta = meta; ais.error = null;
    if (ais.ships) map.getSource('cy-ais').setData(`/api/ais?${q}`);
    lastBox = box;
  } catch (e) {
    if (mine !== request) return;
    ais.error = e.message;
  }
  const m = ais.meta;
  setLamp('ais', ais.error || (m && m.error) ? 'down' : m && m.status === 'RECEIVING' ? 'ok' : 'busy',
    ais.error || (m && (m.error || `${m.ships} ships, ${m.rate} msg/s`)) || 'connecting');
  render();
}

async function loadCoverage() {
  if (!ais.on || !ais.cov) return;
  try {
    const res = await getJSON('/api/ais/coverage');
    ais.covMeta = { hours: res.hours, cells: res.cells };
    setData('cy-ais-cov', res);
    setData('cy-ais-cov-pt', res.features.map((f) => {
      const [w, s] = f.geometry.coordinates[0][0];
      return { type: 'Feature', geometry: { type: 'Point', coordinates: [w + res.cell / 2, s + res.cell / 2] }, properties: f.properties };
    }));
    render();
  } catch (e) {
    ais.error = e.message;
  }
}

export function setAis(patch) {
  const was = ais.on, hadCov = ais.cov;
  Object.assign(ais, patch);
  applyVisibility();
  clearInterval(refreshTimer); clearInterval(covTimer);
  if (!ais.on) {
    request += 1;
    clearShip();
    if (was) fetch('/api/ais', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"action":"stop"}' }).catch(() => {});
    setLamp('ais', '');
    render();
    emit('ais');
    return;
  }
  refreshTimer = setInterval(() => { if (!document.hidden) load(); }, REFRESH_MS);
  if (ais.cov) covTimer = setInterval(() => { if (!document.hidden) loadCoverage(); }, COVERAGE_REFRESH_MS);
  if (!was || 'ships' in patch) load();
  if (ais.cov && (!was || !hadCov)) loadCoverage();
  render();
  emit('ais');
}

// ---------------------------------------------------------------- ships on the globe

export function shipAt(point) {
  if (!ais.on || !ais.ships) return null;
  const pad = map.getZoom() < ICON_ZOOM ? 4 : 9;
  const hit = map.queryRenderedFeatures([[point.x - pad, point.y - pad], [point.x + pad, point.y + pad]], { layers: ['cy-ais', 'cy-ais-dot'] });
  if (!hit.length) return null;
  hit.sort((a, b) => a.properties.a - b.properties.a);
  return hit[0];
}

export function describeShip(f) {
  const p = f.properties;
  return {
    title: p.n || `MMSI ${p.m}`,
    sub: `${CATS[p.k][0]}  ${p.mv ? `${p.s.toFixed(1)} KN` : 'STATIONARY'}  ${p.a ? `${p.a} MIN AGO` : 'NOW'}`,
  };
}

export function clearShip() {
  ais.sel = null;
  setData('cy-ais-track', []);
  setData('cy-ais-sel', []);
}

const knots = (v) => (v === null || v === undefined ? 'N/A' : `${v.toFixed(1)} KN`);
const ago = (sec) => (sec < 90 ? `${sec} S AGO` : sec < 5400 ? `${Math.round(sec / 60)} MIN AGO` : `${(sec / 3600).toFixed(1)} H AGO`);

function etaText(eta) {
  if (!eta || !eta.Month || !eta.Day) return null;
  const mon = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'][eta.Month - 1];
  if (!mon) return null;
  const hm = eta.Hour < 24 && eta.Minute < 60 ? ` ${String(eta.Hour).padStart(2, '0')}:${String(eta.Minute).padStart(2, '0')}Z` : '';
  return `${String(eta.Day).padStart(2, '0')} ${mon}${hm}`;
}

export async function openShip(mmsi, x, y) {
  let s;
  try {
    s = await getJSON(`/api/ais/ship?mmsi=${mmsi}`);
  } catch (e) {
    toast(`SHIP: ${e.message}`.toUpperCase(), true);
    return;
  }
  ais.sel = mmsi;
  const pt = [s.lon, s.lat];
  const tr = s.track || [];
  setData('cy-ais-track', tr.length > 1 ? [
    { type: 'Feature', geometry: { type: 'LineString', coordinates: tr.map((p) => [p[2], p[1]]) }, properties: {} },
    ...tr.map((p) => ({ type: 'Feature', geometry: { type: 'Point', coordinates: [p[2], p[1]] }, properties: {} })),
  ] : []);
  setData('cy-ais-sel', [{ type: 'Feature', geometry: { type: 'Point', coordinates: pt }, properties: {} }]);
  const k = Math.max(0, ['cargo', 'tanker', 'passenger', 'fishing', 'military', 'service', 'leisure', 'other'].indexOf(s.category));
  const flag = flagOf(s.mmsi);
  const size = s.length ? `${s.length} × ${s.beam || '?'} M` : null;
  const fact = (key, val) => (val === null || val === undefined || val === '' ? '' : [h('dt', null, key), h('dd', null, val)]);
  const hours = tr.length > 1 ? ((tr[tr.length - 1][0] - tr[0][0]) / 3600000) : 0;
  const el = $('#picker');
  el.classList.add('wide');
  el.replaceChildren(
    h('div', { class: 'panel-head' }, h('span', { style: { color: CATS[k][1] } }, s.name || `MMSI ${s.mmsi}`), h('button', { class: 'x', onclick: () => { closePicker(); clearShip(); } }, 'X')),
    h('div', { class: 'panel-body' },
      h('dl', { class: 'facts' },
        fact('MMSI', String(s.mmsi)),
        fact('IMO', s.imo ? String(s.imo) : null),
        fact('CALL SIGN', s.call),
        fact('FLAG', flag ? `${flag} (FROM MMSI)` : 'UNKNOWN'),
        fact('TYPE', `${typeText(s.type)}`),
        fact('STATUS', NAV[s.nav] || null),
        fact('SPEED', knots(s.sog)),
        fact('COURSE', s.cog !== null && s.cog !== undefined ? `${s.cog.toFixed(1)}°` : null),
        fact('HEADING', s.hdg !== null && s.hdg !== undefined ? `${s.hdg}°` : null),
        fact('DESTINATION', s.dest),
        fact('ETA', etaText(s.eta)),
        fact('SIZE', size),
        fact('DRAUGHT', s.draught ? `${s.draught} M` : null),
        fact('TRANSPONDER', s.cls === 'A' ? 'CLASS A (COMMERCIAL)' : s.cls === 'B' ? 'CLASS B (SMALL CRAFT)' : null),
        fact('POSITION', fmtPos(pt, 4)),
        fact('LAST REPORT', `${stamp(s.t)}  ${ago(s.age)}`),
        fact('HEARD VIA', (s.sources || []).map((x) => {
          const [src, via] = x.source.split('/');
          const name = { aisstream: 'AISSTREAM', fintraffic: 'FINTRAFFIC', openwaters: 'OPEN WATERS', pelyr: 'PELYR' }[src] || src.toUpperCase();
          return `${name}${via ? ` (${via.startsWith('station:') ? 'VOLUNTEER STATION' : via.toUpperCase()})` : ''}`;
        }).filter((v, i, a) => a.indexOf(v) === i).join(', ') || null),
        fact('TRACK', tr.length > 1 ? `${tr.length} POINTS OVER ${hours.toFixed(1)} H (RECORDED BY THIS BOARD)` : 'NONE RECORDED YET')),
      h('div', { class: 'links', style: { padding: '0 10px 8px' } },
        h('a', { href: `https://www.marinetraffic.com/en/ais/details/ships/mmsi:${s.mmsi}`, target: '_blank', rel: 'noopener noreferrer' }, 'MARINETRAFFIC'),
        h('a', { href: `https://www.vesselfinder.com/vessels/details/${s.mmsi}`, target: '_blank', rel: 'noopener noreferrer' }, 'VESSELFINDER'),
        s.imo ? h('a', { href: `https://www.equasis.org/`, target: '_blank', rel: 'noopener noreferrer', title: `Search IMO ${s.imo} (free account)` }, 'EQUASIS') : ''),
      h('div', { class: 'i-note' }, 'POSITION AND IDENTITY ARE SELF-REPORTED BY THE SHIP. GPS JAMMING AND SPOOFING ARE COMMON IN CONFLICT AREAS.')),
    h('div', { class: 'btnrow' },
      h('button', { class: 'primary', title: 'Search imagery of this position with the selected fleet', onclick: () => { closePicker(); setTarget(pt); toast(`FOCUS DESIGNATED ${fmtPos(pt, 3)}`); } }, 'DESIGNATE FOCUS'),
      tr.length > 1 ? h('button', { title: 'Fit the recorded track in view', onclick: () => {
        const lons = tr.map((p) => p[2]), lats = tr.map((p) => p[1]);
        closePicker();
        map.fitBounds([[Math.min(...lons), Math.min(...lats)], [Math.max(...lons), Math.max(...lats)]], { padding: 120, maxZoom: 12, duration: 1200 });
      } }, 'SHOW TRACK') : ''),
  );
  placePicker(x, y);
}

// ---------------------------------------------------------------- control block

function seg(options, onPick) {
  return h('div', { class: 'seg' }, options.map(([on, label, title, fn]) => h('button', { class: on ? 'on' : '', title, onclick: fn || (() => onPick(label)) }, label)));
}

function statusLine() {
  const m = ais.meta;
  const n = (v) => v.toLocaleString('en-US');
  if (ais.error) return h('div', { class: 'ov-note red' }, `UNAVAILABLE: ${ais.error}`.toUpperCase());
  if (!m) return h('div', { class: 'ov-note amber' }, 'CONNECTING…');
  const lines = [];
  if (m.error) lines.push(h('div', { class: 'ov-note red' }, m.error));
  else if (m.status !== 'RECEIVING') lines.push(h('div', { class: 'ov-note amber' }, 'CONNECTING…'));
  else lines.push(h('div', { class: 'ov-note' }, `${m.inView !== null ? `${n(m.inView)} IN VIEW  ` : ''}${n(m.ships)} TRACKED  ${m.rate} MSG/S`));
  lines.push(h('div', { class: 'ais-src' }, (m.sources || []).map((s) => {
    const state = s.status === 'RECEIVING' ? 'ok' : s.status === 'STOPPED' ? 'off' : s.error ? 'bad' : 'wait';
    const detail = s.error || (s.status === 'RECEIVING' ? `${s.rate}/S${s.view ? ' (VIEW)' : ''}` : s.status);
    return h('div', { class: `src ${state}`, title: [s.error, s.note].filter(Boolean).join('. ') || s.status },
      h('i'), h('span', { class: 'nm' }, s.label), h('span', { class: 'st' }, detail));
  })));
  if (m.attribution && m.attribution.length) lines.push(h('div', { class: 'ov-note attrib' }, m.attribution.join(' · ')));
  if (ais.ships && m.status === 'RECEIVING' && m.since && Date.now() / 1000 - m.since < 600) {
    lines.push(h('div', { class: 'ov-note' }, 'MOVING SHIPS APPEAR WITHIN SECONDS; MOORED ONES WITHIN A FEW MINUTES.'));
  }
  if (ais.cov) {
    const c = ais.covMeta;
    lines.push(h('div', { class: 'ov-note' }, c ? `COVERAGE: ${c.hours < 1 ? `${Math.round(c.hours * 60)} MIN` : `${c.hours.toFixed(1)} H`} RECORDED, ${n(c.cells)} CELLS OF 0.5°. BRIGHTER = MORE REPORTS PER HOUR.` : 'LOADING COVERAGE…'));
  }
  return lines;
}

function render() {
  const el = $('#ais-block');
  if (!el) return;
  const toggle = (key, label, title) => [ais[key], label, title, () => setAis({ [key]: !ais[key] })];
  el.replaceChildren(
    h('div', { class: 'row-c ov-head' + (ais.on ? '' : ' off'), style: { '--c': '#5ac8fa' }, title: 'Live ship positions (AIS) from aisstream.io',
      onclick: () => setAis({ on: !ais.on }) },
    h('button', { class: 'lampbtn' + (ais.on ? ' lit' : ''), 'aria-pressed': String(ais.on), title: ais.on ? 'Hide ships' : 'Show ships',
      onclick: (e) => { e.stopPropagation(); setAis({ on: !ais.on }); } }),
    h('span', { class: 'nm' }, 'AIS SHIPPING'),
    h('span', { class: 'tag' }, 'LIVE')),
    ais.on ? h('div', { class: 'ov-body' },
      h('div', { class: 'ctl' },
        h('span', { class: 'k' }, 'SHOW'),
        seg([toggle('ships', 'SHIPS', 'Ship positions heard in the last hour'), toggle('cov', 'COVERAGE', 'Where reports have been received while this board was recording'),
          toggle('moving', 'MOVING', 'Only ships under way')]),
        h('span', { class: 'k' }, 'TYPES'),
        h('div', { class: 'i-cats' }, CATS.map(([label], k) => h('button', {
          class: ais.hidden.has(k) ? 'off' : '', title: `${label}. Click to ${ais.hidden.has(k) ? 'show' : 'hide'}.`,
          onclick: () => { if (ais.hidden.has(k)) ais.hidden.delete(k); else ais.hidden.add(k); applyVisibility(); render(); },
        }, h('img', { src: iconUrl[k], alt: label, style: { width: '16px', height: '16px' } }))))),
      statusLine()) : '',
  );
}

export function initAis() {
  addLayers();
  render();
  map.on('moveend', () => {
    if (!ais.on || !ais.ships) return;
    clearTimeout(moveTimer);
    moveTimer = setTimeout(() => {
      const box = viewBox();
      if (JSON.stringify(box) !== JSON.stringify(lastBox) || box === null) load();
      else getJSON(`/api/ais?meta=1&view=${visibleArea().join(',')}`).catch(() => {});     // let view-following feeds move
    }, 400);
  });
}
