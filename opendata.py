"""
CHEYENNE - open high-resolution imagery releases.

Commercial operators publish free imagery of major disasters as static STAC catalogues. This
module walks those catalogues in the background, keeps a small index on disk and answers
"what is there over this area" for the board. The imagery itself is never downloaded here: the
browser reads the cloud-optimised GeoTIFFs directly (see web/js/cog.js).

  vantor   Vantor Open Data Program, 2025 onwards       s3://vantor-opendata   CC BY-NC 4.0
  maxar    Maxar Open Data Program archive, 2017-2025   s3://maxar-opendata    CC BY-NC 4.0
  planet   Planet Crisis Response releases              source.coop/planet     CC BY-NC 4.0

Standard library only.
"""

import json
import os
import threading
import time
import urllib.error
import urllib.parse
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime

SOURCES = {
    "vantor": {"root": "https://vantor-opendata.s3.amazonaws.com/events/catalog.json", "ttl": 6 * 3600,
               "label": "VANTOR OPEN DATA", "license": "CC BY-NC 4.0",
               "about": "https://registry.opendata.aws/vantor-open-data/"},
    "maxar": {"root": "https://maxar-opendata.s3.amazonaws.com/events/catalog.json", "ttl": 7 * 86400,
              "label": "MAXAR OPEN DATA ARCHIVE", "license": "CC BY-NC 4.0",
              "about": "https://registry.opendata.aws/maxar-open-data/"},
    "planet": {"root": "https://data.source.coop/planet/disasterdata/catalog.json", "ttl": 6 * 3600,
               "label": "PLANET CRISIS RESPONSE", "license": "CC BY-NC 4.0",
               "about": "https://source.coop/planet/disasterdata"},
}
INDEX_VERSION = 1
WORKERS = 10
MAX_SCENES = 500                       # per answer


def _ts(text):
    """STAC datetime to epoch milliseconds (or None)."""
    if not text:
        return None
    try:
        return int(datetime.fromisoformat(text.replace("Z", "+00:00").replace(" ", "T")).timestamp() * 1000)
    except ValueError:
        return None


def _box_geom(b):
    w, s, e, n = b
    return {"type": "Polygon", "coordinates": [[[w, s], [e, s], [e, n], [w, n], [w, s]]]}


def _union(boxes):
    boxes = [b for b in boxes if b and len(b) >= 4]
    if not boxes:
        return None
    return [min(b[0] for b in boxes), min(b[1] for b in boxes), max(b[2] for b in boxes), max(b[3] for b in boxes)]


def _num(v, digits=2):
    return round(v, digits) if isinstance(v, (int, float)) else None


