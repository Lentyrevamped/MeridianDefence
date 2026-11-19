"""Live ships via aisstream.io websocket (free key). Keeps an in-memory table keyed by MMSI."""
from __future__ import annotations

import asyncio
import json
import logging
import time

from .. import secrets

log = logging.getLogger(__name__)
URL = "wss://stream.aisstream.io/v0/stream"
STALE = 30 * 60

# AIS ship type code → coarse class
def ship_class(t: int | None) -> str:
    if t is None:
        return "unknown"
    if 70 <= t <= 79:
        return "cargo"
    if 80 <= t <= 89:
        return "tanker"
    if 60 <= t <= 69:
        return "passenger"
    if t == 30:
        return "fishing"
    if t in (35,):
        return "military"
    if 50 <= t <= 59:
        return "service"
    if t in (36, 37):
        return "pleasure"
    return "other"


class ShipTracker:
    def __init__(self):
        self.ships: dict[int, dict] = {}
        self.bbox: tuple[float, float, float, float] = (35.0, -12.0, 62.0, 30.0)  # Europe default
        self._want: tuple[float, float, float, float] | None = None
        self._task: asyncio.Task | None = None
        self.status = "off"
        self.msgs = 0

    def set_view(self, s, w, n, e):
        pad_lat, pad_lon = (n - s) * 0.25, (e - w) * 0.25
        want = (max(-90, s - pad_lat), max(-180, w - pad_lon), min(90, n + pad_lat), min(180, e + pad_lon))
        cur = self.bbox
        inside = cur[0] <= s and cur[1] <= w and cur[2] >= n and cur[3] >= e
        much_smaller = (n - s) * (e - w) < (cur[2] - cur[0]) * (cur[3] - cur[1]) / 16
        if not inside or much_smaller:
            self._want = want

    def start(self):
        if self._task is None:
            self._task = asyncio.create_task(self._run())

    async def stop(self):
        if self._task:
            self._task.cancel()
            self._task = None

    def snapshot(self, s, w, n, e) -> list[dict]:
        now = time.time()
        out = []
        for mmsi, v in list(self.ships.items()):
            if now - v["ts"] > STALE:
                self.ships.pop(mmsi, None)
                continue
            if s <= v["lat"] <= n and w <= v["lon"] <= e:
                out.append(v)
        return out[:8000]

    def _ingest(self, m: dict) -> None:
        meta = m.get("MetaData") or {}
        mmsi = meta.get("MMSI")
        if not mmsi:
            return
        rec = self.ships.setdefault(mmsi, {"id": mmsi, "name": "", "cls": "unknown", "lat": 0, "lon": 0,
                                           "sog": None, "cog": None, "hdg": None, "dest": "", "ts": 0})
        if meta.get("ShipName"):
            rec["name"] = meta["ShipName"].strip()
        msg = m.get("Message") or {}
        t = m.get("MessageType")
        if t in ("PositionReport", "StandardClassBPositionReport"):
            p = msg.get(t) or {}
            rec.update(lat=meta.get("latitude", p.get("Latitude")), lon=meta.get("longitude", p.get("Longitude")),
                       sog=p.get("Sog"), cog=p.get("Cog"), ts=time.time())
            hdg = p.get("TrueHeading")
            rec["hdg"] = hdg if hdg is not None and hdg < 360 else rec.get("cog")
        elif t == "ShipStaticData":
            p = msg.get(t) or {}
            rec["cls"] = ship_class(p.get("Type"))
            rec["dest"] = (p.get("Destination") or "").strip()
            rec["imo"] = p.get("ImoNumber")
            rec["callsign"] = (p.get("CallSign") or "").strip()

    async def _run(self):
        import websockets  # noqa: PLC0415

        delay = 2
        while True:
            key = secrets.get("aisstream")
            if not key:
                self.status = "needs key"
                await asyncio.sleep(15)
                continue
            if self._want:
                self.bbox, self._want = self._want, None
            s, w, n, e = self.bbox
            sub = {"APIKey": key, "BoundingBoxes": [[[s, w], [n, e]]],
                   "FilterMessageTypes": ["PositionReport", "StandardClassBPositionReport", "ShipStaticData"]}
            try:
                async with websockets.connect(URL, open_timeout=15, ping_interval=20, max_size=2**20) as ws:
                    await ws.send(json.dumps(sub))
                    self.status = "live"
                    delay = 2
                    async for raw in ws:
                        self.msgs += 1
                        try:
                            self._ingest(json.loads(raw))
                        except (ValueError, TypeError):
                            continue
                        if self._want:   # view moved out of the subscribed box: resubscribe
                            break
            except asyncio.CancelledError:
                raise
            except Exception as e:  # noqa: BLE001
                self.status = f"reconnecting ({type(e).__name__})"
                log.warning("aisstream: %s", e)
                await asyncio.sleep(delay)
                delay = min(delay * 2, 120)


tracker = ShipTracker()
