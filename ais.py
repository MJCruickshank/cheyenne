"""
CHEYENNE - AIS: live ship positions from several free feeds, merged into one picture.

Sources (each runs only while a browser has the AIS layer switched on):

  aisstream    aisstream.io WebSocket, whole globe. Needs a free key in AISSTREAM_API_KEY.
  fintraffic   Fintraffic's Digitraffic REST API, Finnish waters. No key. Polled once a minute.
  openwaters   Open Waters AIS WebSocket (Norway's BarentsWatch feed, volunteers, aisstream).
               Works without a token; OPENWATERS_TOKEN raises its limits. It cannot take the
               whole globe, so it follows the board's view, trimmed to its area allowance.
  pelyr        Pelyr OPEN-AIS WebSocket. Needs a key in PELYR_API_KEY. Also follows the view.

All sources feed one store: each ship's latest report (an older report never overwrites a newer
one), a six-hour track, and a count of reports per 0.5 degree cell for the coverage map, saved to
data/ais-coverage.json. The WebSocket sources need the `websockets` package.
"""

import array
import calendar
import gzip
import json
import math
import os
import random
import threading
import time
import urllib.parse
import urllib.request

AGENT = "Cheyenne/1.0 (open-source earth-observation tracking board)"
CLIENT_TTL = 120                 # stop this long after the last browser request
SHOW_FOR = 3600                  # ships not heard from for this long are left off the map
FORGET_AFTER = 24 * 3600         # and dropped from memory after this long
TRACK_SECONDS = 6 * 3600
TRACK_GAP = 180                  # at most one track point per ship per this many seconds...
TRACK_MOVE_DEG = 0.0015          # ...unless it has moved roughly this far (about 150 m)
CELL = 0.5                       # coverage grid, degrees
MAX_FEATURES = 40000
SAVE_EVERY = 300

CATEGORIES = ["cargo", "tanker", "passenger", "fishing", "military", "service", "leisure", "other"]
POSITION_KINDS = ("PositionReport", "StandardClassBPositionReport", "ExtendedClassBPositionReport")
AISSTREAM_KINDS = list(POSITION_KINDS) + ["ShipStaticData", "StaticDataReport"]


def category(ship_type, nav_status):
    t = ship_type or 0
    if 70 <= t <= 79:
        return 0
    if 80 <= t <= 89:
        return 1
    if 60 <= t <= 69 or 40 <= t <= 49:
        return 2
    if t == 30 or (not t and nav_status == 7):
        return 3
    if t in (35, 55):
        return 4
    if 31 <= t <= 34 or 50 <= t <= 59:
        return 5
    if t in (36, 37) or (not t and nav_status == 8):
        return 6
    return 7


def _clean(text):
    return (text or "").replace("@", " ").strip()


def _num(v, below):
    return v if isinstance(v, (int, float)) and not isinstance(v, bool) and v < below else None


def _iso_ts(s, default):
    """'2026-11-17T13:50:12.51Z' (or with a space) to epoch seconds."""
    try:
        base = calendar.timegm(time.strptime(s[:19].replace(" ", "T"), "%Y-%m-%dT%H:%M:%S"))
        frac = s[19:20] == "." and float("0." + "".join(c for c in s[20:29] if c.isdigit()) or 0) or 0
        return base + frac
    except (TypeError, ValueError):
        return default


