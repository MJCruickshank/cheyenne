#!/usr/bin/env python3
"""
CHEYENNE - Earth observation tracking board. Local server.

Standard library only (Python 3.9+). Serves the static front end in ./web and a
small JSON API that does the things a browser cannot do politely or at all:

  /api/status     health and cache state
  /api/tle        orbital elements for the catalogue (CelesTrak, cached on disk)
  /api/plans      ESA Sentinel-1 / Sentinel-2 acquisition plans as GeoJSON
  /api/download   stream one asset of an open scene to disk with a real filename
  /api/export     stream a rendered PNG of a scene in the chosen visualisation
  /api/firms      NASA FIRMS active-fire detections as GeoJSON (add meta=1 for counts)
  /api/geo        timestamps of the newest geostationary weather-satellite frames
  /api/intel      Telegram channel monitor: posts placed on the map (see intel.py)
  /api/ais        live ship positions from several free AIS feeds (see ais.py)
  /api/opendata   open high-resolution imagery releases over an area (see opendata.py)

Run:  python3 server.py [--port 8642] [--host 127.0.0.1]
"""

import argparse
import array
import calendar
import csv
import gzip
import heapq
import json
import math
import os
import re
import ssl
import sys
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer

import ais
import intel
import opendata

ROOT = os.path.dirname(os.path.abspath(__file__))
WEB = os.path.join(ROOT, "web")
CACHE = os.path.join(ROOT, ".cache")
USER_AGENT = "Cheyenne/1.0 (local earth-observation tracking board)"

CELESTRAK = "https://celestrak.org/NORAD/elements/gp.php?GROUP=active&FORMAT=tle"
TLE_MAX_AGE = 3 * 3600          # CelesTrak asks for no more than one pull per 2 h

PC = "https://planetarycomputer.microsoft.com/api"
PC_COLLECTIONS = {"sentinel-2-l2a", "sentinel-1-grd", "landsat-c2-l2"}

ESA = "https://sentinels.copernicus.eu"
PLAN_PAGES = {
    "sentinel-1": ESA + "/web/sentinel/copernicus/sentinel-1/acquisition-plans",
    "sentinel-2": ESA + "/web/sentinel/copernicus/sentinel-2/acquisition-plans",
}
PLAN_LINK = re.compile(
    r'href="(/documents/d/sentinel/(s[12][a-d])_mp_[a-z_]*?(\d{8}t\d{6})_(\d{8}t\d{6})[^"]*)"', re.I)
PLAN_INDEX_MAX_AGE = 6 * 3600

FIRMS = "https://firms.modaps.eosdis.nasa.gov/data/active_fire"
FIRMS_FEEDS = [          # key, directory, file prefix, sensor family, default satellite index
    ("n20", "noaa-20-viirs-c2", "J1_VIIRS_C2", "viirs", 0),
    ("n21", "noaa-21-viirs-c2", "J2_VIIRS_C2", "viirs", 1),
    ("snpp", "suomi-npp-viirs-c2", "SUOMI_VIIRS_C2", "viirs", 2),
    ("modis", "modis-c6.1", "MODIS_C6_1", "modis", 3),
]
FIRMS_SATS = {"N20": 0, "N21": 1, "N": 2, "T": 3, "TERRA": 3, "A": 4, "AQUA": 4}
FIRMS_WINDOWS = ("24h", "48h", "7d")
FIRMS_MAX_AGE = 20 * 60
FIRMS_LIMIT = 150000

EUMETVIEW = "https://view.eumetsat.int/geoserver/ows"
GIBS = "https://gibs.earthdata.nasa.gov/wmts/epsg3857/best"
GEO_EUM_LAYERS = ("mumi:worldcloudmap_ir108", "mumi:wideareacoverage_rgb_natural", "mtg_fd:rgb_geocolour")
GEO_GIBS_LAYERS = (("GOES-East_ABI_GeoColor", 7), ("GOES-West_ABI_GeoColor", 7))
GEO_MAX_AGE = 5 * 60
GEO_GIBS_MAX_AGE = 10 * 60

os.makedirs(os.path.join(CACHE, "plans"), exist_ok=True)
os.makedirs(os.path.join(CACHE, "firms"), exist_ok=True)