class OpenData:
    def __init__(self, cache, http_get, log):
        self.folder = os.path.join(cache, "opendata")
        self.http_get, self.log = http_get, log
        self.lock = threading.Lock()
        self.index = {}                # source -> {"built": t, "events": [...], "scenes": [...]}
        self.state = {}                # source -> {"busy": bool, "note": str, "error": str|None}
        os.makedirs(self.folder, exist_ok=True)
        for sid in SOURCES:
            self.state[sid] = {"busy": False, "note": "", "error": None}
            path = self._path(sid)
            try:
                with open(path, encoding="utf-8") as f:
                    data = json.load(f)
                if data.get("version") == INDEX_VERSION:
                    self.index[sid] = data
            except (OSError, ValueError):
                pass

    def _path(self, sid):
        return os.path.join(self.folder, "%s.json" % sid)

    def _get(self, url):
        for attempt in range(4):
            try:
                return json.loads(self.http_get(url, timeout=45))
            except urllib.error.HTTPError as e:
                if e.code not in (429, 500, 502, 503, 504) or attempt == 3:
                    raise
            except (urllib.error.URLError, TimeoutError):
                if attempt == 3:
                    raise
            time.sleep(1.5 * 2 ** attempt)          # storage briefly throttling: back off and retry

    # ------------------------------------------------------------------ API

    def query(self, sids, box=None):
        out = {"sources": [], "events": [], "scenes": []}
        for sid in sids:
            if sid not in SOURCES:
                raise ValueError("unknown open data source %s" % sid)
            self._refresh_if_stale(sid)
            with self.lock:
                idx = self.index.get(sid)
                st = dict(self.state[sid])
            out["sources"].append({"id": sid, "label": SOURCES[sid]["label"], "license": SOURCES[sid]["license"],
                                   "about": SOURCES[sid]["about"], "ready": idx is not None, "busy": st["busy"],
                                   "note": st["note"], "error": st["error"],
                                   "built": idx["built"] if idx else None})
            if not idx:
                continue
            out["events"].extend(idx["events"])
            if box:
                w, s, e, n = box
                for sc in idx["scenes"]:
                    b = sc["bbox"]
                    if b[0] <= e and b[2] >= w and b[1] <= n and b[3] >= s:
                        out["scenes"].append(sc)
        out["events"].sort(key=lambda ev: -(ev.get("t") or 0))
        out["scenes"].sort(key=lambda sc: -(sc.get("t") or 0))
        out["truncated"] = len(out["scenes"]) > MAX_SCENES
        out["scenes"] = out["scenes"][:MAX_SCENES]
        return out

    def _refresh_if_stale(self, sid):
        with self.lock:
            idx, st = self.index.get(sid), self.state[sid]
            if st["busy"]:
                return
            if idx and time.time() - idx["built"] < SOURCES[sid]["ttl"]:
                return
            if st["error"] and time.time() - st.get("failed", 0) < 600:
                return
            st["busy"], st["note"], st["error"] = True, "INDEXING", None
        threading.Thread(target=self._build, args=(sid,), daemon=True, name="opendata-%s" % sid).start()

    # ------------------------------------------------------------------ building

    def _build(self, sid):
        t0 = time.time()
        try:
            previous = self.index.get(sid)
            events, scenes = getattr(self, "_walk_" + sid)(previous)
            data = {"version": INDEX_VERSION, "built": time.time(), "events": events, "scenes": scenes}
            tmp = self._path(sid) + ".tmp"
            with open(tmp, "w", encoding="utf-8") as f:
                json.dump(data, f, separators=(",", ":"))
            os.replace(tmp, self._path(sid))
            with self.lock:
                self.index[sid] = data
                self.state[sid].update(busy=False, note="", error=None)
            self.log("open data: %s indexed, %d events, %d scenes in %.0f s" % (sid, len(events), len(scenes), time.time() - t0))
        except Exception as e:
            with self.lock:
                self.state[sid].update(busy=False, note="", error=str(e)[:160], failed=time.time())
            self.log("open data: %s indexing failed - %r" % (sid, e))

    def _note(self, sid, text):
        with self.lock:
            self.state[sid]["note"] = text

    def _many(self, urls, sid, label):
        """Fetch JSON documents in parallel. Returns {url: doc} for the ones that loaded."""
        out, done = {}, [0]

        def one(u):
            try:
                return u, self._get(u)
            except Exception as e:
                self.log("open data: %s - %r" % (u, e))
                return u, None
        with ThreadPoolExecutor(WORKERS) as ex:
            for u, doc in ex.map(one, urls):
                done[0] += 1
                if done[0] % 25 == 0:
                    self._note(sid, "INDEXING %s %d/%d" % (label, done[0], len(urls)))
                if doc is not None:
                    out[u] = doc
        return out

    @staticmethod
    def _links(doc, base, rel):
        return [urllib.parse.urljoin(base, l["href"]) for l in doc.get("links", []) if l.get("rel") == rel and l.get("href")]

    @staticmethod
    def _event(sid, doc, url, scenes, date=None):
        box = _union([s["bbox"] for s in scenes])
        times = [s["t"] for s in scenes if s.get("t")]
        desc = " ".join((doc.get("description") or "").split())
        return {
            "id": "%s:%s" % (sid, doc.get("id")), "src": sid, "title": doc.get("title") or doc.get("id"),
            "desc": desc[:400], "t": date or (max(times) if times else None), "bbox": box, "n": len(scenes), "url": url,
        }

    # -- Vantor: catalogue -> event collections -> one item per image

    def _walk_vantor(self, previous):
        root = SOURCES["vantor"]["root"]
        cat = self._get(root)
        old = {}
        if previous:                                   # events are append-only: reuse what has not changed
            for ev in previous["events"]:
                old[ev["url"]] = (ev, [s for s in previous["scenes"] if s["ev"] == ev["id"]], ev.get("sig"))
        events, scenes = [], []
        for url in self._links(cat, root, "child"):
            coll = self._get(url)
            items = self._links(coll, url, "item")
            sig = "%d:%s" % (len(items), items[-1] if items else "")
            if url in old and old[url][2] == sig:
                events.append(old[url][0]); scenes.extend(old[url][1])
                continue
            ev_id = "vantor:%s" % coll.get("id")
            docs = self._many(items, "vantor", coll.get("id", "")[:24].upper())
            mine = []
            for u in items:
                it = docs.get(u)
                if not it or not it.get("bbox") or "visual" not in it.get("assets", {}):
                    continue
                p = it.get("properties", {})
                a = it["assets"]
                mine.append({
                    "id": "vantor:%s" % it["id"], "src": "vantor", "ev": ev_id, "t": _ts(p.get("datetime")),
                    "title": p.get("title") or it["id"], "plat": p.get("vehicle_name") or p.get("platform") or "VANTOR",
                    "gsd": _num(p.get("pan_gsd") or p.get("gsd")), "cloud": _num(p.get("eo:cloud_cover"), 0),
                    "offNadir": _num(p.get("view:off_nadir"), 1), "sunEl": _num(p.get("view:sun_elevation"), 1),
                    "phase": p.get("phase"), "bbox": it["bbox"], "geom": it.get("geometry") or _box_geom(it["bbox"]),
                    "thumb": urllib.parse.urljoin(u, a["thumbnail"]["href"]) if "thumbnail" in a else None,
                    "item": u, "cogs": [{"url": urllib.parse.urljoin(u, a["visual"]["href"]), "bbox": it["bbox"]}],
                })
            ev = self._event("vantor", coll, url, mine, _ts(coll.get("odp:event_date")))
            ev["sig"] = sig
            events.append(ev); scenes.extend(mine)
        return events, scenes

    # -- Maxar archive: catalogue -> event collections -> acquisition collections -> tile items

    def _walk_maxar(self, previous):
        root = SOURCES["maxar"]["root"]
        cat = self._get(root)
        ev_urls = self._links(cat, root, "child")
        self._note("maxar", "INDEXING %d EVENTS" % len(ev_urls))
        ev_docs = self._many(ev_urls, "maxar", "EVENTS")
        acq_urls = []
        for u in ev_urls:
            if u in ev_docs:
                acq_urls.extend(self._links(ev_docs[u], u, "child"))
        acq_docs = self._many(acq_urls, "maxar", "ACQUISITIONS")
        # One tile per acquisition supplies the sensor details shared by all its tiles.
        firsts = {}
        for u, d in acq_docs.items():
            items = self._links(d, u, "item")
            if items:
                firsts[u] = items[0]
        first_docs = self._many(list(firsts.values()), "maxar", "SENSORS")
        events, scenes = [], []
        for eu in ev_urls:
            ed = ev_docs.get(eu)
            if not ed:
                continue
            ev_id = "maxar:%s" % ed.get("id")
            mine = []
            for au in self._links(ed, eu, "child"):
                ad = acq_docs.get(au)
                if not ad:
                    continue
                items = self._links(ad, au, "item")
                # Per-tile extents follow the item order; newer collections put the overall extent first.
                boxes = (ad.get("extent", {}).get("spatial", {}).get("bbox") or [])
                tile_boxes = boxes[1:] if len(boxes) == len(items) + 1 else boxes if len(boxes) == len(items) else []
                if not items or not tile_boxes:
                    continue
                first = first_docs.get(firsts.get(au), {}) or {}
                p = first.get("properties", {})
                visual = (first.get("assets", {}).get("visual") or {}).get("href")
                if not visual:
                    continue
                suffix = visual.rsplit("/", 1)[-1].split(".json")[0]
                stem = os.path.basename(urllib.parse.urlparse(firsts[au]).path)[:-5]
                tail = suffix[len(stem):] if suffix.startswith(stem) else "-visual.tif"
                cogs = [{"url": it[:-5] + tail, "bbox": b} for it, b in zip(items, tile_boxes)]
                interval = (ad.get("extent", {}).get("temporal", {}).get("interval") or [[None]])[0]
                box = _union(tile_boxes)
                geom = ({"type": "MultiPolygon", "coordinates": [_box_geom(b)["coordinates"] for b in tile_boxes]}
                        if len(tile_boxes) <= 400 else _box_geom(box))
                mine.append({
                    "id": "maxar:%s:%s" % (ed.get("id"), ad.get("id")), "src": "maxar", "ev": ev_id,
                    "t": _ts(p.get("datetime") or interval[0]), "title": "%s %s" % (p.get("platform") or "MAXAR", ad.get("id")),
                    "plat": p.get("platform") or "MAXAR", "gsd": _num(p.get("gsd")), "cloud": None,
                    "offNadir": _num(p.get("view:off_nadir"), 1), "sunEl": _num(p.get("view:sun_elevation"), 1),
                    "phase": None, "bbox": box, "geom": geom, "thumb": None, "item": au, "cogs": cogs,
                })
            if mine:
                events.append(self._event("maxar", ed, eu, mine))
                scenes.extend(mine)
        return events, scenes

    # -- Planet: catalogue -> event catalogues -> phase catalogues -> collections -> items

    def _walk_planet(self, previous):
        root = SOURCES["planet"]["root"]
        cat = self._get(root)
        events, scenes = [], []
        for eu in self._links(cat, root, "child"):
            ed = self._get(eu)
            ev_id = "planet:%s" % ed.get("id")
            items, frontier = [], [(eu, ed, None)]
            while frontier:                            # walk catalogues and collections down to items
                u, d, phase = frontier.pop()
                did = (d.get("id") or "").lower()
                if did in ("pre-event", "post-event"):
                    phase = did[:-6]
                for iu in self._links(d, u, "item"):
                    items.append((iu, phase))
                kids = self._links(d, u, "child")
                for cu, cd in self._many(kids, "planet", (ed.get("id") or "")[:24].upper()).items():
                    frontier.append((cu, cd, phase))
            docs = self._many([iu for iu, _ in items], "planet", (ed.get("id") or "")[:24].upper())
            mine = []
            for iu, phase in items:
                it = docs.get(iu)
                if not it or not it.get("bbox") or "visual" not in it.get("assets", {}):
                    continue
                p = it.get("properties", {})
                a = it["assets"]
                kind = p.get("pl:item_type") or ""
                plat = {"PSScene": "PLANETSCOPE", "SkySatCollect": "SKYSAT", "SkySatScene": "SKYSAT",
                        "PelicanScene": "PELICAN"}.get(kind, (p.get("constellation") or "PLANET").upper())
                mine.append({
                    "id": "planet:%s" % it["id"], "src": "planet", "ev": ev_id, "t": _ts(p.get("datetime")),
                    "title": it["id"], "plat": plat, "gsd": _num(p.get("gsd")), "cloud": _num(p.get("eo:cloud_cover"), 0),
                    "offNadir": _num(p.get("view:off_nadir"), 1), "sunEl": _num(p.get("view:sun_elevation"), 1),
                    "phase": phase, "bbox": it["bbox"], "geom": it.get("geometry") or _box_geom(it["bbox"]),
                    "thumb": urllib.parse.urljoin(iu, a["thumbnail"]["href"]) if "thumbnail" in a else None,
                    "item": iu, "cogs": [{"url": urllib.parse.urljoin(iu, a["visual"]["href"]), "bbox": it["bbox"]}],
                })
            if mine:
                events.append(self._event("planet", ed, eu, mine))
                scenes.extend(mine)
        return events, scenes
