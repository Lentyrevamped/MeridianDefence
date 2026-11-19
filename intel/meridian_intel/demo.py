"""Synthetic demo data, used when MERIDIAN_INTEL_DEMO=1 (offline testing / screenshots).

Everything here is generated and labelled demo in the UI. Nothing resembles a real person.
"""
from __future__ import annotations

import hashlib
import math
import random
import time

AIRPORTS = [(51.47, -0.45), (49.01, 2.55), (50.04, 8.56), (52.31, 4.76), (40.47, -3.56), (41.80, 12.25),
            (25.25, 55.36), (40.64, -73.78), (33.94, -118.41), (35.55, 139.78), (1.36, 103.99), (50.45, 30.52)]
LANES = [((49.9, -6.0), (51.2, 1.6)), ((51.0, 1.5), (53.9, 8.0)), ((36.0, -5.6), (37.5, 15.0)),
         ((31.3, 32.3), (12.6, 43.3)), ((1.2, 103.8), (22.2, 114.0)), ((26.5, 56.3), (25.3, 51.6))]
CALLS = ["BAW", "AFR", "DLH", "KLM", "IBE", "UAE", "QTR", "RYR", "EZY", "SIA", "UAL", "AAL", "RCH", "NATO"]
TYPES = ["A320", "A321", "B738", "B77W", "A359", "B789", "A388", "E190", "C17", "K35R"]
PLACES = [("Kharkiv, Ukraine", 49.99, 36.23, "UP"), ("Khartoum, Sudan", 15.50, 32.56, "SU"),
          ("Gaza City, Gaza Strip", 31.50, 34.47, "GZ"), ("Port-au-Prince, Haiti", 18.54, -72.34, "HA"),
          ("Goma, DR Congo", -1.68, 29.22, "CG"), ("Paris, France", 48.86, 2.35, "FR"),
          ("Caracas, Venezuela", 10.49, -66.88, "VE"), ("Tbilisi, Georgia", 41.72, 44.79, "GG"),
          ("Sanaa, Yemen", 15.37, 44.19, "YM"), ("Bamako, Mali", 12.64, -8.00, "ML"),
          ("Dhaka, Bangladesh", 23.81, 90.41, "BG"), ("Seoul, South Korea", 37.57, 126.98, "KS")]
CATS = ["protest", "coercion", "assault", "fighting", "mass violence"]


def _rng(*parts) -> random.Random:
    return random.Random(int(hashlib.sha256("|".join(map(str, parts)).encode()).hexdigest()[:12], 16))


