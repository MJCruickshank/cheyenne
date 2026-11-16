// LIVE view: the newest full-disc imagery from the geostationary weather satellites,
// draped on the globe and refreshed as new frames arrive.
//
// GOES-East and GOES-West come from NASA GIBS; Meteosat and the multi-mission
// "geostationary ring" mosaics come from EUMETSAT's EUMETView map service.

import { emit } from './state.js';
import { getJSON, hms } from './util.js';

const EUM = 'https://view.eumetsat.int/geoserver/ows';
const GIBS = 'https://gibs.earthdata.nasa.gov/wmts/epsg3857/best';
const REFRESH_MS = 5 * 60 * 1000;

const LAYERS = {
  ir: { kind: 'eum', layer: 'mumi:worldcloudmap_ir108', format: 'image/jpeg', label: 'GEO RING IR 10.8', cadence: '3 H' },
  nat: { kind: 'eum', layer: 'mumi:wideareacoverage_rgb_natural', format: 'image/jpeg', label: 'GEO RING NATURAL COLOUR', cadence: '3 H' },
  mtg: { kind: 'eum', layer: 'mtg_fd:rgb_geocolour', format: 'image/png', label: 'METEOSAT-12 (0°)', cadence: '10 MIN' },
  // `bounds` keep tile requests inside each satellite's disc. GOES-West straddles the antimeridian, so it has two.
  gw: { kind: 'gibs', layer: 'GOES-West_ABI_GeoColor', level: 7, label: 'GOES-WEST (137°W)', cadence: '10 MIN',
    bounds: [[-180, -81, -57, 81], [143, -81, 180, 81]] },
  ge: { kind: 'gibs', layer: 'GOES-East_ABI_GeoColor', level: 7, label: 'GOES-EAST (75°W)', cadence: '10 MIN',
    bounds: [[-155, -81, 5, 81]] },
};

/** Variants of the view. `stack` is drawn bottom to top; `clock` names the layers whose time is quoted. */
export const LIVE = {
  geocolour: {
    label: 'GEOCOLOUR', stack: ['ir', 'gw', 'ge', 'mtg'], clock: ['gw', 'ge', 'mtg'],
    name: 'True colour by day, infrared with city lights by night. Americas, Atlantic, Europe and Africa; infrared elsewhere.',
  },
  natural: {
    label: 'NATURAL', stack: ['nat'], clock: ['nat'],
    name: 'Daylight colour from every geostationary satellite. Ice cloud cyan, vegetation green; the night side is black.',
  },
  infrared: {
    label: 'INFRARED', stack: ['ir'], clock: ['ir'],
    name: 'Thermal infrared from every geostationary satellite. Whole globe, day and night; cold cloud tops bright.',
  },
};

let times = {};            // layer key -> ISO time of the frame on screen
let current = null;        // variant id
let timer = null;
let token = 0;

function tilesFor(key, time) {
  const def = LAYERS[key];
  if (def.kind === 'gibs') {
    // "default" always resolves to the newest complete frame; the query string only defeats stale caches.
    return [`${GIBS}/${def.layer}/default/default/GoogleMapsCompatible_Level${def.level}/{z}/{y}/{x}.png?frame=${encodeURIComponent(time || Math.floor(Date.now() / 600000))}`];
  }
  const q = `service=WMS&request=GetMap&version=1.3.0&layers=${def.layer}&styles=&format=${def.format}&transparent=true&crs=EPSG:3857&width=512&height=512`;
  return [`${EUM}?${q}&bbox={bbox-epsg-3857}${time ? `&time=${encodeURIComponent(time)}` : `&frame=${Math.floor(Date.now() / 600000)}`}`];
}

async function latestTimes() {
  try {
    const res = await getJSON('/api/geo');
    const out = {};
    for (const [key, def] of Object.entries(LAYERS)) out[key] = (def.kind === 'gibs' ? res.gibs : res.eumetview)[def.layer] || null;
    return out;
  } catch {
    return {};                                     // the imagery still loads; only the timestamps are lost
  }
}

/** Map source/layer ids for one logical layer (one per bounds box). */
const idsFor = (key) => (LAYERS[key].bounds || [null]).map((_, i) => `live-${key}${i ? `-${i}` : ''}`);

function removeLayers(map) {
  for (const key of Object.keys(LAYERS)) {
    for (const id of idsFor(key)) {
      if (map.getLayer(id)) map.removeLayer(id);
      if (map.getSource(id)) map.removeSource(id);
    }
  }
}

function addLayers(map, variant) {
  for (const key of LIVE[variant].stack) {
    const def = LAYERS[key];
    idsFor(key).forEach((id, i) => {
      const source = {
        type: 'raster', tiles: tilesFor(key, times[key]),
        tileSize: def.kind === 'gibs' ? 256 : 512, maxzoom: def.kind === 'gibs' ? def.level : 6,
        attribution: def.kind === 'gibs' ? 'NOAA / NASA GIBS' : 'EUMETSAT',
      };
      if (def.bounds) source.bounds = def.bounds[i];
      map.addSource(id, source);
      map.addLayer({ id, type: 'raster', source: id, paint: { 'raster-fade-duration': 300 } }, 'water');
    });
  }
}

/** Human summary of what is on screen, for the readout. */
export function liveStatus() {
  if (!current) return null;
  const v = LIVE[current];
  const stamps = v.clock.map((k) => times[k]).filter(Boolean).map((t) => Date.parse(t));
  return {
    variant: current, label: v.label,
    newest: stamps.length ? Math.max(...stamps) : null,
    detail: v.stack.map((k) => `${LAYERS[k].label}: ${times[k] ? `${hms(Date.parse(times[k])).slice(0, 5)}Z` : 'LATEST'} (EVERY ${LAYERS[k].cadence})`).join('\n'),
  };
}

async function refresh(map) {
  const mine = token;
  const fresh = await latestTimes();
  if (mine !== token || !current) return;
  for (const key of LIVE[current].stack) {
    if (fresh[key] && fresh[key] !== times[key]) {
      times[key] = fresh[key];
      for (const id of idsFor(key)) {
        const src = map.getSource(id);
        if (src) src.setTiles(tilesFor(key, times[key]));
      }
    }
  }
  emit('live');
}

export async function enableLive(map, variant) {
  const mine = ++token;
  current = variant;
  removeLayers(map);
  addLayers(map, variant);                         // draw immediately with whatever times we already hold
  emit('live');
  clearInterval(timer);
  timer = setInterval(() => refresh(map), REFRESH_MS);
  if (mine === token) await refresh(map);
}

export function disableLive(map) {
  token += 1;
  current = null;
  clearInterval(timer);
  timer = null;
  removeLayers(map);
}
