"""Parser tests on recorded-shape payloads (no network)."""
import io
import zipfile

from meridian_intel.feeds import aircraft, events, ships


def _row(root="19", lat="50.45", lon="30.52", geotype="4", url="https://news.example/a"):
    r = [""] * 61
    r[0], r[6], r[16], r[26], r[28] = "1", "UKRAINE", "RUSSIA", root + "0", root
    r[30], r[31], r[34], r[51], r[52], r[53] = "-10", "12", "-7.5", geotype, "Kyiv, Ukraine", "UP"
    r[56], r[57], r[59], r[60] = lat, lon, "20261119031500", url
    return "\t".join(r)


def test_gdelt_parse_filters_and_dedupes():
    rows = [_row(), _row(), _row(root="05"), _row(geotype="0"), _row(lat="x"), _row(root="14", url="https://b")]
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as z:
        z.writestr("x.export.CSV", "\n".join(rows))
    out = events.parse_export(buf.getvalue())
    assert [e["cat"] for e in out] == ["fighting", "protest"]
    assert out[0]["place"] == "Kyiv, Ukraine" and out[0]["mentions"] == 12 and out[0]["a1"] == "Ukraine"


def test_slots_are_quarter_hours():
    s = events._slots(3)
    assert len(s) == 3 and all(x[-4:] in ("0000", "1500", "3000", "4500") for x in s)


def test_adsblol_and_opensky_normalise():
    a = aircraft._norm_adsblol({"hex": "43c6f1", "flight": "RRR123 ", "lat": 51, "lon": 0, "alt_baro": 31000,
                                "gs": 420, "track": 90, "t": "A400", "dbFlags": 1, "squawk": "7700"})
    assert a["cs"] == "RRR123" and a["mil"] and a["sq"] == "7700"
    assert aircraft._norm_adsblol({"hex": "x"}) is None
    g = aircraft._norm_adsblol({"hex": "x", "lat": 1, "lon": 2, "alt_baro": "ground"})
    assert g["gnd"] and g["alt"] == 0
    o = aircraft._norm_opensky(["abc", "DLH1  ", "Germany", 0, 0, 8.5, 50.0, 10000.0, False, 230.0, 270.0, 0, None, 10100.0, "1000", False, 0, 0])
    assert o["alt"] == 32808 and o["gs"] == 447 and o["cs"] == "DLH1"
    lat, lon, r = aircraft._bbox_center_radius(50, 0, 52, 4)
    assert 50 < lat < 52 and 80 < r < 120


def test_ais_ingest_and_view():
    t = ships.ShipTracker()
    t._ingest({"MessageType": "PositionReport", "MetaData": {"MMSI": 1, "ShipName": "EVER TEST ", "latitude": 51.0, "longitude": 1.5},
               "Message": {"PositionReport": {"Sog": 12.3, "Cog": 45, "TrueHeading": 511}}})
    t._ingest({"MessageType": "ShipStaticData", "MetaData": {"MMSI": 1}, "Message": {"ShipStaticData": {"Type": 84, "Destination": "ROTTERDAM "}}})
    snap = t.snapshot(50, 0, 52, 3)
    assert snap[0]["name"] == "EVER TEST" and snap[0]["cls"] == "tanker" and snap[0]["hdg"] == 45 and snap[0]["dest"] == "ROTTERDAM"
    t.set_view(-10, -100, 10, -80)   # far away: resubscribe requested
    assert t._want is not None