def capped_box(view, max_sq_deg=None, max_km2=None):
    """Trim a (west, south, east, north) view around its centre to fit an area allowance."""
    w, s, e, n = view
    if e < w:
        e += 360
    s, n = max(-85.0, s), min(85.0, n)
    cx, cy = (w + e) / 2, (s + n) / 2
    hw, hh = (e - w) / 2, (n - s) / 2
    if max_sq_deg:
        area, cap = (2 * hw) * (2 * hh), max_sq_deg * 0.96
    else:
        area, cap = (2 * hw) * (2 * hh) * 111.32 ** 2 * max(0.05, math.cos(math.radians(cy))), max_km2 * 0.96
    trimmed = area > cap
    if trimmed:
        f = math.sqrt(cap / area)
        hw, hh = hw * f, hh * f
    q = lambda v: round(v * 4) / 4                    # quarter degrees, so small pans do not resubscribe
    w, e = q(cx - hw), q(cx + hw)
    s, n = max(-85.0, q(cy - hh)), min(85.0, q(cy + hh))
    if e - w < 0.25:
        e = w + 0.25
    if n - s < 0.25:
        n = s + 0.25
    boxes = [(w, s, e, n)]
    if w < -180:
        boxes = [(-180.0, s, e, n), (w + 360, s, 180.0, n)]
    elif e > 180:
        boxes = [(w, s, 180.0, n), (-180.0, s, e - 360, n)]
    return boxes, trimmed


# --------------------------------------------------------------------------- sources

class Source:
    id = label = ""
    follows_view = False

    def __init__(self, store):
        self.store = store
        self.status, self.error, self.note = "STANDBY", None, None
        self.rate, self._count, self._count_t = 0.0, 0, time.time()
        self.attribution = set()

    def counted(self, n=1):
        self._count += n
        now = time.time()
        if now - self._count_t >= 15:
            self.rate = self._count / (now - self._count_t)
            self._count, self._count_t = 0, now

    def describe(self):
        return {"id": self.id, "label": self.label, "status": self.status, "error": self.error,
                "rate": round(self.rate, 1), "note": self.note, "view": self.follows_view}

    def start(self):
        threading.Thread(target=self._loop, daemon=True, name="ais-" + self.id).start()

    def _loop(self):
        backoff = 5
        while True:
            if not self.store.active():
                self.status, self.error, self.note, self.rate = "STANDBY", None, None, 0.0
                time.sleep(1)
                continue
            try:
                wait = self.run()
                backoff = 5
            except _Final as e:
                self.status, self.error, self.rate = "STOPPED", str(e), 0.0
                self.store.log("ais/%s: stopped -" % self.id, str(e))
                wait = 3600
            except Exception as e:
                msg = str(e) or e.__class__.__name__
                if not self.error:
                    self.error = msg[:140].upper()
                self.status, self.rate = "RETRYING", 0.0
                self.store.log("ais/%s: %s" % (self.id, msg[:200]))
                wait, backoff = backoff + random.random() * 5, min(300, backoff * 2)
            end = time.time() + (wait or 0)
            while time.time() < end and self.store.active():
                time.sleep(1)


class _Final(Exception):
    """A problem that retrying will not fix (no key, key refused)."""


def _connect(url, **kw):
    try:
        from websockets.sync.client import connect
    except ImportError:
        raise _Final("WEBSOCKETS LIBRARY NOT INSTALLED (SEE README)")
    return connect(url, open_timeout=20, close_timeout=3, max_size=2 ** 22, **kw)


def _close_code(e):
    rcvd = getattr(e, "rcvd", None)
    return getattr(rcvd, "code", None)


class AisStream(Source):
    id, label = "aisstream", "AISSTREAM"

    def run(self):
        key = os.environ.get("AISSTREAM_API_KEY", "").strip()
        if not key:
            raise _Final("NO KEY: SET AISSTREAM_API_KEY AND RESTART THE SERVER")
        self.status, self.error = "CONNECTING", None
        with _connect("wss://stream.aisstream.io/v0/stream") as ws:
            ws.send(json.dumps({"APIKey": key, "BoundingBoxes": [[[-90, -180], [90, 180]]], "FilterMessageTypes": AISSTREAM_KINDS}))
            quiet = time.time()
            while self.store.active():
                try:
                    raw = ws.recv(timeout=5)
                except TimeoutError:
                    if time.time() - quiet > 90:
                        raise ConnectionError("no data for 90 s")
                    continue
                quiet = time.time()
                msg = json.loads(raw)
                if "error" in msg:
                    text = str(msg["error"]).upper()[:120]
                    if "KEY" in text:
                        raise _Final("AISSTREAM REFUSED THE KEY: " + text)
                    raise ConnectionError(text)
                kind = msg.get("MessageType")
                if kind not in AISSTREAM_KINDS:
                    continue
                if self.status != "RECEIVING":
                    self.status, self.error = "RECEIVING", None
                meta = msg.get("MetaData") or {}
                self.store.ingest_decoded(self.id, None, kind, (msg.get("Message") or {}).get(kind) or {},
                                          meta.get("MMSI"), _clean(meta.get("ShipName")), time.time())
                self.counted()
        return 0