# --------------------------------------------------------------------------- http

def _ssl_context():
    ctx = ssl.create_default_context()
    try:                                    # some Python installs ship without a CA bundle
        if not ctx.get_ca_certs():
            import certifi                  # type: ignore
            ctx = ssl.create_default_context(cafile=certifi.where())
    except Exception:
        pass
    return ctx


SSL_CTX = _ssl_context()


def http_open(url, timeout=60):
    req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
    return urllib.request.urlopen(req, timeout=timeout, context=SSL_CTX)


def http_get(url, timeout=60):
    with http_open(url, timeout) as r:
        return r.read()


def log(*a):
    print(time.strftime("%H:%M:%SZ", time.gmtime()), *a, file=sys.stderr, flush=True)


# --------------------------------------------------------------------------- TLE

_tle_lock = threading.Lock()


def load_catalog():
    with open(os.path.join(WEB, "catalog.json"), encoding="utf-8") as f:
        return json.load(f)


def tle_payload():
    """Fetch (or reuse) the active-satellite TLE set and keep only catalogue members."""
    path = os.path.join(CACHE, "tle-active.txt")
    stale, error = False, None
    with _tle_lock:
        age = time.time() - os.path.getmtime(path) if os.path.exists(path) else None
        if age is None or age > TLE_MAX_AGE:
            try:
                raw = http_get(CELESTRAK, timeout=45).decode("ascii", "replace")
                if raw.count("\n") < 300 or not re.search(r"^1 \d{5}", raw, re.M):
                    raise ValueError("unexpected response from CelesTrak: " + raw[:80].strip())
                with open(path + ".tmp", "w") as f:
                    f.write(raw)
                os.replace(path + ".tmp", path)
                log("TLE set refreshed from CelesTrak")
            except Exception as e:           # keep flying on the old elements
                error = str(e)
                log("TLE refresh failed:", error)
                if age is None:
                    raise
                stale = True
        with open(path) as f:
            lines = [ln.rstrip() for ln in f.read().splitlines() if ln.strip()]
        fetched = os.path.getmtime(path)

    rules = [(c["id"], [re.compile(p) for p in c["match"]]) for c in load_catalog()["constellations"]]
    sats = []
    for i in range(0, len(lines) - 2, 3):
        name, l1, l2 = lines[i].strip(), lines[i + 1], lines[i + 2]
        if not (l1.startswith("1 ") and l2.startswith("2 ")):
            continue
        for cid, pats in rules:
            if any(p.search(name) for p in pats):
                sats.append({"c": cid, "name": name, "norad": int(l1[2:7]), "l1": l1, "l2": l2})
                break
    return {
        "fetchedAt": datetime.fromtimestamp(fetched, timezone.utc).isoformat().replace("+00:00", "Z"),
        "stale": stale, "error": error, "source": "CelesTrak GP (active)", "sats": sats,
    }


# --------------------------------------------------------------------------- plans

_plan_lock = threading.Lock()
_plan_index = {}        # mission -> (fetched_ts, [(sat, start_ts, end_ts, url)])
_plan_files = {}        # url -> [record]


def _stamp(s):
    return datetime.strptime(s.upper(), "%Y%m%dT%H%M%S").replace(tzinfo=timezone.utc).timestamp()


def _kml_time(s):
    s = s.strip().rstrip("Z")
    fmt = "%Y-%m-%dT%H:%M:%S.%f" if "." in s else "%Y-%m-%dT%H:%M:%S"
    return datetime.strptime(s, fmt).replace(tzinfo=timezone.utc).timestamp()


