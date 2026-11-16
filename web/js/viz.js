// Visualisation presets per data type, expressed as dynamic-tiler query strings.
// Tiles are rendered server-side by the Planetary Computer data API from the
// cloud-optimised GeoTIFFs, so the browser only ever decodes small PNGs.

export const PC = 'https://planetarycomputer.microsoft.com/api';

const qs = (pairs) => new URLSearchParams(pairs).toString();
const assets = (...names) => names.map((n) => ['assets', n]);
const rgb = (bands, formula) => qs([...assets(...bands), ['nodata', '0'], ['color_formula', formula]]);
const index = (bands, expr, rescale, cmap) => qs([
  ...assets(...bands), ['expression', expr], ['asset_as_band', 'true'], ['rescale', rescale], ['colormap_name', cmap], ['nodata', '0'],
]);

const S2_STRETCH = 'Gamma RGB 3.7 Saturation 1.5 Sigmoidal RGB 15 0.35';
const LS_STRETCH = 'gamma RGB 2.7, saturation 1.5, sigmoidal RGB 15 0.55';

function sentinel2(props) {
  // Baseline 04.00+ stores reflectance with a +1000 offset; remove it from band-ratio denominators.
  const off = parseFloat(props['s2:processing_baseline'] || '0') >= 4 ? 2000 : 0;
  const nd = (a, b) => `(${a}-${b})/(${a}+${b}${off ? `-${off}` : ''})`;
  return [
    { id: 'tci', label: 'TRUE COLOUR', hint: 'Natural colour at 10 m. Fastest to draw: one pre-rendered asset.',
      q: qs([['assets', 'visual'], ['asset_bidx', 'visual|1,2,3'], ['nodata', '0']]) },
    { id: 'tce', label: 'TRUE COLOUR / ENHANCED', hint: 'Contrast-stretched B4-B3-B2. Lifts dark, hazy or low-sun scenes.',
      q: rgb(['B04', 'B03', 'B02'], 'Gamma RGB 3.2 Saturation 0.8 Sigmoidal RGB 25 0.35') },
    { id: 'cir', label: 'FALSE COLOUR INFRARED', hint: 'B8-B4-B3. Vegetation red; cleared ground, earthworks and water stand out.',
      q: rgb(['B08', 'B04', 'B03'], S2_STRETCH) },
    { id: 'swir', label: 'SHORTWAVE INFRARED', hint: 'B12-B8A-B4. Sees through smoke and thin haze; active fire glows, burn scars dark red.',
      q: rgb(['B12', 'B8A', 'B04'], S2_STRETCH) },
    { id: 'urban', label: 'URBAN / BARE GROUND', hint: 'B12-B11-B4. Built-up areas, fresh excavation, fortification lines.',
      q: rgb(['B12', 'B11', 'B04'], S2_STRETCH) },
    { id: 'agri', label: 'AGRICULTURE', hint: 'B11-B8-B2. Crop vigour, harvest state and field boundaries.',
      q: rgb(['B11', 'B08', 'B02'], S2_STRETCH) },
    { id: 'ndvi', label: 'NDVI VEGETATION INDEX', hint: 'Vegetation density. Green dense, red bare: crop loss, clearance, scorched areas.',
      q: index(['B08', 'B04'], nd('B08', 'B04'), '-0.2,0.9', 'rdylgn') },
    { id: 'nbr', label: 'NBR BURN RATIO', hint: 'Burn severity from NIR and SWIR. Red marks burned or scorched ground.',
      q: index(['B08', 'B12'], nd('B08', 'B12'), '-0.5,0.8', 'rdylgn') },
    { id: 'ndwi', label: 'NDWI WATER INDEX', hint: 'Open water and flood extent in deep blue.',
      q: index(['B03', 'B08'], nd('B03', 'B08'), '-0.4,0.5', 'blues') },
    { id: 'ndmi', label: 'MOISTURE INDEX', hint: 'Canopy and soil moisture. Brown dry, teal wet: drought stress, irrigation, saturated ground.',
      q: index(['B8A', 'B11'], nd('B8A', 'B11'), '-0.5,0.6', 'brbg') },
  ];
}

function sentinel1(props) {
  const pols = (props['sar:polarizations'] || ['VV']).map((p) => p.toLowerCase());
  const co = pols.includes('vv') ? 'vv' : pols.includes('hh') ? 'hh' : pols[0];
  const cross = pols.includes('vh') ? 'vh' : pols.includes('hv') ? 'hv' : null;
  const db = (band, range) => qs([['assets', band], ['expression', `20*log10(${band})`], ['asset_as_band', 'true'], ['rescale', range], ['nodata', '0']]);
  const out = [
    { id: 'co-db', label: `${co.toUpperCase()} BACKSCATTER (DB)`, hint: 'Log-scaled radar amplitude. Buildings, vehicles and metal bright; calm water and smooth ground dark.',
      q: db(co, '32,56') },
  ];
  if (cross) {
    out.push(
      { id: 'dual', label: 'DUAL-POL COMPOSITE', hint: `R ${co.toUpperCase()}, G ${cross.toUpperCase()}, B ratio. Urban pink-white, vegetation green, water dark blue.`,
        q: qs([...assets(co, cross), ['expression', `${co};${cross};${co}/${cross}`], ['asset_as_band', 'true'], ['rescale', '0,600'], ['rescale', '0,270'], ['rescale', '0,9'], ['nodata', '0']]) },
      { id: 'cross-db', label: `${cross.toUpperCase()} BACKSCATTER (DB)`, hint: 'Cross-polarised return. Volume scatterers: vegetation, rubble, rough debris.',
        q: db(cross, '26,48') },
    );
  }
  out.push(
    { id: 'water', label: 'WATER / FLOOD', hint: 'Low backscatter in bright blue: open water and inundation. Wind-roughened water can be missed.',
      q: qs([['assets', co], ['rescale', '0,220'], ['colormap_name', 'blues_r'], ['nodata', '0']]) },
    { id: 'strong', label: 'STRONG REFLECTORS', hint: 'Linear amplitude. Suppresses terrain so ships, pylons and dense urban cores stand out.',
      q: qs([['assets', co], ['rescale', '150,1500'], ['colormap_name', 'inferno'], ['nodata', '0']]) },
  );
  return out;
}

