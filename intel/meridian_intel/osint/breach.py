"""Breach exposure for an email address via Have I Been Pwned (paid key). Returns breach names, dates, data classes.
No breach contents are fetched or stored (HIBP never provides them)."""
from __future__ import annotations

import re

from .. import secrets
from ..net import FeedError, client

EMAIL = re.compile(r"^[^@\s]{1,64}@[^@\s]{1,255}\.[A-Za-z]{2,}$")


async def check(email: str) -> dict:
    if not EMAIL.match(email):
        raise ValueError("not an email address")
    key = secrets.get("hibp")
    if not key:
        return {"status": "needs key", "breaches": [],
                "how": "meridian-intel keys set hibp (subscription at haveibeenpwned.com/API/Key)"}
    r = await client().get(f"https://haveibeenpwned.com/api/v3/breachedaccount/{email}",
                           params={"truncateResponse": "false"}, headers={"hibp-api-key": key})
    if r.status_code == 404:
        return {"status": "clean", "breaches": []}
    if r.status_code != 200:
        raise FeedError(f"HIBP HTTP {r.status_code}")
    return {"status": "exposed", "breaches": [{
        "name": b.get("Title") or b.get("Name"), "domain": b.get("Domain"), "date": b.get("BreachDate"),
        "count": b.get("PwnCount"), "data": b.get("DataClasses", []), "verified": b.get("IsVerified"),
    } for b in r.json()]}