def _iso(ts):
    return datetime.fromtimestamp(ts, timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def plan_index(mission):
    """Scrape the ESA acquisition-plan page for the current KML file of each satellite."""
    cached = _plan_index.get(mission)
    if cached and time.time() - cached[0] < PLAN_INDEX_MAX_AGE:
        return cached[1]
    html = http_get(PLAN_PAGES[mission], timeout=45).decode("utf-8", "replace")
    by_sat = {}
    for href, sat, a, b in set(PLAN_LINK.findall(html)):
        by_sat.setdefault(sat.lower(), []).append((_stamp(a), _stamp(b), ESA + href))
    now, chosen = time.time(), []
    for sat, files in by_sat.items():
        files.sort(reverse=True)                        # newest publication first
        live = [f for f in files if f[1] > now]
        # The newest file supersedes older ones; walk back only until "now" is covered.
        for start, end, url in live:
            chosen.append((sat.upper(), start, end, url))
            if start <= now:
                break
    _plan_index[mission] = (time.time(), chosen)
    log("plan index for %s: %d file(s)" % (mission, len(chosen)))
    return chosen


def _unwrap(ring):
    """Make longitudes continuous so strips crossing the antimeridian stay intact."""
    out, prev = [], None
    for lon, lat in ring:
        if prev is not None:
            while lon - prev > 180:
                lon -= 360
            while lon - prev < -180:
                lon += 360
        out.append([round(lon, 5), round(lat, 5)])
        prev = lon
    return out


def parse_plan_kml(text, sat):
    records = []
    for m in re.finditer(r"<Placemark>(.*?)</Placemark>", text, re.S):
        body = m.group(1)
        t0 = re.search(r"<begin>([^<]+)</begin>", body)
        t1 = re.search(r"<end>([^<]+)</end>", body)
        cs = re.search(r"<coordinates>([^<]+)</coordinates>", body)
        if not (t0 and t1 and cs):
            continue
        ring = []
        for tok in cs.group(1).split():
            p = tok.split(",")
            if len(p) >= 2:
                ring.append((float(p[0]), float(p[1])))
        if len(ring) < 4:
            continue
        ring = _unwrap(ring)
        data = dict(re.findall(r'<Data name="([^"]+)">\s*<value>([^<]*)</value>', body))
        lons, lats = [p[0] for p in ring], [p[1] for p in ring]
        try:
            begin, end = _kml_time(t0.group(1)), _kml_time(t1.group(1))
        except ValueError:
            continue
        records.append({
            "sat": data.get("SatelliteId", sat),
            "id": "%s-%s" % (sat, data.get("DatatakeId") or data.get("ID") or int(begin)),
            "t0": begin, "t1": end,
            "mode": data.get("Mode", ""), "pol": data.get("Polarisation", ""),
            "orbit": data.get("OrbitRelative", ""), "absOrbit": data.get("OrbitAbsolute", ""),
            "ring": ring, "bbox": [min(lons), min(lats), max(lons), max(lats)],
        })
    return records


def plan_records(url, sat):
    if url in _plan_files:
        return _plan_files[url]
    name = url.rsplit("/", 1)[-1]
    path = os.path.join(CACHE, "plans", name + ".json")
    if os.path.exists(path):
        with open(path) as f:
            recs = json.load(f)
    else:
        log("downloading acquisition plan", name)
        recs = parse_plan_kml(http_get(url, timeout=120).decode("iso-8859-1", "replace"), sat)
        with open(path + ".tmp", "w") as f:
            json.dump(recs, f, separators=(",", ":"))
        os.replace(path + ".tmp", path)
    _plan_files[url] = recs
    return recs


def _pt_in_ring(x, y, ring):
    inside, j = False, len(ring) - 1
    for i in range(len(ring)):
        xi, yi = ring[i]
        xj, yj = ring[j]
        if (yi > y) != (yj > y) and x < (xj - xi) * (y - yi) / (yj - yi) + xi:
            inside = not inside
        j = i
    return inside


def _seg_hit(a, b, c, d):
    def orient(p, q, r):
        return (q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0])
    return (orient(a, b, c) > 0) != (orient(a, b, d) > 0) and (orient(c, d, a) > 0) != (orient(c, d, b) > 0)


def ring_hits_box(rec, w, s, e, n):
    """True if a (longitude-unwrapped) footprint ring intersects a lon/lat box."""
    ring = rec["ring"]
    bw, bs, be, bn = rec["bbox"]
    if bn < s or bs > n:
        return False
    for shift in (-360, 0, 360):
        W, E = w + shift, e + shift
        if be < W or bw > E:
            continue
        if any(W <= x <= E and s <= y <= n for x, y in ring):
            return True
        corners = [(W, s), (E, s), (E, n), (W, n)]
        if any(_pt_in_ring(x, y, ring) for x, y in corners):
            return True
        for i in range(len(ring) - 1):
            for k in range(4):
                if _seg_hit(ring[i], ring[i + 1], corners[k], corners[(k + 1) % 4]):
                    return True
    return False