function landsat() {
  // Level-2 surface reflectance: DN * 0.0000275 - 0.2, so ratios need the offset removed.
  const nd = (a, b) => `(${a}-${b})/(${a}+${b}-14545)`;
  return [
    { id: 'tc', label: 'TRUE COLOUR', hint: 'Natural colour at 30 m.', q: rgb(['red', 'green', 'blue'], LS_STRETCH) },
    { id: 'cir', label: 'FALSE COLOUR INFRARED', hint: 'NIR-red-green. Vegetation red; cleared ground and water stand out.', q: rgb(['nir08', 'red', 'green'], LS_STRETCH) },
    { id: 'swir', label: 'SHORTWAVE INFRARED', hint: 'SWIR2-NIR-red. Sees through smoke; active fire glows, burn scars dark red.', q: rgb(['swir22', 'nir08', 'red'], LS_STRETCH) },
    { id: 'ndvi', label: 'NDVI VEGETATION INDEX', hint: 'Vegetation density. Green dense, red bare.', q: index(['nir08', 'red'], nd('nir08', 'red'), '-0.2,0.9', 'rdylgn') },
    { id: 'nbr', label: 'NBR BURN RATIO', hint: 'Burn severity. Red marks burned or scorched ground.', q: index(['nir08', 'swir22'], nd('nir08', 'swir22'), '-0.5,0.8', 'rdylgn') },
    // Surface temperature in kelvin = DN * 0.00341802 + 149
    { id: 'thermal', label: 'THERMAL (SURFACE TEMP)', hint: 'Band 10 scaled 250-330 K for any season. Industrial heat, power plants, warm outfalls, cold cloud tops.',
      q: qs([['assets', 'lwir11'], ['rescale', '29500,53000'], ['colormap_name', 'inferno'], ['nodata', '0']]) },
    { id: 'hot', label: 'THERMAL / HOT TARGETS', hint: 'Band 10 scaled 300-360 K. Isolates fires, flares, furnaces and sun-baked surfaces.',
      q: qs([['assets', 'lwir11'], ['rescale', '44200,61700'], ['colormap_name', 'hot'], ['nodata', '0']]) },
  ];
}

export function presetsFor(collection, props = {}) {
  if (collection === 'sentinel-2-l2a') return sentinel2(props);
  if (collection === 'sentinel-1-grd') return sentinel1(props);
  if (collection === 'landsat-c2-l2') return landsat();
  return [];
}

export const QUALITY = {
  draft: { label: 'DRAFT', scale: 1, tileSize: 512, hint: 'Half resolution, quarter of the data' },
  std: { label: 'STANDARD', scale: 2, tileSize: 512, hint: 'One image pixel per screen pixel' },
  sharp: { label: 'SHARP', scale: 2, tileSize: 256, hint: 'Full detail for high-density displays, 4x the tiles' },
};

export function tileTemplate(collection, item, q, quality = 'std') {
  const { scale } = QUALITY[quality];
  return `${PC}/data/v1/item/tiles/WebMercatorQuad/{z}/{x}/{y}@${scale}x?collection=${collection}&item=${encodeURIComponent(item)}&${q}&format=png`;
}

export function quicklookUrl(collection, item, q, size = 384) {
  return `${PC}/data/v1/item/preview.png?collection=${collection}&item=${encodeURIComponent(item)}&${q}&max_size=${size}`;
}

export function exportUrl(collection, item, q, name, size = 2048) {
  return `/api/export?collection=${collection}&item=${encodeURIComponent(item)}&viz=${encodeURIComponent(q)}&name=${name}&size=${size}`;
}

export function downloadUrl(collection, item, asset) {
  return `/api/download?collection=${collection}&item=${encodeURIComponent(item)}&asset=${encodeURIComponent(asset)}`;
}

export function gibsTemplate(layer, date) {
  return `https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/${layer.layer}/default/${date}/GoogleMapsCompatible_Level${layer.level}/{z}/{y}/{x}.${layer.ext}`;
}

/** Which assets are worth offering first, per collection. */
export function primaryAssets(collection, itemAssets) {
  const want = {
    'sentinel-2-l2a': ['visual', 'B04', 'B03', 'B02', 'B08', 'B11', 'B12', 'SCL'],
    'sentinel-1-grd': ['vv', 'vh', 'hh', 'hv'],
    'landsat-c2-l2': ['red', 'green', 'blue', 'nir08', 'swir16', 'swir22', 'lwir11', 'qa_pixel'],
  }[collection] || [];
  const skip = new Set(['tilejson', 'rendered_preview', 'thumbnail']);
  const all = Object.keys(itemAssets).filter((k) => !skip.has(k));
  const primary = want.filter((k) => k in itemAssets);
  return { primary, rest: all.filter((k) => !primary.includes(k)) };
}