class Fintraffic(Source):
    id, label = "fintraffic", "FINTRAFFIC"
    BASE = "https://meri.digitraffic.fi/api/ais/v1/"

    def __init__(self, store):
        super().__init__(store)
        self.attribution.add("Source: Fintraffic / digitraffic.fi, license CC 4.0 BY")
        self.last_pos = self.last_meta = 0
        self.meta_due = 0

    def _get(self, path, since_ms):
        url = self.BASE + path + ("?from=%d" % since_ms if since_ms else "")
        req = urllib.request.Request(url, headers={"Digitraffic-User": AGENT, "Accept-Encoding": "gzip", "User-Agent": AGENT})
        with urllib.request.urlopen(req, timeout=40, context=self.store.ssl_context) as r:
            body = r.read()
            if r.headers.get("Content-Encoding") == "gzip":
                body = gzip.decompress(body)
        return json.loads(body)

    def run(self):
        self.status = "POLLING" if self.status != "RECEIVING" else self.status
        now_ms = int(time.time() * 1000)
        if time.time() >= self.meta_due:
            ships = self._get("vessels", self.last_meta - 120000 if self.last_meta else 0)
            for v in ships:
                eta = v.get("eta")
                self.store.ingest_static(self.id, v.get("mmsi"), {
                    "name": _clean(v.get("name")), "call": _clean(v.get("callSign")), "dest": _clean(v.get("destination")),
                    "type": v.get("shipType") or None, "imo": v.get("imo") or None,
                    "draught": (v["draught"] / 10) if v.get("draught") else None,
                    "eta": {"Month": (eta >> 16) & 15, "Day": (eta >> 11) & 31, "Hour": (eta >> 6) & 31, "Minute": eta & 63} if eta else None,
                    "length": (v.get("referencePointA") or 0) + (v.get("referencePointB") or 0) or None,
                    "beam": (v.get("referencePointC") or 0) + (v.get("referencePointD") or 0) or None,
                })
            self.last_meta, self.meta_due = now_ms, time.time() + 600
        fc = self._get("locations", self.last_pos - 120000 if self.last_pos else 0)
        n = 0
        for f in fc.get("features", []):
            p, (lon, lat) = f.get("properties") or {}, (f.get("geometry") or {}).get("coordinates") or (None, None)
            t = (p.get("timestampExternal") or now_ms) / 1000
            if self.store.ingest_position(self.id, None, p.get("mmsi"), lat, lon, _num(p.get("sog"), 102.2), _num(p.get("cog"), 360),
                                          _num(p.get("heading"), 360), p.get("navStat"), None, t):
                n += 1
        self.last_pos = now_ms
        self.rate = n / 60
        self.status, self.error = "RECEIVING", None
        self.note = "FINNISH WATERS, EVERY MINUTE"
        return 60


class _ViewSource(Source):
    """A WebSocket source that cannot take the whole globe and so follows the board's view."""
    follows_view = True


