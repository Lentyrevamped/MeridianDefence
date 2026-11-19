"""Live aircraft (ADS-B). adsb.lol for regional views (unfiltered, no key), OpenSky for wide views."""
from __future__ import annotations

import math

from .. import secrets
from ..net import FeedError, get_json

NM_PER_DEG = 60.0


def _bbox_center_radius(s: float, w: float, n: float, e: float) -> tuple[float, float, float]:
    lat = (s + n) / 2
    lon = (w + e) / 2
    dlat = (n - s) / 2 * NM_PER_DEG
    dlon = (e - w) / 2 * NM_PER_DEG * math.cos(math.radians(lat))
    return lat, lon, math.hypot(dlat, dlon)


def _norm_adsblol(a: dict) -> dict | None:
    if a.get("lat") is None or a.get("lon") is None:
        return None
    alt = a.get("alt_baro")
    return {
        "id": a.get("hex", ""), "cs": (a.get("flight") or "").strip(), "lat": a["lat"], "lon": a["lon"],
        "alt": 0 if alt == "ground" else alt, "gnd": alt == "ground", "gs": a.get("gs"),
        "trk": a.get("track") or a.get("true_heading") or 0, "type": a.get("t", ""), "reg": a.get("r", ""),
        "sq": a.get("squawk", ""), "mil": bool((a.get("dbFlags") or 0) & 1), "src": "adsb.lol",
    }


def _norm_opensky(s: list) -> dict | None:
    if s[5] is None or s[6] is None:
        return None
    alt_m = s[7] if s[7] is not None else s[13]
    return {
        "id": s[0], "cs": (s[1] or "").strip(), "lat": s[6], "lon": s[5],
        "alt": round(alt_m * 3.28084) if alt_m is not None else None, "gnd": bool(s[8]),
        "gs": round(s[9] * 1.94384) if s[9] is not None else None, "trk": s[10] or 0,
        "type": "", "reg": "", "sq": s[14] or "", "mil": False, "src": "opensky", "country": s[2],
    }


async def fetch(s: float, w: float, n: float, e: float) -> list[dict]:
    lat, lon, radius = _bbox_center_radius(s, w, n, e)
    if radius <= 250:
        data = await get_json(f"https://api.adsb.lol/v2/point/{lat:.4f}/{lon:.4f}/{max(5, int(radius))}")
        out = [x for x in (_norm_adsblol(a) for a in data.get("ac", [])) if x]
        return [p for p in out if s <= p["lat"] <= n and w <= p["lon"] <= e] or out
    user, pw = secrets.get("opensky_user"), secrets.get("opensky_pass")
    params = {"lamin": max(-90, s), "lomin": max(-180, w), "lamax": min(90, n), "lomax": min(180, e)}
    try:
        data = await get_json("https://opensky-network.org/api/states/all", params=params,
                              auth=(user, pw) if user and pw else None)
    except FeedError:
        # wide view and OpenSky refused: fall back to the biggest adsb.lol circle around the centre
        data2 = await get_json(f"https://api.adsb.lol/v2/point/{lat:.4f}/{lon:.4f}/250")
        return [x for x in (_norm_adsblol(a) for a in data2.get("ac", [])) if x]
    return [x for x in (_norm_opensky(st) for st in (data.get("states") or [])) if x]


async def military() -> list[dict]:
    data = await get_json("https://api.adsb.lol/v2/mil")
    return [x for x in (_norm_adsblol(a) for a in data.get("ac", [])) if x]
