// The globe: MapLibre map, board graphic layers, and helpers to feed them.
/* global maplibregl */

import { S } from './state.js';
import { boardStyle, applyBasemap, setImagery, IMAGERY, INK, ANCHOR_IMAGERY, ANCHOR_OVERLAY } from './basemap.js';
import { enableLive, disableLive, LIVE } from './live.js';
import { nightPolygon } from './util.js';

export let map = null;

const EMPTY = { type: 'FeatureCollection', features: [] };
const FONT_B = ['Noto Sans Bold'];

// ---------------------------------------------------------------- icons

function canvasIcon(size, draw) {
  const px = size * 2;
  const c = document.createElement('canvas');
  c.width = c.height = px;
  const g = c.getContext('2d');
  g.scale(2, 2);
  draw(g, size);
  return { width: px, height: px, data: g.getImageData(0, 0, px, px).data };
}

function satIcon(shape, color) {
  return canvasIcon(22, (g, s) => {
    const c = s / 2, r = 7;
    g.lineWidth = 1.6; g.strokeStyle = color; g.fillStyle = 'rgba(1,6,8,0.85)';
    g.shadowColor = color; g.shadowBlur = 4;
    g.beginPath();
    if (shape === 'sar') { g.moveTo(c, c - r); g.lineTo(c + r, c + r * 0.8); g.lineTo(c - r, c + r * 0.8); }
    else if (shape === 'multi') { g.rect(c - r * 0.8, c - r * 0.8, r * 1.6, r * 1.6); }
    else { g.moveTo(c, c - r); g.lineTo(c + r, c); g.lineTo(c, c + r); g.lineTo(c - r, c); }
    g.closePath(); g.fill(); g.stroke();
    g.shadowBlur = 0; g.fillStyle = color;
    g.fillRect(c - 1, c - 1 + (shape === 'sar' ? 1.5 : 0), 2, 2);
  });
}

function putImage(id, img) {
  if (map.hasImage(id)) map.removeImage(id);          // replace any placeholder added while loading
  map.addImage(id, img, { pixelRatio: 2 });
}

function addIcons() {
  for (const c of S.catalog.constellations) {
    putImage(`sat-${c.id}`, satIcon(c.sensor, c.color));
  }
  putImage('cy-dot', canvasIcon(8, (g, s) => {
    g.fillStyle = INK.label; g.fillRect(s / 2 - 2, s / 2 - 2, 4, 4);
  }));
  putImage('cy-reticle', canvasIcon(44, (g, s) => {
    const c = s / 2;
    g.strokeStyle = INK.amber; g.lineWidth = 1.5; g.shadowColor = INK.amber; g.shadowBlur = 5;
    g.beginPath(); g.arc(c, c, 9, 0, Math.PI * 2); g.stroke();
    g.beginPath();
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) { g.moveTo(c + dx * 5, c + dy * 5); g.lineTo(c + dx * 19, c + dy * 19); }
    g.stroke();
    g.fillStyle = INK.amber; g.fillRect(c - 1, c - 1, 2, 2);
  }));
  putImage('cy-select', canvasIcon(40, (g, s) => {
    g.strokeStyle = INK.white; g.lineWidth = 1.5;
    const a = 6, b = s - 6, k = 7;
    g.beginPath();
    g.moveTo(a, a + k); g.lineTo(a, a); g.lineTo(a + k, a);
    g.moveTo(b - k, a); g.lineTo(b, a); g.lineTo(b, a + k);
    g.moveTo(b, b - k); g.lineTo(b, b); g.lineTo(b - k, b);
    g.moveTo(a + k, b); g.lineTo(a, b); g.lineTo(a, b - k);
    g.stroke();
  }));
}

// ---------------------------------------------------------------- static graphics