class OpenWaters(_ViewSource):
    id, label = "openwaters", "OPEN WATERS"
    URL = "wss://ais.openwaters.io/v1/stream"

    def run(self):
        token = os.environ.get("OPENWATERS_TOKEN", "").strip()
        headers = {"Authorization": "Bearer " + token} if token else None
        self.status, self.error = "CONNECTING", None
        area = 100
        with _connect(self.URL, user_agent_header=AGENT, additional_headers=headers) as ws:
            sent, sent_at, quiet = None, 0, time.time()
            while self.store.active():
                view = self.store.view
                if view and time.time() - sent_at > 3:
                    boxes, trimmed = capped_box(view, max_sq_deg=area)
                    if boxes != sent:
                        ws.send(json.dumps({"type": "subscribe", "bbox": [[s, w, n, e] for w, s, e, n in boxes]}))
                        sent, sent_at = boxes, time.time()
                        self.note = ("CENTRE OF VIEW ONLY: ZOOM IN FOR ALL OF IT" if trimmed else "FOLLOWING THE VIEW")
                try:
                    raw = ws.recv(timeout=2)
                except TimeoutError:
                    if sent and time.time() - quiet > 600:
                        raise ConnectionError("no data for 10 min")
                    continue
                quiet = time.time()
                msg = json.loads(raw)
                kind = msg.get("type")
                if kind == "welcome":
                    limits = msg.get("limits") or {}
                    area = limits.get("area") or 100
                    self.status = "RECEIVING"
                    self.role = msg.get("role")
                    continue
                if kind == "error":
                    text = str(msg.get("error", "")).upper()[:140]
                    if "TOKEN" in text or "KEY" in text:
                        raise _Final("OPEN WATERS REFUSED THE TOKEN: " + text)
                    self.error = text
                    continue
                if kind != "event":
                    continue
                mt = msg.get("msg_type")
                if mt not in AISSTREAM_KINDS:
                    continue
                if msg.get("attribution"):
                    self.attribution.add(msg["attribution"])
                body = msg.get("message") or {}
                if mt in POSITION_KINDS and isinstance(msg.get("lat"), (int, float)):
                    body = dict(body, Latitude=msg["lat"], Longitude=msg["lon"])
                self.store.ingest_decoded(self.id, msg.get("source"), mt, body, msg.get("mmsi"), "",
                                          _iso_ts(msg.get("time"), time.time()))
                self.counted()
        return 0