def aircraft(s, w, n, e) -> list[dict]:
    t = time.time()
    out = []
    r = _rng("ac")
    for i in range(900):
        a = AIRPORTS[r.randrange(len(AIRPORTS))]
        b = AIRPORTS[r.randrange(len(AIRPORTS))]
        if a == b:
            continue
        period = r.uniform(4000, 30000)
        f = ((t / period) + r.random()) % 1.0
        lat = a[0] + (b[0] - a[0]) * f + r.uniform(-2, 2)
        lon = a[1] + (b[1] - a[1]) * f + r.uniform(-2, 2)
        if not (s <= lat <= n and w <= lon <= e):
            continue
        trk = (math.degrees(math.atan2(b[1] - a[1], b[0] - a[0])) + 360) % 360
        cs = f"{r.choice(CALLS)}{r.randrange(10, 9999)}"
        out.append({"id": f"{r.getrandbits(24):06x}", "cs": cs, "lat": lat, "lon": lon,
                    "alt": int(36000 * min(1, 4 * min(f, 1 - f)) // 100 * 100), "gnd": False,
                    "gs": r.randrange(380, 520), "trk": round(trk), "type": r.choice(TYPES), "reg": "",
                    "sq": "7700" if i == 7 else f"{r.randrange(1000, 7000):04d}", "mil": cs[:3] in ("RCH", "NAT"),
                    "src": "demo"})
    return out


def ships(s, w, n, e) -> list[dict]:
    t = time.time()
    out = []
    r = _rng("ship")
    for i in range(700):
        (la, lo), (lb, lob) = LANES[r.randrange(len(LANES))]
        f = ((t / r.uniform(20000, 90000)) + r.random()) % 1.0
        lat = la + (lb - la) * f + r.uniform(-0.25, 0.25)
        lon = lo + (lob - lo) * f + r.uniform(-0.25, 0.25)
        if not (s <= lat <= n and w <= lon <= e):
            continue
        hdg = (math.degrees(math.atan2(lob - lo, lb - la)) + 360) % 360
        out.append({"id": 200000000 + i, "name": f"DEMO VESSEL {i:03d}",
                    "cls": r.choice(["cargo", "cargo", "tanker", "passenger", "fishing", "other"]),
                    "lat": lat, "lon": lon, "sog": round(r.uniform(6, 19), 1), "cog": round(hdg), "hdg": round(hdg),
                    "dest": r.choice(["ROTTERDAM", "HAMBURG", "SUEZ", "SINGAPORE", "PIRAEUS"]), "ts": t})
    return out


def events() -> list[dict]:
    r = _rng("ev", int(time.time() // 900))
    out = []
    for i in range(260):
        place, lat, lon, cc = r.choice(PLACES)
        cat = r.choices(CATS, weights=[5, 2, 2, 3, 1])[0]
        out.append({"id": str(i), "cat": cat, "code": "190", "lat": lat + r.gauss(0, 0.6), "lon": lon + r.gauss(0, 0.6),
                    "place": place, "cc": cc, "a1": "Demo actor", "a2": "", "gold": -r.uniform(1, 10),
                    "mentions": r.randrange(1, 60), "tone": round(-r.uniform(1, 9), 1),
                    "ts": time.strftime("%Y%m%d%H%M%S", time.gmtime(time.time() - r.uniform(0, 3500))), "url": "https://example.org/demo"})
    return out


BASE = {"^GSPC": 6800, "^IXIC": 23500, "BTC-USD": 92000, "ETH-USD": 3100, "GC=F": 4050, "CL=F": 61,
        "EURUSD=X": 1.16, "^TNX": 4.1, "AAPL": 270, "NVDA": 190, "TSLA": 400}
RNG_SECS = {"1D": (86400, 300), "5D": (5 * 86400, 900), "1M": (30 * 86400, 3600), "6M": (182 * 86400, 86400),
            "1Y": (365 * 86400, 86400), "5Y": (5 * 365 * 86400, 7 * 86400), "MAX": (20 * 365 * 86400, 30 * 86400)}


def history(sym: str, rng: str = "1Y") -> dict:
    sym = sym.upper()
    span, step = RNG_SECS.get(rng, RNG_SECS["1Y"])
    now = int(time.time()) // step * step
    r = _rng("px", sym, step)
    base = BASE.get(sym, 50 + r.random() * 400)
    vol = 0.03 if sym.endswith("-USD") else 0.012
    n = span // step
    walk = [0.0]
    for _ in range(n):
        walk.append(walk[-1] + r.gauss(0.0002, vol * math.sqrt(step / 86400)))
    shift = walk[-1]
    pts = []
    for i, wv in enumerate(walk):
        c = base * math.exp(wv - shift)
        o = c * (1 + r.gauss(0, vol / 4))
        pts.append({"t": now - (n - i) * step, "o": o, "h": max(o, c) * 1.004, "l": min(o, c) * 0.996, "c": c,
                    "v": r.randrange(1000, 100000)})
    return {"symbol": sym, "name": f"{sym} (demo)", "currency": "USD", "exchange": "DEMO", "price": pts[-1]["c"],
            "prev": pts[-2]["c"] if rng == "1D" else pts[0]["c"], "points": pts, "src": "demo"}


def quote(sym: str) -> dict:
    h = history(sym, "5D")
    pts = h.pop("points")
    h["prev"] = pts[-96]["c"] if len(pts) > 96 else pts[0]["c"]
    h["spark"] = [p["c"] for p in pts[-60:]]
    return h


def news(query: str) -> list[dict]:
    r = _rng("news", query)
    return [{"title": f"Demo headline {i + 1} about {query}", "url": "https://example.org/demo",
             "domain": r.choice(["example.org", "example.net", "example.com"]),
             "ts": time.strftime("%Y%m%dT%H%M%SZ", time.gmtime(time.time() - i * 1800)), "lang": "English",
             "country": ""} for i in range(8)]
