"""API tests in demo mode: auth, host pinning, CSRF header, OSINT flow end to end."""
import os

import pytest
from fastapi.testclient import TestClient


@pytest.fixture
def client(tmp_path, monkeypatch):
    monkeypatch.setenv("XDG_DATA_HOME", str(tmp_path / "d"))
    monkeypatch.setenv("XDG_CONFIG_HOME", str(tmp_path / "c"))
    from meridian_intel import config
    config.settings.data_dir = tmp_path / "d" / "meridian-intel"
    config.settings.config_dir = tmp_path / "c" / "meridian-intel"
    config.settings.demo = True
    from meridian_intel import server
    tok = server.new_token()
    with TestClient(server.app, base_url=f"http://127.0.0.1:{config.settings.port}") as c:
        c.tok = tok
        yield c


H = {"X-Requested-With": "meridian"}


def test_auth_and_host(client):
    assert client.get("/api/status").status_code == 401
    assert client.get("/api/status", headers={"x-meridian-token": "nope"}).status_code == 401
    assert client.get(f"/?t={client.tok}", follow_redirects=False).status_code == 303
    assert client.get("/api/status").status_code == 200          # cookie set
    assert client.get("/api/status", headers={"host": "evil.example:8787"}).status_code == 421
    assert client.post("/api/watches", json={"topic": "x"}).status_code == 403   # no CSRF header
    assert client.post("/api/watches", json={"topic": "x"}, headers=H).status_code == 200


def test_feeds_demo(client):
    client.get(f"/?t={client.tok}")
    assert client.get("/api/aircraft?s=30&w=-20&n=60&e=40").json()["ac"]
    assert client.get("/api/ships?s=30&w=-20&n=60&e=40").json()["ships"]
    assert client.get("/api/events").json()["events"]
    h = client.get("/api/history?s=AAPL&r=1Y").json()
    assert len(h["points"]) > 300
    assert client.get("/api/aircraft?s=60&w=0&n=30&e=10").status_code == 400
    assert client.post("/api/ask", json={"q": "hi"}, headers=H).json().get("needs_key") in (True, None)


def test_osint_flow(client):
    client.get(f"/?t={client.tok}")
    c = client.post("/api/osint/cases", headers=H, json={"title": "Acme diligence", "purpose": "Due diligence on Acme's CEO before investment", "basis": "due_diligence"}).json()
    cid = c["id"]
    cand = client.post(f"/api/osint/cases/{cid}/link-search", headers=H, json={"name": "Some CEO"}).json()["results"]
    pub = client.post(f"/api/osint/cases/{cid}/subjects", headers=H, json={"name": "Some CEO", "kind": "public", "wikidata": cand[0]["id"]}).json()
    priv = client.post(f"/api/osint/cases/{cid}/subjects", headers=H, json={"name": "Jane Private", "kind": "private"}).json()
    r = client.post("/api/osint/lookup", headers=H, json={"case": cid, "subject": pub["id"], "module": "profile"})
    assert r.status_code == 200 and r.json()["data"]["label"] == "Some CEO"
    r = client.post("/api/osint/lookup", headers=H, json={"case": cid, "subject": priv["id"], "module": "usernames", "query": "janep"})
    assert r.status_code == 200 and any(x["status"] == "found" for x in r.json()["data"]["results"])
    assert client.post("/api/osint/lookup", headers=H, json={"case": cid, "subject": priv["id"], "module": "profile"}).status_code == 403
    assert client.post("/api/osint/lookup", headers=H, json={"case": cid, "subject": priv["id"], "module": "news", "query": "+44 20 7946 0958"}).status_code == 403
    a = client.get(f"/api/osint/audit?case={cid}").json()
    assert a["verify"]["ok"] and len(a["entries"]) == 5
    assert "refused" in a["entries"][0]["outcome"]
    assert client.get(f"/api/osint/audit/export?case={cid}").text.startswith("seq,")