function graticule() {
  const feats = [];
  const line = (coords, major) => feats.push({ type: 'Feature', properties: { major }, geometry: { type: 'LineString', coordinates: coords } });
  for (let lon = -180; lon < 180; lon += 10) {
    const pts = [];
    for (let lat = -85; lat <= 85; lat += 2.5) pts.push([lon, lat]);
    line(pts, lon % 30 === 0);
  }
  for (let lat = -80; lat <= 80; lat += 10) {
    const pts = [];
    for (let lon = -180; lon <= 180; lon += 2.5) pts.push([lon, lat]);
    line(pts, lat % 30 === 0);
  }
  return { type: 'FeatureCollection', features: feats };
}

function addBoardLayers() {
  const src = (id, data = EMPTY) => map.addSource(id, { type: 'geojson', data, tolerance: 0.2 });

  // --- below the labels
  src('cy-night');
  map.addLayer({ id: 'cy-night', type: 'fill', source: 'cy-night', paint: { 'fill-color': '#000', 'fill-opacity': 0.42, 'fill-antialias': false } }, ANCHOR_OVERLAY);

  src('cy-grat', graticule());
  map.addLayer({ id: 'cy-grat', type: 'line', source: 'cy-grat',
    paint: { 'line-color': ['case', ['get', 'major'], INK.gridMajor, INK.grid], 'line-width': ['case', ['get', 'major'], 0.8, 0.5], 'line-opacity': 0.8 } }, ANCHOR_OVERLAY);

  src('cy-foot');
  const isScene = ['==', ['get', 'kind'], 'scene'];
  const isFuture = ['!=', ['get', 'kind'], 'scene'];
  map.addLayer({ id: 'cy-plan-fill', type: 'fill', source: 'cy-foot', filter: ['>', ['get', 'fo'], 0],
    paint: { 'fill-color': ['get', 'color'], 'fill-opacity': ['get', 'fo'] } }, ANCHOR_OVERLAY);
  map.addLayer({ id: 'cy-foot-line', type: 'line', source: 'cy-foot', filter: isScene,
    paint: { 'line-color': ['get', 'color'], 'line-opacity': 0.75, 'line-width': 1 } }, ANCHOR_OVERLAY);
  map.addLayer({ id: 'cy-plan-line', type: 'line', source: 'cy-foot', filter: isFuture,
    paint: { 'line-color': ['get', 'color'], 'line-opacity': ['case', ['get', 'past'], 0.35, 0.85], 'line-width': 1, 'line-dasharray': [4, 3] } }, ANCHOR_OVERLAY);

  src('cy-aoi');
  map.addLayer({ id: 'cy-aoi', type: 'line', source: 'cy-aoi',
    paint: { 'line-color': INK.amber, 'line-width': 1, 'line-dasharray': [2, 2], 'line-opacity': 0.9 } }, ANCHOR_OVERLAY);

  // --- above everything
  src('cy-hl');
  map.addLayer({ id: 'cy-hl-hover-fill', type: 'fill', source: 'cy-hl', filter: ['==', ['get', 'role'], 'hover'],
    paint: { 'fill-color': ['get', 'color'], 'fill-opacity': 0.12 } });
  map.addLayer({ id: 'cy-hl-hover', type: 'line', source: 'cy-hl', filter: ['==', ['get', 'role'], 'hover'],
    paint: { 'line-color': INK.white, 'line-width': 1.5 } });
  map.addLayer({ id: 'cy-hl-sel-glow', type: 'line', source: 'cy-hl', filter: ['==', ['get', 'role'], 'selected'],
    paint: { 'line-color': INK.amber, 'line-width': 6, 'line-blur': 5, 'line-opacity': 0.6 } });
  map.addLayer({ id: 'cy-hl-sel', type: 'line', source: 'cy-hl', filter: ['==', ['get', 'role'], 'selected'],
    paint: { 'line-color': INK.amber, 'line-width': 2 } });

  src('cy-swath');
  map.addLayer({ id: 'cy-swath-fill', type: 'fill', source: 'cy-swath', filter: ['==', ['geometry-type'], 'Polygon'],
    paint: { 'fill-color': ['get', 'color'], 'fill-opacity': 0.12 } });
  map.addLayer({ id: 'cy-swath-bar', type: 'line', source: 'cy-swath', filter: ['==', ['geometry-type'], 'LineString'],
    paint: { 'line-color': ['get', 'color'], 'line-width': ['case', ['get', 'reach'], 1, 2.5], 'line-opacity': ['case', ['get', 'reach'], 0.55, 1] } });

  src('cy-tracks');
  map.addLayer({ id: 'cy-tracks-past', type: 'line', source: 'cy-tracks', filter: ['==', ['get', 'phase'], 'past'],
    paint: { 'line-color': ['get', 'color'], 'line-opacity': 0.35, 'line-width': 1, 'line-dasharray': [1, 3] } });
  map.addLayer({ id: 'cy-tracks-glow', type: 'line', source: 'cy-tracks', filter: ['==', ['get', 'phase'], 'next'],
    paint: { 'line-color': ['get', 'color'], 'line-opacity': 0.25, 'line-width': 5, 'line-blur': 4 } });
  map.addLayer({ id: 'cy-tracks-next', type: 'line', source: 'cy-tracks', filter: ['==', ['get', 'phase'], 'next'],
    paint: { 'line-color': ['get', 'color'], 'line-opacity': 0.9, 'line-width': 1.2 } });

  src('cy-target');
  map.addLayer({ id: 'cy-target', type: 'symbol', source: 'cy-target',
    layout: { 'icon-image': 'cy-reticle', 'icon-allow-overlap': true, 'icon-ignore-placement': true,
      'text-field': ['get', 'label'], 'text-font': FONT_B, 'text-size': 10, 'text-offset': [0, 2.4], 'text-letter-spacing': 0.12,
      'text-allow-overlap': true, 'text-ignore-placement': true },
    paint: { 'text-color': INK.amber, 'text-halo-color': INK.halo, 'text-halo-width': 1.5 } });

  src('cy-sats');
  map.addLayer({ id: 'cy-sat-select', type: 'symbol', source: 'cy-sats', filter: ['==', ['get', 'sel'], true],
    layout: { 'icon-image': 'cy-select', 'icon-allow-overlap': true, 'icon-ignore-placement': true } });
  map.addLayer({ id: 'cy-sats', type: 'symbol', source: 'cy-sats',
    layout: {
      'icon-image': ['concat', 'sat-', ['get', 'cid']], 'icon-allow-overlap': true, 'icon-ignore-placement': true,
      'icon-size': ['case', ['get', 'act'], 1, 0.8],
      'text-field': ['case', ['get', 'lab'], ['get', 'label'], ''], 'text-font': FONT_B, 'text-size': ['case', ['get', 'act'], 11, 9.5],
      'text-anchor': 'left', 'text-offset': [0.95, 0], 'text-letter-spacing': 0.08, 'text-optional': true,
      'symbol-sort-key': ['case', ['get', 'act'], 0, 1],
    },
    paint: { 'text-color': ['get', 'color'], 'text-halo-color': INK.halo, 'text-halo-width': 1.6,
      'icon-opacity': ['case', ['get', 'dim'], 0.45, 1], 'text-opacity': ['case', ['get', 'dim'], 0.6, 1] } });
}

