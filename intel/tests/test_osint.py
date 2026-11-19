"""Guardrail and audit-chain tests (no network)."""
import sqlite3

import pytest

from meridian_intel.db import DB
from meridian_intel.osint import audit, guard


@pytest.fixture
def db(tmp_path):
    return DB(tmp_path / "t.db")


def _case(db):
    return guard.new_case(db, "Test case", "Background check on a business partner", "due_diligence")


def test_case_requires_purpose_and_basis(db):
    with pytest.raises(guard.Refused):
        guard.new_case(db, "X case", "short", "due_diligence")
    with pytest.raises(guard.Refused):
        guard.new_case(db, "X case", "A long enough purpose here", "nope")


def test_public_needs_wikidata(db):
    c = _case(db)
    with pytest.raises(guard.Refused):
        guard.add_subject(db, c["id"], "Some Person", "public")
    s = guard.add_subject(db, c["id"], "Some Person", "public", "Q42")
    assert s["wikidata"] == "Q42"


def test_private_module_limits_and_phone_address_refused(db):
    c = _case(db)
    s = guard.add_subject(db, c["id"], "Jane Private", "private")
    for mod in ("profile", "filings", "address", "phone"):
        with pytest.raises(guard.Refused):
            guard.authorize(db, c["id"], s["id"], mod, "x")
    for q in ("+1 (555) 123-4567", "12 Baker Street London"):
        with pytest.raises(guard.Refused):
            guard.authorize(db, c["id"], s["id"], "news", q)
    guard.authorize(db, c["id"], s["id"], "usernames", "janep")  # allowed
    rows = audit.entries(db, c["id"])
    assert sum(r["outcome"].startswith("refused") for r in rows) == 6
    assert audit.verify(db)["ok"]


def test_subject_must_belong_to_case(db):
    c1, c2 = _case(db), _case(db)
    s = guard.add_subject(db, c1["id"], "Jane Private", "private")
    with pytest.raises(guard.Refused):
        guard.authorize(db, c2["id"], s["id"], "usernames", "janep")


def test_closed_case_refuses(db):
    c = _case(db)
    s = guard.add_subject(db, c["id"], "Jane Private", "private")
    db.x("UPDATE cases SET closed=1 WHERE id=?", (c["id"],))
    with pytest.raises(guard.Refused):
        guard.authorize(db, c["id"], s["id"], "usernames", "janep")


def test_audit_append_only_and_tamper_evident(db, tmp_path):
    c = _case(db)
    s = guard.add_subject(db, c["id"], "Jane Private", "private")
    for i in range(5):
        guard.log_ok(db, c, s, "usernames", f"handle{i}", i)
    assert audit.verify(db) == {"ok": True, "rows": 5, "head": audit.entries(db)[0]["hash"]}
    with pytest.raises(sqlite3.DatabaseError):
        db.x("UPDATE audit SET query='x' WHERE seq=2")
    with pytest.raises(sqlite3.DatabaseError):
        db.x("DELETE FROM audit WHERE seq=2")
    # an attacker with raw file access drops the trigger and edits a row: verify catches it
    db.conn.execute("DROP TRIGGER audit_no_update")
    db.conn.execute("UPDATE audit SET query='edited' WHERE seq=3")
    r = audit.verify(db)
    assert not r["ok"] and r["break_at"] == 3
    csv = audit.export_csv(db, c["id"])
    assert csv.count("\n") == 6
