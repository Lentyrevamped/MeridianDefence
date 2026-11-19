"""OSINT guardrails. One choke point: every lookup goes through `authorize()` then `audit.record()`.

Rules (agreed scope, 19 Nov 2026):
- No lookup without an open case, a subject on that case, and the case's stated purpose.
- Public figures / companies: full public aggregation. "Public" = subject linked to a Wikidata entity.
- Private individuals: username discovery, breach exposure for an email, news mentions, licensed-provider links.
- No module compiles home addresses or personal phone numbers of private people (there is no such module, and
  queries that look like a phone number or street address are refused for private subjects).
"""
from __future__ import annotations

import re
import secrets as pysecrets
import time

from ..db import DB
from . import audit

MODULES = {
    "public": {"profile", "news", "usernames", "filings", "breach", "providers"},
    "company": {"profile", "news", "filings", "providers"},
    "private": {"usernames", "breach", "news", "providers"},
}
BASES = {  # permissible-purpose style bases a PI states on the case
    "litigation": "Litigation support / legal proceedings",
    "due_diligence": "Due diligence (business, investment, hiring with consent)",
    "fraud": "Fraud investigation",
    "locate_witness": "Locate witness/party via licensed provider",
    "insurance": "Insurance claim investigation",
    "self_exposure": "Own exposure check (subject is the client)",
    "research": "Public-figure research / journalism",
}
PHONE = re.compile(r"^\+?[\d\s().-]{7,}$")
ADDRESS = re.compile(r"\d+\s+\w+.*\b(st|street|rd|road|ave|avenue|blvd|lane|ln|dr|drive|way|ct|court|calle|rue|straße|strasse)\b", re.I)


class Refused(Exception):
    pass


def new_case(db: DB, title: str, purpose: str, basis: str, client: str = "") -> dict:
    title, purpose = title.strip(), purpose.strip()
    if len(title) < 3:
        raise Refused("Give the case a title.")
    if len(purpose) < 10:
        raise Refused("State the purpose of the investigation (a sentence).")
    if basis not in BASES:
        raise Refused("Pick a basis for the case.")
    cid = time.strftime("MI-%Y%m%d-") + pysecrets.token_hex(3).upper()
    db.x("INSERT INTO cases(id,title,client,purpose,basis,created) VALUES(?,?,?,?,?,?)",
         (cid, title, client.strip(), purpose, basis, time.time()))
    return get_case(db, cid)


def get_case(db: DB, cid: str) -> dict:
    rows = db.q("SELECT * FROM cases WHERE id=?", (cid,))
    if not rows:
        raise Refused("Unknown case.")
    c = rows[0]
    c["subjects"] = db.q("SELECT * FROM subjects WHERE case_id=? ORDER BY id", (cid,))
    return c


def add_subject(db: DB, cid: str, name: str, kind: str, wikidata: str | None = None, notes: str = "") -> dict:
    c = get_case(db, cid)
    if c["closed"]:
        raise Refused("Case is closed.")
    name = name.strip()
    if not 2 <= len(name) <= 120:
        raise Refused("Subject name looks wrong.")
    if kind not in MODULES:
        raise Refused("Subject type must be public, company or private.")
    if kind in ("public", "company") and not (wikidata and re.fullmatch(r"Q\d{1,10}", wikidata)):
        raise Refused("A public figure or company must be linked to its Wikidata entry. "
                      "Without one, add the subject as a private individual.")
    sid = db.x("INSERT INTO subjects(case_id,name,kind,wikidata,notes,created) VALUES(?,?,?,?,?,?)",
               (cid, name, kind, wikidata if kind != "private" else None, notes, time.time()))
    return db.q("SELECT * FROM subjects WHERE id=?", (sid,))[0]


def authorize(db: DB, cid: str, sid: int, module: str, query: str) -> tuple[dict, dict]:
    c = get_case(db, cid)
    subj = next((s for s in c["subjects"] if s["id"] == sid), None)
    def refuse(why: str):
        audit.record(db, case_id=cid, subject_id=sid, subject=subj["name"] if subj else "?",
                     kind=subj["kind"] if subj else "?", purpose=c["purpose"], module=module, query=query,
                     outcome=f"refused: {why}")
        raise Refused(why)
    if c["closed"]:
        refuse("case is closed")
    if subj is None:
        refuse("subject is not on this case")
    if module not in MODULES[subj["kind"]]:
        refuse(f"'{module}' is not available for a {subj['kind']} subject")
    if subj["kind"] == "private" and (PHONE.match(query.strip()) or ADDRESS.search(query)):
        refuse("phone numbers and street addresses of private individuals are out of scope; "
               "use a licensed provider (see Providers)")
    return c, subj


def log_ok(db: DB, c: dict, subj: dict, module: str, query: str, results: int) -> None:
    audit.record(db, case_id=c["id"], subject_id=subj["id"], subject=subj["name"], kind=subj["kind"],
                 purpose=c["purpose"], module=module, query=query, outcome="ok", results=results)


def log_err(db: DB, c: dict, subj: dict, module: str, query: str, err: str) -> None:
    audit.record(db, case_id=c["id"], subject_id=subj["id"], subject=subj["name"], kind=subj["kind"],
                 purpose=c["purpose"], module=module, query=query, outcome=f"error: {err[:120]}")
