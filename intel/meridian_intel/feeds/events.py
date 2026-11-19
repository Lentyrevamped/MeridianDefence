"""Conflict / unrest events from the GDELT 2.0 Events export (free, every 15 minutes, geocoded).

CAMEO root codes kept: 14 protest, 17 coerce, 18 assault, 19 fight, 20 unconventional mass violence.
GDELT is machine-coded from news; treat single events as leads, clusters as signal.
"""
from __future__ import annotations

import csv
import io
import zipfile
from datetime import datetime, timedelta, timezone

from ..net import FeedError, get

KEEP = {"14": "protest", "17": "coercion", "18": "assault", "19": "fighting", "20": "mass violence"}
BASES = ("http://data.gdeltproject.org/gdeltv2/",)   # GDELT's data host has no valid TLS; content is public data
MAX_ZIP = 40 * 2**20


def _slots(n: int, now: datetime | None = None) -> list[str]:
    now = now or datetime.now(timezone.utc)
    t = now.replace(second=0, microsecond=0, minute=(now.minute // 15) * 15) - timedelta(minutes=15)
    return [(t - timedelta(minutes=15 * i)).strftime("%Y%m%d%H%M%S") for i in range(n)]


def parse_export(blob: bytes) -> list[dict]:
    if len(blob) > MAX_ZIP:
        raise FeedError("GDELT export too large")
    with zipfile.ZipFile(io.BytesIO(blob)) as z:
        name = z.namelist()[0]
        if z.getinfo(name).file_size > 8 * MAX_ZIP:
            raise FeedError("GDELT export too large")
        text = z.read(name).decode("utf-8", "replace")
    out, seen = [], set()
    for row in csv.reader(io.StringIO(text), delimiter="\t"):
        if len(row) < 61 or row[28] not in KEEP or row[51] in ("", "0"):
            continue
        try:
            lat, lon = float(row[56]), float(row[57])
        except ValueError:
            continue
        key = (row[60], round(lat, 2), round(lon, 2), row[28])
        if key in seen:
            continue
        seen.add(key)
        out.append({
            "id": row[0], "cat": KEEP[row[28]], "code": row[26], "lat": lat, "lon": lon,
            "place": row[52], "cc": row[53], "a1": row[6].title(), "a2": row[16].title(),
            "gold": float(row[30] or 0), "mentions": int(row[31] or 0), "tone": round(float(row[34] or 0), 1),
            "ts": row[59], "url": row[60],
        })
    return out


async def fetch(slots: int = 4) -> list[dict]:
    events: list[dict] = []
    errors = 0
    for slot in _slots(slots):
        for base in BASES:
            try:
                r = await get(f"{base}{slot}.export.CSV.zip")
                events.extend(parse_export(r.content))
                break
            except (FeedError, zipfile.BadZipFile):
                errors += 1
    if not events and errors:
        raise FeedError("GDELT events unavailable")
    return events
