// MapLibre style for the board: a vector "situation display" basemap drawn as glowing
// linework on black, with an optional satellite-imagery underlay.

export const INK = {
  bg: '#010608',
  land: '#04191b',
  water: '#010a0d',
  coast: '#4ff0cc',
  coastGlow: '#1fb497',
  border: '#2aa890',
  border2: '#1b6b5e',
  grid: '#0e4640',
  gridMajor: '#1c7468',
  road: '#1d6f66',
  roadMajor: '#2a9a8a',
  rail: '#5c6f3a',
  label: '#9af3dd',
  labelDim: '#4fae9c',
  halo: '#010608',
  amber: '#ffb300',
  white: '#e2fff7',
};

const FONT = ['Noto Sans Regular'];
const FONT_B = ['Noto Sans Bold'];
const NAME = ['coalesce', ['get', 'name:en'], ['get', 'name:latin'], ['get', 'name']];

/** Satellite basemaps. Add an entry here to offer another Web Mercator tile source; a picker appears once there are two. */
export const IMAGERY = {
  esri: { label: 'ESRI', name: 'ESRI WORLD IMAGERY', maxzoom: 18,
    tiles: ['https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}'] },
};

const IMAGERY_PAINT = { 'raster-saturation': -0.25, 'raster-brightness-max': 0.82, 'raster-contrast': 0.08, 'raster-fade-duration': 150 };

function imagerySource(id) {
  const p = IMAGERY[id];
  return { type: 'raster', tileSize: 256, tiles: p.tiles, minzoom: p.minzoom || 0, maxzoom: p.maxzoom, attribution: p.name };
}

/** Swap the provider behind the imagery basemap. */
export function setImagery(map, id) {
  const visibility = map.getLayoutProperty('imagery', 'visibility') || 'none';
  map.removeLayer('imagery');
  map.removeSource('imagery');
  map.addSource('imagery', imagerySource(id));
  map.addLayer({ id: 'imagery', type: 'raster', source: 'imagery', layout: { visibility }, paint: IMAGERY_PAINT }, 'water');
}

export const ANCHOR_IMAGERY = 'cy-anchor-imagery';   // rendered scenes go below this
export const ANCHOR_OVERLAY = 'cy-anchor-overlay';   // board graphics go below this (labels stay on top)

