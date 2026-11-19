"""Append-only, hash-chained audit log of every OSINT lookup.

Each row's hash = SHA-256(prev_hash || canonical JSON of the row). SQLite triggers refuse UPDATE/DELETE, and
`verify()` recomputes the chain, so an edited or removed row shows up as a break at that sequence number.
"""
from __future__ import annotations

import csv
import hashlib
import io
import json
import time

from ..db import DB

GENESIS = "0" * 64
FIELDS = ("seq", "ts", "case_id", "subject_id", "subject", "kind", "purpose", "module", "query", "outcome", "results")


def _digest(prev: str, row: dict) -> str:
    body = json.dumps({k: row[k] for k in FIELDS}, sort_keys=True, separators=(",", ":"), ensure_ascii=False)
    return hashlib.sha256((prev + body).encode()).hexdigest()


def record(db: DB, *, case_id: str, subject_id: int | None, subject: str, kind: str, purpose: str,
           module: str, query: str, outcome: str, results: int = 0) -> dict:
    with db._lock:  # serialise seq + prev
        last = db.conn.execute("SELECT seq, hash FROM audit ORDER BY seq DESC LIMIT 1").fetchone()
        seq = (last["seq"] + 1) if last else 1
        prev = last["hash"] if last else GENESIS
        row = {"seq": seq, "ts": round(time.time(), 3), "case_id": case_id, "subject_id": subject_id,
               "subject": subject, "kind": kind, "purpose": purpose, "module": module, "query": query[:500],
               "outcome": outcome, "results": int(results)}
        row["prev"] = prev
        row["hash"] = _digest(prev, row)
        db.conn.execute(f"INSERT INTO audit({','.join(FIELDS)},prev,hash) VALUES({','.join('?' * (len(FIELDS) + 2))})",
                        tuple(row[k] for k in FIELDS) + (prev, row["hash"]))
    return row


def verify(db: DB) -> dict:
    prev = GENESIS
    n = 0
    for row in db.q("SELECT * FROM audit ORDER BY seq"):
        n += 1
        if row["seq"] != n:
            return {"ok": False, "rows": n - 1, "break_at": row["seq"], "why": "gap in sequence (row removed)"}
        if row["prev"] != prev or _digest(prev, row) != row["hash"]:
            return {"ok": False, "rows": n - 1, "break_at": row["seq"], "why": "hash mismatch (row edited)"}
        prev = row["hash"]
    return {"ok": True, "rows": n, "head": prev}


def entries(db: DB, case_id: str | None = None, limit: int = 500) -> list[dict]:
    if case_id:
        return db.q("SELECT * FROM audit WHERE case_id=? ORDER BY seq DESC LIMIT ?", (case_id, limit))
    return db.q("SELECT * FROM audit ORDER BY seq DESC LIMIT ?", (limit,))


def export_csv(db: DB, case_id: str | None = None) -> str:
    rows = list(reversed(entries(db, case_id, 10**9)))
    buf = io.StringIO()
    w = csv.writer(buf)
    w.writerow(list(FIELDS) + ["utc", "prev", "hash"])
    for r in rows:
        w.writerow([r[k] for k in FIELDS] + [time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(r["ts"])), r["prev"], r["hash"]])
    return buf.getvalue()