def plans_geojson(mission, start, end, box, limit=1500):
    if mission not in PLAN_PAGES:
        raise ValueError("unknown mission")
    with _plan_lock:
        files = plan_index(mission)
        loaded = [(sat, fstart, plan_records(url, sat), url) for sat, fstart, _fend, url in files]
    # Within one satellite, a newer plan overrides the overlapping tail of an older one.
    newest = {}
    for sat, fstart, _recs, _url in loaded:
        newest[sat] = max(newest.get(sat, 0), fstart)
    feats, seen = [], set()
    for sat, fstart, recs, url in loaded:
        for r in recs:
            if r["t1"] < start or r["t0"] > end:
                continue
            if fstart < newest[sat] and r["t0"] >= newest[sat]:
                continue
            key = (r["id"], round(r["t0"]))
            if key in seen:
                continue
            if box and not ring_hits_box(r, *box):
                continue
            seen.add(key)
            feats.append({
                "type": "Feature",
                "geometry": {"type": "Polygon", "coordinates": [r["ring"]]},
                "properties": {
                    "id": r["id"], "kind": "planned", "platform": r["sat"],
                    "datetime": _iso(r["t0"]), "end": _iso(r["t1"]),
                    "mode": r["mode"], "pol": r["pol"], "relOrbit": r["orbit"], "absOrbit": r["absOrbit"],
                },
            })
    feats.sort(key=lambda f: f["properties"]["datetime"])
    return {
        "type": "FeatureCollection", "features": feats[:limit], "truncated": len(feats) > limit,
        "sources": [{"sat": sat, "file": url.rsplit("/", 1)[-1]} for sat, _s, _r, url in loaded],
    }


# --------------------------------------------------------------------------- FIRMS

_firms_lock = threading.Lock()
_firms_tables = {}      # (feed key, window) -> (file mtime, table)
_firms_queries = {}     # query key -> (meta, geojson bytes)


def _firms_table(feed, win):
    """Download (or reuse) one FIRMS near-real-time file and parse it into compact arrays."""
    key, folder, prefix, _family, default_sat = feed
    name = "%s_Global_%s.csv" % (prefix, win)
    path = os.path.join(CACHE, "firms", name)
    error = None
    age = time.time() - os.path.getmtime(path) if os.path.exists(path) else None
    if age is None or age > FIRMS_MAX_AGE:
        try:
            raw = http_get("%s/%s/csv/%s" % (FIRMS, folder, name), timeout=180)
            if not raw.startswith(b"latitude"):
                raise ValueError("unexpected response from FIRMS")
            with open(path + ".tmp", "wb") as f:
                f.write(raw)
            os.replace(path + ".tmp", path)
        except Exception as e:
            error = str(e)
            log("FIRMS refresh failed for", name, "-", error)
            if age is None:
                return {"key": key, "rows": 0, "error": error, "fetched": None}
    mtime = os.path.getmtime(path)
    cached = _firms_tables.get((key, win))
    if cached and cached[0] == mtime:
        table = dict(cached[1])
        table["error"] = error
        return table

    lon, lat, frp, bright = array.array("f"), array.array("f"), array.array("f"), array.array("f")
    when, sat, conf, night = array.array("I"), array.array("B"), array.array("B"), array.array("B")
    with open(path, newline="") as f:
        rows = csv.reader(f)
        head = {name: i for i, name in enumerate(next(rows, []))}
        try:
            i_lat, i_lon, i_date, i_time = head["latitude"], head["longitude"], head["acq_date"], head["acq_time"]
            i_frp, i_conf, i_dn = head["frp"], head["confidence"], head["daynight"]
            i_sat = head.get("satellite")
            i_bright = head.get("bright_ti4", head.get("brightness"))
        except KeyError:
            return {"key": key, "rows": 0, "error": "unrecognised FIRMS file layout", "fetched": mtime}
        day_cache = {}
        for r in rows:
            try:
                d = r[i_date]
                base = day_cache.get(d)
                if base is None:
                    base = calendar.timegm(time.strptime(d, "%Y-%m-%d")) // 60
                    day_cache[d] = base
                hhmm = r[i_time].zfill(4)
                c = r[i_conf].strip().lower()
                if c[:1] in ("l", "n", "h"):
                    level = "lnh".index(c[0])
                else:
                    level = 0 if float(c) < 30 else 1 if float(c) < 80 else 2
                lat.append(float(r[i_lat])); lon.append(float(r[i_lon]))
                frp.append(float(r[i_frp] or 0)); bright.append(float(r[i_bright] or 0) if i_bright is not None else 0)
                when.append(base + int(hhmm[:2]) * 60 + int(hhmm[2:]))
                sat.append(FIRMS_SATS.get(r[i_sat].strip().upper(), default_sat) if i_sat is not None else default_sat)
                conf.append(level); night.append(1 if r[i_dn].strip().upper() == "N" else 0)
            except (ValueError, IndexError):
                continue
    table = {"key": key, "rows": len(lat), "error": error, "fetched": mtime,
             "lon": lon, "lat": lat, "frp": frp, "bright": bright, "when": when, "sat": sat, "conf": conf, "night": night}
    _firms_tables[(key, win)] = (mtime, table)
    log("FIRMS %s: %d detections" % (name, len(lat)))
    return table