// ---------------------------------------------------------------- lifecycle

export function initGlobe(view) {
  return new Promise((resolve, reject) => {
    map = new maplibregl.Map({
      container: 'globe',
      style: boardStyle(),
      center: view ? [view.lon, view.lat] : [28, 30],
      zoom: view ? view.zoom : 1.7,
      minZoom: 0.6, maxZoom: 17,
      attributionControl: false,
      dragRotate: true, maxPitch: 50,
      fadeDuration: 120,
    });
    map.setPadding(boardPadding());
    map.on('styleimagemissing', (e) => {
      if (!map.hasImage(e.id)) map.addImage(e.id, { width: 1, height: 1, data: new Uint8Array(4) });
    });
    let settled = false;
    map.on('error', (e) => {
      if (!settled && e && e.error && /style/i.test(String(e.error.message))) { settled = true; reject(e.error); }
      else console.warn('map:', e && e.error ? e.error.message : e);
    });
    map.on('load', () => {
      addIcons();
      addBoardLayers();
      updateNight(Date.now());
      settled = true;
      resolve(map);
    });
  });
}

/** Screen area not covered by panels, so the globe and fitted views sit in the clear. */
export function boardPadding() {
  const el = (id) => document.getElementById(id);
  const mission = el('mission');
  const narrow = window.innerWidth < 900;
  return {
    top: el('topbar').offsetHeight, bottom: el('bottombar').offsetHeight,
    left: narrow ? 0 : el('roster').offsetWidth + 10,
    right: narrow || mission.hidden ? 0 : mission.offsetWidth + 10,
  };
}

