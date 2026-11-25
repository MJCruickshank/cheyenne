// FRAMES: draws one acquired scene over an exact Web Mercator box onto a 2D canvas, whatever
// its source. Shared by the time-lapse and the before / after share card.
//
//  Planetary Computer (Sentinel-1/2, Landsat): the tiler cuts and reprojects the area to size.
//  NISAR: the browse image (a lat/lon grid) is reprojected here, row by row.
//  Free releases (Vantor, Maxar, Planet): read straight from the provider's COGs by cog.js.

import { cropUrl } from './viz.js';
import { nisarBounds, loadImage } from './archive.js';
import { renderArea, zoomForGsd } from './cog.js';
import { isoDay } from './util.js';

export const mercY = (lat) => Math.log(Math.tan(Math.PI / 4 + (lat * Math.PI) / 360));
const latOf = (y) => (2 * Math.atan(Math.exp(y)) - Math.PI / 2) * (180 / Math.PI);

/** Credit line for a scene's data, as the provider asks for it. */
export function creditFor(rec) {
  if (rec.collection === 'sentinel-2-l2a' || rec.collection === 'sentinel-1-grd') return 'CONTAINS MODIFIED COPERNICUS SENTINEL DATA';
  if (rec.collection === 'landsat-c2-l2') return 'LANDSAT IMAGERY COURTESY OF USGS / NASA';
  if (rec.collection === 'nisar-gcov') return 'NISAR: NASA / JPL-CALTECH, ISRO, VIA ASF DAAC';
  if (rec.collection === 'opendata') {
    const who = rec.props.src === 'planet' ? 'PLANET LABS PBC' : rec.props.src === 'maxar' ? 'MAXAR TECHNOLOGIES' : 'VANTOR';
    return `IMAGERY © ${who}, CC BY-NC 4.0`;
  }
  return '';
}

/** Licence restrictions worth repeating beside a shared image. */
export const nonCommercial = (rec) => rec.collection === 'opendata';

/** A box centred on [lon, lat], `km` from the centre to the top and bottom edges, with the given width / height. */
export function boxAround(lon, lat, km, aspect) {
  const dy = km / 111.32;
  const y0 = mercY(Math.max(-84, lat - dy)), y1 = mercY(Math.min(84, lat + dy));
  const dLon = ((y1 - y0) * aspect * 180) / Math.PI / 2;
  return [lon - dLon, latOf(y0), lon + dLon, latOf(y1)];
}

/** Width of a box in km at its middle latitude. */
export function widthKm(b) {
  return (b[2] - b[0]) * 111.32 * Math.cos((((b[1] + b[3]) / 2) * Math.PI) / 180);
}

/** Scenes from `pool` taken the same UTC day as `rec` by the same platform (and pass), touching `box`: stitched into one picture. */
export function sameDay(rec, pool, box) {
  const day = isoDay(rec.time);
  const pass = (r) => (r.props['sat:orbit_state'] || r.props.flightDirection || '').toLowerCase();
  const hits = (r) => !box || !(r.bbox[0] > box[2] || r.bbox[2] < box[0] || r.bbox[1] > box[3] || r.bbox[3] < box[1]);
  const out = pool.filter((r) => r !== rec && r.kind === 'scene' && r.collection === rec.collection && r.platform === rec.platform
    && isoDay(r.time) === day && pass(r) === pass(rec) && (rec.collection !== 'opendata' || r.props.ev === rec.props.ev) && hits(r));
  return [...out, rec];
}

/**
 * Draws the part of a NISAR browse image (lat/lon grid over `bounds`) that falls in `box`
 * onto a W x H Web Mercator canvas. Longitude maps linearly, so each output row is one
 * source row stretched across; latitude is converted row by row.
 */
function drawLatLon(g, img, bounds, box, W, H) {
  const [bw, bs, be, bn] = bounds;
  const sx = (lon) => ((lon - bw) / (be - bw)) * img.naturalWidth;
  const x0 = Math.max(box[0], bw), x1 = Math.min(box[2], be);
  if (x1 <= x0) return;
  const dx0 = ((x0 - box[0]) / (box[2] - box[0])) * W, dx1 = ((x1 - box[0]) / (box[2] - box[0])) * W;
  const yTop = mercY(box[3]), yBot = mercY(box[1]);
  const rowH = (bn - bs) / img.naturalHeight;
  for (let y = 0; y < H; y++) {
    const lat = latOf(yTop + ((y + 0.5) / H) * (yBot - yTop));
    if (lat > bn || lat < bs) continue;
    const sy = Math.min(img.naturalHeight - 1, Math.floor((bn - lat) / rowH));
    g.drawImage(img, sx(x0), sy, sx(x1) - sx(x0), 1, dx0, y, dx1 - dx0, 1);
  }
}

/** Draws one scene in visualisation `preset` over `box` onto context `g` (W x H). Throws if it cannot be fetched. */
export async function drawScene(g, rec, preset, box, W, H, signal) {
  if (rec.collection === 'nisar-gcov') {
    const img = await loadImage(rec.props.browseUrl, signal);
    drawLatLon(g, img, await nisarBounds(rec, img, signal), box, W, H);
  } else if (rec.collection === 'opendata') {
    const lat = (box[1] + box[3]) / 2;
    await renderArea(g, rec.props.cogs.map((c) => ({ kind: 'cog', url: c.url, bbox: c.bbox })), box, W, H,
      zoomForGsd(rec.props.gsd || 0.5, lat), signal);
  } else {
    g.drawImage(await loadImage(cropUrl(rec.collection, rec.id, preset.q, box, W, H), signal), 0, 0, W, H);
  }
}

/** Share of a canvas holding data (non-transparent), sampled every fourth pixel. */
export function coverage(g, W, H) {
  const px = g.getImageData(0, 0, W, H).data;
  let filled = 0;
  for (let i = 3; i < px.length; i += 16) if (px[i] > 0) filled++;
  return filled / (px.length / 16);
}