def firms_query(win, family, box, limit=FIRMS_LIMIT):
    """Return (meta, geojson_bytes) for detections in a window, sensor family and optional lon/lat box."""
    if win not in FIRMS_WINDOWS:
        raise ValueError("window must be one of " + ", ".join(FIRMS_WINDOWS))
    feeds = [f for f in FIRMS_FEEDS if family in ("all", f[3])]
    if not feeds:
        raise ValueError("unknown sensor family")
    with _firms_lock:
        with ThreadPoolExecutor(max_workers=4) as pool:
            tables = list(pool.map(lambda f: _firms_table(f, win), feeds))
        qkey = (win, family, tuple(box) if box else None, limit, tuple(t["fetched"] for t in tables))
        if qkey in _firms_queries:
            return _firms_queries[qkey]

        picked, newest = [], 0                      # (frp, table index, row index)
        for ti, t in enumerate(tables):
            if not t["rows"]:
                continue
            lon, lat, frp, when = t["lon"], t["lat"], t["frp"], t["when"]
            newest = max(newest, max(when))
            if box:
                w, s, e, n = box
                wraps = w > e
                for i in range(t["rows"]):
                    y = lat[i]
                    if y < s or y > n:
                        continue
                    x = lon[i]
                    if (x >= w or x <= e) if wraps else (w <= x <= e):
                        picked.append((frp[i], ti, i))
            else:
                picked.extend((frp[i], ti, i) for i in range(t["rows"]))
        total = len(picked)
        if total > limit:                           # keep the strongest when there are too many to draw
            picked = heapq.nlargest(limit, picked)

        parts = []
        for _f, ti, i in picked:
            t = tables[ti]
            parts.append('{"type":"Feature","geometry":{"type":"Point","coordinates":[%.4f,%.4f]},'
                         '"properties":{"f":%.1f,"t":%d,"s":%d,"c":%d,"n":%d,"b":%.0f}}'
                         % (t["lon"][i], t["lat"][i], t["frp"][i], t["when"][i], t["sat"][i], t["conf"][i], t["night"][i], t["bright"][i]))
        body = ('{"type":"FeatureCollection","features":[' + ",".join(parts) + "]}").encode()
        fetched = [t["fetched"] for t in tables if t["fetched"]]
        meta = {
            "window": win, "family": family, "total": total, "count": len(picked), "truncated": total > len(picked),
            "fetchedAt": _iso(min(fetched)) if fetched else None,
            "newest": _iso(newest * 60) if newest else None,
            "feeds": [{"key": t["key"], "rows": t["rows"], "error": t["error"]} for t in tables],
        }
        if len(_firms_queries) > 6:
            _firms_queries.clear()
        _firms_queries[qkey] = (meta, body)
        return meta, body


# --------------------------------------------------------------------------- geostationary frame times

_geo_lock = threading.Lock()
_geo_cache = {"at": 0, "data": None}
_geo_gibs = {}          # layer -> (fetched ts, time string)