export function syncPadding() {
  map.easeTo({ padding: boardPadding(), duration: 500 });
}

export function setData(id, features) {
  const src = map && map.getSource(id);
  if (src) src.setData(Array.isArray(features) ? { type: 'FeatureCollection', features } : features);
}

export function updateNight(ms) {
  setData('cy-night', S.showNight ? [nightPolygon(ms)] : []);
}

let imageryOnMap = 'esri';

/** mode: 'vector' | 'imagery' | 'live'. variant picks the imagery provider or the live product. */
export function setBasemap(mode, variant) {
  if (mode === 'imagery') {
    if (variant && IMAGERY[variant]) S.imagery = variant;
    if (S.imagery !== imageryOnMap) { setImagery(map, S.imagery); imageryOnMap = S.imagery; }
  }
  if (mode === 'live') {
    if (variant && LIVE[variant]) S.live = variant;
    enableLive(map, S.live);
  } else {
    disableLive(map);
  }
  S.basemap = mode;
  applyBasemap(map, mode);
  // Live colour imagery already shows night for itself; the infrared product does not.
  const shade = mode === 'vector' ? 0.42 : mode === 'imagery' || S.live === 'infrared' ? 0.3 : 0;
  map.setPaintProperty('cy-night', 'fill-opacity', shade);
}

export function setGridVisible(v) {
  S.showGrid = v;
  map.setLayoutProperty('cy-grat', 'visibility', v ? 'visible' : 'none');
}

// ---------------------------------------------------------------- imagery layers

/** Draw a tiled scene on the board. Tiles are only requested inside the scene bounds. */
export function showRaster(key, { tiles, bounds, minzoom = 0, maxzoom = 14, tileSize = 256, opacity = 1, attribution, resampling = 'linear', base = false }) {
  hideRaster(key);
  // Base layers (global mosaics) sit beneath any individual scenes already on the board.
  const firstScene = base ? map.getStyle().layers.find((l) => l.id.startsWith('r-')) : null;
  const before = firstScene ? firstScene.id : ANCHOR_IMAGERY;
  const def = { type: 'raster', tiles, tileSize, minzoom, maxzoom, attribution };
  if (bounds && bounds[0] < bounds[2] && bounds[2] - bounds[0] < 180) {
    def.bounds = [Math.max(-180, bounds[0]), Math.max(-85, bounds[1]), Math.min(180, bounds[2]), Math.min(85, bounds[3])];
  }
  map.addSource(`r-${key}`, def);
  map.addLayer({ id: `r-${key}`, type: 'raster', source: `r-${key}`,
    paint: { 'raster-opacity': opacity, 'raster-fade-duration': 180, 'raster-resampling': resampling } }, before);
}

export function hideRaster(key) {
  if (map.getLayer(`r-${key}`)) map.removeLayer(`r-${key}`);
  if (map.getSource(`r-${key}`)) map.removeSource(`r-${key}`);
}

export function setRasterOpacity(key, opacity) {
  if (map.getLayer(`r-${key}`)) map.setPaintProperty(`r-${key}`, 'raster-opacity', opacity);
}

export function fitTo(bbox, opts = {}) {
  let [w, s, e, n] = bbox;
  if (e - w > 300) return;                         // antimeridian-spanning box: leave the camera alone
  map.fitBounds([[w, Math.max(-85, s)], [e, Math.min(85, n)]], { padding: 40, maxZoom: 11, duration: 1400, ...opts });
}