class Pelyr(_ViewSource):
    id, label = "pelyr", "PELYR"
    URL = "wss://stream.pelyr.com/v1/stream"
    FREE_KM2 = 3_500_000
    FINAL_CODES = {4002, 4010, 4011}

    def __init__(self, store):
        super().__init__(store)
        self.attribution.add("AIS data from Pelyr (pelyr.com), Pelyr Data Licence 2.0")

    def run(self):
        key = os.environ.get("PELYR_API_KEY", "").strip()
        if not key:
            raise _Final("NO KEY: SET PELYR_API_KEY AND RESTART THE SERVER")
        if not self.store.view:
            self.status = "WAITING FOR VIEW"
            return 3
        self.status, self.error = "CONNECTING", None
        try:
            with _connect(self.URL, additional_headers={"Authorization": "Bearer " + key}, compression=None) as ws:
                return self._session(ws)
        except Exception as e:
            code = _close_code(e)
            if code in self.FINAL_CODES:
                raise _Final("PELYR CLOSED THE CONNECTION (CODE %s): CHECK THE KEY AND ITS STREAM CAPABILITY" % code)
            if "401" in str(e) or "403" in str(e):
                raise _Final("PELYR REFUSED THE KEY (%s)" % str(e)[-40:].upper())
            if code == 4012:
                return 5 + random.random() * 25
            raise

    def _session(self, ws):
        welcome = json.loads(ws.recv(timeout=10))
        for src in welcome.get("sources") or []:
            if src.get("attribution"):
                self.attribution.add(src["attribution"])
        sent, sent_at, quiet = None, 0, time.time()
        while self.store.active():
            view = self.store.view
            if view and time.time() - sent_at > 6:
                boxes, trimmed = capped_box(view, max_km2=self.FREE_KM2)
                if boxes != sent:
                    ws.send(json.dumps({"type": "subscribe", "id": "view", "fields": "full", "msg_types": [1, 2, 3, 18, 19],
                                        "bbox": [{"west": w, "south": s, "east": e, "north": n} for w, s, e, n in boxes]}))
                    sent, sent_at = boxes, time.time()
                    self.note = "CENTRE OF VIEW ONLY: ZOOM IN FOR ALL OF IT" if trimmed else "FOLLOWING THE VIEW"
            try:
                raw = ws.recv(timeout=2)
            except TimeoutError:
                if time.time() - quiet > 90:
                    raise ConnectionError("no heartbeat for 90 s")
                continue
            quiet = time.time()
            msg = json.loads(raw)
            kind = msg.get("type")
            if kind == "position":
                d = msg.get("data") or {}
                t = _iso_ts(d.get("rx_ts"), time.time())
                mmsi = d.get("mmsi")
                eta = d.get("eta")
                static = {"name": _clean(d.get("shipname")), "type": d.get("shiptype"), "call": _clean(d.get("callsign")),
                          "dest": _clean(d.get("destination")), "imo": d.get("imo"), "draught": d.get("draught"),
                          "length": d.get("length"), "beam": d.get("beam")}
                if isinstance(eta, str) and len(eta) >= 11:
                    try:
                        static["eta"] = {"Month": int(eta[0:2]), "Day": int(eta[3:5]), "Hour": int(eta[6:8]), "Minute": int(eta[9:11])}
                    except ValueError:
                        pass
                if any(v for v in static.values()):
                    self.store.ingest_static(self.id, mmsi, static)
                self.store.ingest_position(self.id, None, mmsi, d.get("lat"), d.get("lon"), _num(d.get("sog"), 102.2),
                                           _num(d.get("cog"), 360), _num(d.get("heading"), 360), d.get("nav_status"),
                                           "B" if d.get("msg_type") in (18, 19) else "A", t)
                self.counted()
                if self.status != "RECEIVING":
                    self.status, self.error = "RECEIVING", None
            elif kind == "subscribed":
                self.status = "RECEIVING"
            elif kind == "heartbeat":
                if self.status != "RECEIVING":
                    self.status = "RECEIVING"
                if msg.get("feed") == "stalled":
                    self.note = "PELYR REPORTS ITS FEED HAS STALLED"
            elif kind == "error":
                text = ("%s: %s" % (msg.get("code"), msg.get("message"))).upper()[:140]
                if msg.get("fatal"):
                    raise _Final("PELYR: " + text)
                self.error = text
            elif kind == "notice" and msg.get("code") in ("throttled", "slow_consumer_warning", "feed_stalled"):
                self.note = str(msg.get("code")).upper().replace("_", " ")
        return 0


# --------------------------------------------------------------------------- the store