def _eum_times():
    caps = http_get(EUMETVIEW + "?service=WMS&request=GetCapabilities&version=1.3.0", timeout=40).decode("utf-8", "replace")
    out = {}
    for layer in GEO_EUM_LAYERS:
        i = caps.find("<Name>%s</Name>" % layer)
        j = caps.find("</Layer>", i)
        m = re.search(r'<Dimension name="time"[^>]*default="([^"]+)"', caps[i:j]) if i >= 0 else None
        out[layer] = m.group(1) if m else None
    return out


def _gibs_time(layer, level):
    cached = _geo_gibs.get(layer)
    if cached and time.time() - cached[0] < GEO_GIBS_MAX_AGE:
        return cached[1]
    url = "%s/wmts.cgi?SERVICE=WMTS&REQUEST=DescribeDomains&VERSION=1.0.0&LAYER=%s&TILEMATRIXSET=GoogleMapsCompatible_Level%d" % (GIBS, layer, level)
    tail = http_get(url, timeout=40)[-400:].decode("ascii", "replace")
    found = re.findall(r"/(\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ)/PT", tail)
    value = found[-1] if found else None
    _geo_gibs[layer] = (time.time(), value)
    return value


def geo_times():
    """Newest available frame per geostationary layer. Any source may be None if it is unreachable."""
    with _geo_lock:
        if _geo_cache["data"] and time.time() - _geo_cache["at"] < GEO_MAX_AGE:
            return _geo_cache["data"]

        def safe(fn, *a):
            try:
                return fn(*a)
            except Exception as e:
                log("geostationary time lookup failed:", repr(e))
                return None

        with ThreadPoolExecutor(max_workers=3) as pool:
            eum = pool.submit(safe, _eum_times)
            gibs = {layer: pool.submit(safe, _gibs_time, layer, level) for layer, level in GEO_GIBS_LAYERS}
            data = {"checkedAt": _iso(time.time()), "eumetview": eum.result() or {}, "gibs": {k: v.result() for k, v in gibs.items()}}
        _geo_cache.update(at=time.time(), data=data)
        return data


# --------------------------------------------------------------------------- downloads

SAFE_ID = re.compile(r"^[A-Za-z0-9_.\-]+$")
INTEL = None            # intel.Intel, created in main()
AIS = None              # ais.AIS, created in main()
OPENDATA = None         # opendata.OpenData, created in main()


def signed_asset(collection, item, asset):
    if collection not in PC_COLLECTIONS or not SAFE_ID.match(item) or not SAFE_ID.match(asset):
        raise ValueError("bad request")
    doc = json.loads(http_get("%s/stac/v1/collections/%s/items/%s" % (PC, collection, item), 30))
    href = doc["assets"][asset]["href"]
    host = urllib.parse.urlparse(href).hostname or ""
    if not host.endswith(".blob.core.windows.net"):
        raise ValueError("asset is not hosted on open blob storage")
    signed = json.loads(http_get("%s/sas/v1/sign?href=%s" % (PC, urllib.parse.quote(href, safe="")), 30))["href"]
    ext = os.path.splitext(urllib.parse.urlparse(href).path)[1] or ".bin"
    return signed, "%s_%s%s" % (item, asset, ext)


# --------------------------------------------------------------------------- handler