export function boardStyle() {
  return {
    version: 8,
    name: 'Cheyenne board',
    projection: { type: 'globe' },
    sky: {
      'sky-color': '#020b0d', 'horizon-color': '#1fb497', 'fog-color': '#020b0d',
      'sky-horizon-blend': 0.6, 'horizon-fog-blend': 0.6, 'fog-ground-blend': 0.2,
      'atmosphere-blend': ['interpolate', ['linear'], ['zoom'], 0, 0.55, 4, 0.35, 6.5, 0],
    },
    glyphs: 'https://tiles.openfreemap.org/fonts/{fontstack}/{range}.pbf',
    sources: {
      omt: { type: 'vector', url: 'https://tiles.openfreemap.org/planet', attribution: 'OpenFreeMap / OpenMapTiles / OpenStreetMap' },
      imagery: imagerySource('esri'),
    },
    layers: [
      { id: 'bg', type: 'background', paint: { 'background-color': INK.land } },
      { id: 'imagery', type: 'raster', source: 'imagery', layout: { visibility: 'none' }, paint: IMAGERY_PAINT },
      { id: 'water', type: 'fill', source: 'omt', 'source-layer': 'water',
        filter: ['!=', ['get', 'brunnel'], 'tunnel'],
        paint: { 'fill-color': INK.water, 'fill-antialias': false } },
      { id: ANCHOR_IMAGERY, type: 'background', layout: { visibility: 'none' } },

      { id: 'landuse-mil', type: 'line', source: 'omt', 'source-layer': 'landuse', minzoom: 9,
        filter: ['==', ['get', 'class'], 'military'],
        paint: { 'line-color': INK.amber, 'line-opacity': 0.55, 'line-width': 1, 'line-dasharray': [1, 2] } },
      { id: 'waterway', type: 'line', source: 'omt', 'source-layer': 'waterway', minzoom: 7,
        paint: { 'line-color': INK.coastGlow, 'line-opacity': 0.7, 'line-width': ['interpolate', ['linear'], ['zoom'], 7, 0.4, 14, 1.4] } },
      { id: 'coast-glow', type: 'line', source: 'omt', 'source-layer': 'water',
        filter: ['!=', ['get', 'brunnel'], 'tunnel'],
        paint: { 'line-color': INK.coastGlow, 'line-opacity': 0.45, 'line-width': ['interpolate', ['linear'], ['zoom'], 0, 3, 8, 5], 'line-blur': 3 } },
      { id: 'coast', type: 'line', source: 'omt', 'source-layer': 'water',
        filter: ['!=', ['get', 'brunnel'], 'tunnel'],
        paint: { 'line-color': INK.coast, 'line-width': ['interpolate', ['linear'], ['zoom'], 0, 0.7, 8, 1.1, 14, 1.4] } },

      { id: 'building', type: 'line', source: 'omt', 'source-layer': 'building', minzoom: 14,
        paint: { 'line-color': INK.road, 'line-opacity': 0.8, 'line-width': 0.6 } },
      { id: 'aeroway', type: 'line', source: 'omt', 'source-layer': 'aeroway', minzoom: 10,
        filter: ['in', ['get', 'class'], ['literal', ['runway', 'taxiway']]],
        paint: { 'line-color': INK.white, 'line-opacity': 0.75,
          'line-width': ['interpolate', ['linear'], ['zoom'], 10, ['match', ['get', 'class'], 'runway', 1.2, 0.3], 15, ['match', ['get', 'class'], 'runway', 6, 1.5]] } },
      { id: 'rail', type: 'line', source: 'omt', 'source-layer': 'transportation', minzoom: 8,
        filter: ['==', ['get', 'class'], 'rail'],
        paint: { 'line-color': INK.rail, 'line-width': 0.9, 'line-dasharray': [4, 2] } },
      { id: 'road-minor', type: 'line', source: 'omt', 'source-layer': 'transportation', minzoom: 12,
        filter: ['in', ['get', 'class'], ['literal', ['minor', 'service', 'track', 'tertiary', 'secondary']]],
        paint: { 'line-color': INK.road, 'line-opacity': 0.75, 'line-width': ['interpolate', ['linear'], ['zoom'], 12, 0.3, 16, 1.2] } },
      { id: 'road-major', type: 'line', source: 'omt', 'source-layer': 'transportation', minzoom: 6,
        filter: ['in', ['get', 'class'], ['literal', ['motorway', 'trunk', 'primary']]],
        paint: { 'line-color': INK.roadMajor, 'line-opacity': ['interpolate', ['linear'], ['zoom'], 6, 0.35, 10, 0.85],
          'line-width': ['interpolate', ['linear'], ['zoom'], 6, 0.4, 12, 1.2, 16, 2.2] } },

      { id: 'border-sub', type: 'line', source: 'omt', 'source-layer': 'boundary', minzoom: 4,
        filter: ['all', ['==', ['get', 'admin_level'], 4], ['!=', ['get', 'maritime'], 1]],
        paint: { 'line-color': INK.border2, 'line-width': 0.7, 'line-dasharray': [2, 3] } },
      { id: 'border', type: 'line', source: 'omt', 'source-layer': 'boundary',
        filter: ['all', ['<=', ['coalesce', ['get', 'admin_level'], 99], 2], ['!=', ['get', 'maritime'], 1]],
        paint: { 'line-color': INK.border, 'line-opacity': 0.9,
          'line-width': ['interpolate', ['linear'], ['zoom'], 0, 0.5, 6, 1, 12, 1.6], 'line-dasharray': [5, 2] } },
      { id: 'border-disputed', type: 'line', source: 'omt', 'source-layer': 'boundary',
        filter: ['all', ['<=', ['coalesce', ['get', 'admin_level'], 99], 2], ['==', ['get', 'disputed'], 1]],
        paint: { 'line-color': INK.amber, 'line-opacity': 0.8, 'line-width': 1, 'line-dasharray': [1, 2] } },

      { id: ANCHOR_OVERLAY, type: 'background', layout: { visibility: 'none' } },

      { id: 'label-water', type: 'symbol', source: 'omt', 'source-layer': 'water_name', minzoom: 2,
        filter: ['==', ['geometry-type'], 'Point'],
        layout: { 'text-field': NAME, 'text-font': FONT, 'text-size': 10, 'text-transform': 'uppercase', 'text-letter-spacing': 0.35, 'text-max-width': 6 },
        paint: { 'text-color': INK.gridMajor, 'text-halo-color': INK.halo, 'text-halo-width': 1 } },
      { id: 'label-airport', type: 'symbol', source: 'omt', 'source-layer': 'aerodrome_label', minzoom: 9,
        layout: { 'text-field': ['coalesce', ['get', 'icao'], ['get', 'iata'], NAME], 'text-font': FONT_B, 'text-size': 10, 'text-letter-spacing': 0.15, 'text-offset': [0, 0.9] },
        paint: { 'text-color': INK.white, 'text-halo-color': INK.halo, 'text-halo-width': 1.5 } },
      { id: 'label-place', type: 'symbol', source: 'omt', 'source-layer': 'place', minzoom: 4,
        filter: ['in', ['get', 'class'], ['literal', ['city', 'town', 'village']]],
        layout: {
          'text-field': NAME, 'text-font': FONT, 'text-transform': 'uppercase', 'text-letter-spacing': 0.12,
          'text-size': ['interpolate', ['linear'], ['zoom'], 4, ['match', ['get', 'class'], 'city', 9.5, 0], 8, ['match', ['get', 'class'], 'city', 12, 'town', 9.5, 0], 12, ['match', ['get', 'class'], 'city', 14, 'town', 11.5, 10]],
          'text-anchor': 'left', 'text-offset': [0.6, 0], 'text-max-width': 9,
          'symbol-sort-key': ['coalesce', ['get', 'rank'], 20],
          'icon-image': 'cy-dot', 'icon-size': 0.5, 'icon-allow-overlap': false,
        },
        paint: { 'text-color': INK.label, 'text-halo-color': INK.halo, 'text-halo-width': 1.5 } },
      { id: 'label-state', type: 'symbol', source: 'omt', 'source-layer': 'place', minzoom: 4, maxzoom: 8,
        filter: ['==', ['get', 'class'], 'state'],
        layout: { 'text-field': NAME, 'text-font': FONT, 'text-size': 9.5, 'text-transform': 'uppercase', 'text-letter-spacing': 0.3, 'text-max-width': 7 },
        paint: { 'text-color': INK.labelDim, 'text-halo-color': INK.halo, 'text-halo-width': 1 } },
      { id: 'label-country', type: 'symbol', source: 'omt', 'source-layer': 'place', minzoom: 1.5, maxzoom: 8,
        filter: ['==', ['get', 'class'], 'country'],
        layout: {
          'text-field': NAME, 'text-font': FONT_B, 'text-transform': 'uppercase', 'text-letter-spacing': 0.25, 'text-max-width': 7,
          'text-size': ['interpolate', ['linear'], ['zoom'], 1.5, 8.5, 5, 12.5],
          'symbol-sort-key': ['coalesce', ['get', 'rank'], 10],
        },
        paint: { 'text-color': INK.labelDim, 'text-halo-color': INK.halo, 'text-halo-width': 1.5 } },
    ],
  };
}

/** Restyle the vector linework for the board ('vector'), a satellite basemap ('imagery') or live weather imagery ('live'). */
export function applyBasemap(map, mode) {
  const img = mode !== 'vector';
  const live = mode === 'live';
  map.setLayoutProperty('imagery', 'visibility', mode === 'imagery' ? 'visible' : 'none');
  map.setPaintProperty('water', 'fill-opacity', img ? 0 : 1);
  map.setPaintProperty('coast-glow', 'line-opacity', img ? 0 : 0.45);
  map.setPaintProperty('coast', 'line-opacity', live ? 0.8 : img ? 0.45 : 1);
  map.setPaintProperty('road-minor', 'line-opacity', img ? 0.35 : 0.75);
  map.setPaintProperty('building', 'line-opacity', img ? 0 : 0.8);
  map.setPaintProperty('label-place', 'text-color', img ? INK.white : INK.label);
  map.setPaintProperty('label-country', 'text-color', img ? INK.white : INK.labelDim);
}