class AIS:
    def __init__(self, root, log, ssl_context=None):
        self.log, self.ssl_context = log, ssl_context
        self.cov_path = os.path.join(root, "data", "ais-coverage.json")
        os.makedirs(os.path.dirname(self.cov_path), exist_ok=True)
        self.lock = threading.Lock()
        self.ships = {}              # mmsi -> dict of latest values
        self.tracks = {}             # mmsi -> array('f') of [t, lat, lon, sog] * n, t relative to self.t0
        self.t0 = time.time()
        self.cov, self.cov_seconds = {}, 0.0
        self.client_seen, self.view = 0.0, None
        self.receiving_since = None
        self.sources = [AisStream(self), Fintraffic(self), OpenWaters(self), Pelyr(self)]
        self._started = False
        self._load_coverage()

    # ------------------------------------------------------------------ lifecycle

    def active(self):
        return time.time() - self.client_seen < CLIENT_TTL

    def touch(self, view=None):
        self.client_seen = time.time()
        if view:
            self.view = tuple(view)
        if not self._started:
            self._started = True
            for s in self.sources:
                s.start()
            threading.Thread(target=self._housekeeping, daemon=True, name="ais-housekeeping").start()

    def stop(self):
        self.client_seen = 0.0

    def _housekeeping(self):
        last, last_save = time.time(), time.time()
        while True:
            time.sleep(5)
            now = time.time()
            receiving = self.active() and any(s.status == "RECEIVING" for s in self.sources)
            if receiving:
                self.cov_seconds += now - last
                self.receiving_since = self.receiving_since or now
            elif not self.active():
                self.receiving_since = None
            last = now
            if now - last_save > SAVE_EVERY:
                last_save = now
                self._prune(now)
                self._save_coverage()

    # ------------------------------------------------------------------ ingest

    def _ship(self, mmsi):
        ship = self.ships.get(mmsi)
        if ship is None:
            ship = self.ships[mmsi] = {"mmsi": mmsi}
        return ship

    def ingest_decoded(self, src, via, kind, body, mmsi, meta_name, t):
        """A message in aisstream.io's decoded form (aisstream and Open Waters both use it)."""
        mmsi = mmsi or body.get("UserID")
        if not isinstance(mmsi, int) or mmsi < 100000000:
            return
        if meta_name:
            with self.lock:
                ship = self._ship(mmsi)
                if not ship.get("name"):
                    ship["name"] = meta_name
        if kind in POSITION_KINDS:
            self.ingest_position(src, via, mmsi, body.get("Latitude"), body.get("Longitude"), _num(body.get("Sog"), 102.2),
                                 _num(body.get("Cog"), 360), _num(body.get("TrueHeading"), 360),
                                 body.get("NavigationalStatus") if kind == "PositionReport" else None,
                                 "A" if kind == "PositionReport" else "B", t)
            if kind == "ExtendedClassBPositionReport":
                self.ingest_static(src, mmsi, {"name": _clean(body.get("Name")), "type": body.get("Type") or None, **_dims(body.get("Dimension"))})
        elif kind == "ShipStaticData":
            self.ingest_static(src, mmsi, {
                "name": _clean(body.get("Name")), "call": _clean(body.get("CallSign")), "dest": _clean(body.get("Destination")),
                "type": body.get("Type") or None, "imo": body.get("ImoNumber") or None,
                "draught": body.get("MaximumStaticDraught") or None, "eta": body.get("Eta"), "cls": "A", **_dims(body.get("Dimension"))})
        elif kind == "StaticDataReport":
            a, b = body.get("ReportA") or {}, body.get("ReportB") or {}
            fields = {}
            if a.get("Valid"):
                fields["name"] = _clean(a.get("Name"))
            if b.get("Valid"):
                fields.update(call=_clean(b.get("CallSign")), type=b.get("ShipType") or None, **_dims(b.get("Dimension")))
            self.ingest_static(src, mmsi, fields)

    def ingest_static(self, src, mmsi, fields):
        if not isinstance(mmsi, int) or mmsi < 100000000:
            return
        with self.lock:
            ship = self._ship(mmsi)
            for k, v in fields.items():
                if v not in (None, "", 0):
                    ship[k] = v
            ship["static_t"] = time.time()

    def ingest_position(self, src, via, mmsi, lat, lon, sog, cog, hdg, nav, cls, t):
        """Record one position report. Returns False if it was unusable."""
        if not isinstance(mmsi, int) or mmsi < 100000000:
            return False
        if not isinstance(lat, (int, float)) or not isinstance(lon, (int, float)):
            return False
        if abs(lat) > 90 or abs(lon) > 180 or (abs(lat) < 0.01 and abs(lon) < 0.01):
            return False
        now = time.time()
        t = min(t, now)
        with self.lock:
            ship = self._ship(mmsi)
            if ship.get("t") and abs(t - ship["t"]) < 0.5 and ship.get("lat") == round(lat, 5) and ship.get("lon") == round(lon, 5):
                return True                              # the same report again, via another feed or an overlapping poll
            cell = (int((lat + 90) // CELL), int((lon + 180) // CELL))
            c = self.cov.get(cell)
            if c is None:
                self.cov[cell] = [1, now]
            else:
                c[0] += 1
                c[1] = now
            heard = ship.setdefault("src", {})
            heard[src + ("/" + via if via and via != src else "")] = now
            if ship.get("t") and t < ship["t"] - 1:
                return True                              # an older report from a slower feed
            ship.update(lat=round(lat, 5), lon=round(lon, 5), t=t, sog=sog, cog=cog, hdg=hdg)
            if nav is not None:
                ship["nav"] = nav
            if cls and not ship.get("cls"):
                ship["cls"] = cls
            tr = self.tracks.get(mmsi)
            rel = t - self.t0
            if tr is None:
                self.tracks[mmsi] = array.array("f", (rel, lat, lon, sog or 0))
            else:
                gap, moved = rel - tr[-4], abs(lat - tr[-3]) + abs(lon - tr[-2])
                if (gap >= TRACK_GAP and moved > TRACK_MOVE_DEG) or gap >= 15 * 60:
                    tr.extend((rel, lat, lon, sog or 0))
                    cut = 0
                    while cut < len(tr) - 4 and rel - tr[cut] > TRACK_SECONDS:
                        cut += 4
                    if cut:
                        del tr[:cut]
        return True

    def _prune(self, now):
        with self.lock:
            for mmsi in [m for m, s in self.ships.items() if now - s.get("t", s.get("static_t", now)) > FORGET_AFTER]:
                self.ships.pop(mmsi, None)
                self.tracks.pop(mmsi, None)

    # ------------------------------------------------------------------ coverage persistence

    def _load_coverage(self):
        try:
            with open(self.cov_path) as f:
                d = json.load(f)
            if d.get("cell") == CELL:
                self.cov = {tuple(int(v) for v in k.split(",")): v for k, v in d["cells"].items()}
                self.cov_seconds = float(d.get("seconds", 0))
        except (OSError, ValueError, KeyError):
            pass

    def _save_coverage(self):
        with self.lock:
            cells = {"%d,%d" % k: [v[0], round(v[1])] for k, v in self.cov.items()}
        tmp = self.cov_path + ".tmp"
        try:
            with open(tmp, "w") as f:
                json.dump({"cell": CELL, "seconds": round(self.cov_seconds), "cells": cells}, f, separators=(",", ":"))
            os.replace(tmp, self.cov_path)
        except OSError as e:
            self.log("ais: could not save coverage -", repr(e))

    # ------------------------------------------------------------------ API

    def meta(self, box=None, view=None):
        self.touch(view)
        now = time.time()
        with self.lock:
            live = [s for s in self.ships.values() if "lat" in s and now - s["t"] < SHOW_FOR]
        sources = [s.describe() for s in self.sources]
        receiving = [s for s in self.sources if s.status == "RECEIVING"]
        attribution = []                                 # one entry per credit, in a stable order
        for text in sorted({a for s in self.sources if s.status == "RECEIVING" for a in s.attribution}):
            for part in text.split(". "):
                part = part.strip().rstrip(".")
                if part and part not in attribution:
                    attribution.append(part)
        # the same credit can arrive with and without its licence link: keep the fuller one
        attribution = [a for a in attribution if not any(b != a and b.startswith(a) for b in attribution)]
        return {
            "status": "RECEIVING" if receiving else "CONNECTING", "error": None if receiving or not all(s.error for s in self.sources) else "NO SOURCE AVAILABLE",
            "rate": round(sum(s.rate for s in self.sources), 1), "ships": len(live),
            "inView": sum(1 for s in live if _in_box(s, box)) if box else None,
            "since": self.receiving_since, "coverageHours": round(self.cov_seconds / 3600, 2),
            "showMinutes": SHOW_FOR // 60, "sources": sources, "attribution": attribution,
        }

    def geojson(self, box=None, view=None):
        """Ships heard from in the last hour, as GeoJSON bytes."""
        self.touch(view)
        now = time.time()
        with self.lock:
            live = [s for s in self.ships.values() if "lat" in s and now - s["t"] < SHOW_FOR and (not box or _in_box(s, box))]
            parts = []
            if len(live) > MAX_FEATURES:
                live.sort(key=lambda s: -s["t"])
                live = live[:MAX_FEATURES]
            for s in live:
                sog = s.get("sog") or 0
                moving = sog >= 0.8
                rot = s.get("hdg") if s.get("hdg") is not None else s.get("cog") if moving and s.get("cog") is not None else 0
                parts.append('{"type":"Feature","geometry":{"type":"Point","coordinates":[%.5f,%.5f]},'
                             '"properties":{"m":%d,"n":%s,"k":%d,"h":%d,"s":%.1f,"mv":%s,"a":%d}}' % (
                                 s["lon"], s["lat"], s["mmsi"], json.dumps(s.get("name") or ""),
                                 category(s.get("type"), s.get("nav")), round(rot), sog, "true" if moving else "false",
                                 max(0, now - s["t"]) // 60))
        return ('{"type":"FeatureCollection","features":[' + ",".join(parts) + "]}").encode()

    def ship(self, mmsi):
        self.touch()
        now = time.time()
        with self.lock:
            s = json.loads(json.dumps(self.ships.get(mmsi) or {}))
            tr = self.tracks.get(mmsi)
            track = [[round((self.t0 + tr[i]) * 1000), round(tr[i + 1], 5), round(tr[i + 2], 5), round(tr[i + 3], 1)]
                     for i in range(0, len(tr), 4)] if tr else []
        if not s or "lat" not in s:
            raise KeyError("ship not heard from recently")
        if track and (track[-1][1], track[-1][2]) != (s["lat"], s["lon"]):
            track.append([round(s["t"] * 1000), s["lat"], s["lon"], s.get("sog") or 0])
        s["age"] = round(max(0, now - s["t"]))
        s["t"] = round(s["t"] * 1000)
        s.pop("static_t", None)
        s["category"] = CATEGORIES[category(s.get("type"), s.get("nav"))]
        s["sources"] = [{"source": k, "ago": round(now - v)} for k, v in sorted((s.pop("src", None) or {}).items(), key=lambda kv: -kv[1])]
        s["track"] = track
        return s

    def coverage(self):
        """Coverage cells as GeoJSON: reports per hour of recording, and when each cell was last heard."""
        self.touch()
        hours = max(self.cov_seconds / 3600, 1 / 60)
        now = time.time()
        with self.lock:
            cells = list(self.cov.items())
        feats = []
        for (i, j), (count, last) in cells:
            s, w = i * CELL - 90, j * CELL - 180
            ring = [[w, s], [w + CELL, s], [w + CELL, s + CELL], [w, s + CELL], [w, s]]
            feats.append({"type": "Feature", "geometry": {"type": "Polygon", "coordinates": [ring]},
                          "properties": {"r": round(count / hours, 1), "ago": round((now - last) / 3600, 1)}})
        return {"type": "FeatureCollection", "features": feats, "hours": round(self.cov_seconds / 3600, 2),
                "cell": CELL, "cells": len(feats)}


def _dims(d):
    if not isinstance(d, dict):
        return {}
    length, beam = (d.get("A") or 0) + (d.get("B") or 0), (d.get("C") or 0) + (d.get("D") or 0)
    return {"length": length, "beam": beam} if length else {}


def _in_box(s, box):
    w, so, e, n = box
    if not so <= s["lat"] <= n:
        return False
    return (s["lon"] >= w or s["lon"] <= e) if w > e else w <= s["lon"] <= e