class Handler(SimpleHTTPRequestHandler):
    server_version = "Cheyenne/1.0"
    protocol_version = "HTTP/1.1"

    def __init__(self, *a, **kw):
        super().__init__(*a, directory=WEB, **kw)

    def log_message(self, fmt, *args):
        if "/api/" in (args[0] if args else ""):
            log(self.address_string(), fmt % args)

    def end_headers(self):
        if not self.path.startswith("/api/"):
            self.send_header("Cache-Control", "no-cache")
        super().end_headers()

    def send_json(self, obj, status=200):
        self.send_bytes(json.dumps(obj, separators=(",", ":")).encode(), "application/json", status)

    def send_bytes(self, body, content_type, status=200):
        encoded = len(body) > 4096 and "gzip" in self.headers.get("Accept-Encoding", "")
        if encoded:
            body = gzip.compress(body, 1)
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        if encoded:
            self.send_header("Content-Encoding", "gzip")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def stream(self, url, filename, content_type=None):
        try:
            upstream = http_open(url, timeout=120)
        except urllib.error.HTTPError as e:
            return self.send_json({"error": "upstream %s" % e.code, "detail": e.read(300).decode("utf-8", "replace")}, 502)
        with upstream:
            self.send_response(200)
            self.send_header("Content-Type", content_type or upstream.headers.get("Content-Type", "application/octet-stream"))
            length = upstream.headers.get("Content-Length")
            if length:
                self.send_header("Content-Length", length)
            else:
                self.send_header("Connection", "close")
                self.close_connection = True
            self.send_header("Content-Disposition", 'attachment; filename="%s"' % filename)
            self.end_headers()
            try:
                while True:
                    chunk = upstream.read(262144)
                    if not chunk:
                        break
                    self.wfile.write(chunk)
            except (BrokenPipeError, ConnectionResetError):
                self.close_connection = True      # the user cancelled the download

    def same_site(self):
        """Refuse requests that another web page makes to this local server."""
        site = self.headers.get("Sec-Fetch-Site")
        if site and site not in ("same-origin", "none"):
            return False
        origin = self.headers.get("Origin")
        return not origin or urllib.parse.urlparse(origin).netloc == self.headers.get("Host")

    def do_POST(self):
        url = urllib.parse.urlparse(self.path)
        try:
            if url.path not in ("/api/intel", "/api/ais"):
                return self.send_json({"error": "not found"}, 404)
            if not self.same_site() or "application/json" not in self.headers.get("Content-Type", ""):
                return self.send_json({"error": "forbidden"}, 403)
            length = int(self.headers.get("Content-Length") or 0)
            if not 0 < length < 4096:
                raise ValueError("bad request")
            body = json.loads(self.rfile.read(length))
            if not isinstance(body, dict):
                raise ValueError("bad request")
            if url.path == "/api/ais":
                if body.get("action") != "stop":
                    raise ValueError("unknown action")
                AIS.stop()
                return self.send_json({"ok": True})
            return self.send_json(INTEL.command(body))
        except (ValueError, KeyError, TypeError) as e:
            return self.send_json({"error": str(e) or "bad request"}, 400)
        except Exception as e:
            log("API error on", url.path, "-", repr(e))
            return self.send_json({"error": str(e) or e.__class__.__name__}, 502)

    def do_GET(self):
        url = urllib.parse.urlparse(self.path)
        if not url.path.startswith("/api/"):
            return super().do_GET()
        q = {k: v[-1] for k, v in urllib.parse.parse_qs(url.query).items()}
        try:
            if url.path.startswith("/api/intel"):
                if not self.same_site():
                    return self.send_json({"error": "forbidden"}, 403)
                if url.path == "/api/intel/post":
                    return self.send_json(INTEL.post_text(q.get("k", "")))
                if url.path == "/api/intel/groups":
                    return self.send_json(INTEL.groups_info())
                return self.send_json(INTEL.snapshot(int(q.get("since", "0")), watching=not q.get("peek")))
            if url.path.startswith("/api/ais"):
                if not self.same_site():
                    return self.send_json({"error": "forbidden"}, 403)
                if url.path == "/api/ais/ship":
                    return self.send_json(AIS.ship(int(q.get("mmsi", "0"))))
                if url.path == "/api/ais/coverage":
                    return self.send_json(AIS.coverage())
                box = view = None
                for name in ("bbox", "view"):
                    if name in q:
                        vals = [float(v) for v in q[name].split(",")]
                        if len(vals) != 4 or not all(math.isfinite(v) for v in vals):
                            raise ValueError("%s must be west,south,east,north" % name)
                        if name == "bbox":
                            box = vals
                        else:
                            view = vals
                if q.get("meta"):
                    return self.send_json(AIS.meta(box, view))
                return self.send_bytes(AIS.geojson(box, view), "application/geo+json")
            if url.path == "/api/status":
                tle = os.path.join(CACHE, "tle-active.txt")
                return self.send_json({
                    "ok": True, "time": _iso(time.time()),
                    "tleAgeSec": round(time.time() - os.path.getmtime(tle)) if os.path.exists(tle) else None,
                })
            if url.path == "/api/tle":
                return self.send_json(tle_payload())
            if url.path == "/api/plans":
                now = time.time()
                start = float(q["start"]) if "start" in q else now
                end = float(q["end"]) if "end" in q else now + 7 * 86400
                box = None
                if "bbox" in q:
                    box = [float(v) for v in q["bbox"].split(",")]
                    if len(box) != 4 or not all(math.isfinite(v) for v in box):
                        raise ValueError("bbox must be west,south,east,north")
                elif "lon" in q and "lat" in q:
                    lon, lat = float(q["lon"]), float(q["lat"])
                    box = [lon - 0.01, lat - 0.01, lon + 0.01, lat + 0.01]
                return self.send_json(plans_geojson(q.get("mission", ""), start, end, box))
            if url.path == "/api/firms":
                box = None
                if "bbox" in q:
                    box = [float(v) for v in q["bbox"].split(",")]
                    if len(box) != 4 or not all(math.isfinite(v) for v in box):
                        raise ValueError("bbox must be west,south,east,north")
                meta, body = firms_query(q.get("win", "24h"), q.get("src", "all"), box)
                if q.get("meta"):
                    return self.send_json(meta)
                return self.send_bytes(body, "application/geo+json")
            if url.path == "/api/geo":
                return self.send_json(geo_times())
            if url.path == "/api/opendata":
                box = None
                if "bbox" in q:
                    box = [float(v) for v in q["bbox"].split(",")]
                    if len(box) != 4 or not all(math.isfinite(v) for v in box):
                        raise ValueError("bbox must be west,south,east,north")
                return self.send_json(OPENDATA.query([v for v in q.get("src", "").split(",") if v], box))
            if url.path == "/api/download":
                signed, filename = signed_asset(q.get("collection", ""), q.get("item", ""), q.get("asset", ""))
                return self.stream(signed, filename)
            if url.path == "/api/export":
                collection, item = q.get("collection", ""), q.get("item", "")
                if collection not in PC_COLLECTIONS or not SAFE_ID.match(item):
                    raise ValueError("bad request")
                size = max(256, min(4096, int(q.get("size", "2048"))))
                viz = q.get("viz", "")
                if len(viz) > 600 or not re.match(r"^[A-Za-z0-9_=&%+.,;:()*/|\-]*$", viz):
                    raise ValueError("bad visualisation")
                target = "%s/data/v1/item/preview.png?collection=%s&item=%s&%s&max_size=%d" % (PC, collection, item, viz, size)
                name = re.sub(r"[^A-Za-z0-9_\-]", "", q.get("name", "render"))[:40] or "render"
                return self.stream(target, "%s_%s.png" % (item, name), "image/png")
            return self.send_json({"error": "not found"}, 404)
        except (ValueError, KeyError) as e:
            return self.send_json({"error": str(e) or "bad request"}, 400)
        except Exception as e:                    # upstream outage, parse failure...
            log("API error on", url.path, "-", repr(e))
            return self.send_json({"error": str(e) or e.__class__.__name__}, 502)


def main():
    ap = argparse.ArgumentParser(description="Cheyenne earth-observation tracking board")
    ap.add_argument("--host", default="127.0.0.1", help="interface to bind (default: local only)")
    ap.add_argument("--port", type=int, default=8642)
    ap.add_argument("--intel-budget", type=float, default=0.65, metavar="USD",
                    help="default daily spending cap for Intel place extraction (default: 0.65)")
    args = ap.parse_args()
    global INTEL, AIS, OPENDATA
    INTEL = intel.Intel(ROOT, CACHE, http_get, log, ssl_context=SSL_CTX, daily_budget=args.intel_budget)
    AIS = ais.AIS(ROOT, log, ssl_context=SSL_CTX)
    OPENDATA = opendata.OpenData(CACHE, http_get, log)
    httpd = ThreadingHTTPServer((args.host, args.port), Handler)
    httpd.daemon_threads = True
    print("CHEYENNE tracking board  ->  http://%s:%d/   (Ctrl-C to stand down)" % (
        "localhost" if args.host in ("127.0.0.1", "0.0.0.0") else args.host, args.port), flush=True)
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\nstanding down")


if __name__ == "__main__":
    main()
