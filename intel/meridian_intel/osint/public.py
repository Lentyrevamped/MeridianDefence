"""Public-figure and company profiles from Wikidata + Wikipedia, plus SEC EDGAR full-text search."""
from __future__ import annotations

from urllib.parse import quote

from ..net import FeedError, get_json

WD = "https://www.wikidata.org/w/api.php"
ITEM_PROPS = {  # property -> label (values are other Wikidata items)
    "P31": "instance of", "P106": "occupation", "P27": "citizenship", "P19": "place of birth",
    "P39": "positions held", "P102": "political party", "P108": "employer", "P69": "educated at",
    "P26": "spouse", "P166": "awards", "P463": "member of", "P159": "headquarters", "P452": "industry",
    "P112": "founded by", "P169": "CEO", "P127": "owned by", "P749": "parent organisation", "P17": "country",
}
TIME_PROPS = {"P569": "born", "P570": "died", "P571": "founded"}
STRING_PROPS = {"P856": "website", "P414": "stock exchange", "P249": "ticker", "P946": "ISIN", "P1278": "LEI"}
ACCOUNTS = {  # property -> (platform, url template)
    "P2002": ("X / Twitter", "https://x.com/{}"), "P2003": ("Instagram", "https://instagram.com/{}"),
    "P2013": ("Facebook", "https://facebook.com/{}"), "P2397": ("YouTube", "https://youtube.com/channel/{}"),
    "P7085": ("TikTok", "https://tiktok.com/@{}"), "P6634": ("LinkedIn", "https://linkedin.com/in/{}"),
    "P4264": ("LinkedIn (company)", "https://linkedin.com/company/{}"), "P2037": ("GitHub", "https://github.com/{}"),
    "P4033": ("Mastodon", "https://{}"), "P3789": ("Telegram", "https://t.me/{}"),
    "P2847": ("Google+ (archived)", "https://plus.google.com/{}"), "P3185": ("VK", "https://vk.com/{}"),
    "P11892": ("Threads", "https://threads.net/@{}"), "P12361": ("Bluesky", "https://bsky.app/profile/{}"),
    "P5797": ("Twitch", "https://twitch.tv/{}"), "P1902": ("Spotify artist", "https://open.spotify.com/artist/{}"),
    "P345": ("IMDb", "https://imdb.com/name/{}"), "P1581": ("Blog", "{}"),
}


async def search(name: str) -> list[dict]:
    data = await get_json(WD, params={"action": "wbsearchentities", "search": name[:100], "language": "en",
                                      "format": "json", "limit": "8", "type": "item"})
    return [{"id": x["id"], "label": x.get("label", ""), "description": x.get("description", "")}
            for x in data.get("search", [])]


def _claims(ent: dict, prop: str) -> list:
    return [c["mainsnak"].get("datavalue", {}).get("value") for c in ent.get("claims", {}).get(prop, [])
            if c.get("mainsnak", {}).get("snaktype") == "value" and c.get("rank") != "deprecated"]


async def profile(qid: str) -> dict:
    data = await get_json(WD, params={"action": "wbgetentities", "ids": qid, "format": "json",
                                      "props": "labels|descriptions|claims|sitelinks|aliases", "languages": "en"})
    ent = data.get("entities", {}).get(qid)
    if not ent or "missing" in ent:
        raise FeedError("Wikidata entity not found")
    out: dict = {"id": qid, "label": ent.get("labels", {}).get("en", {}).get("value", qid),
                 "description": ent.get("descriptions", {}).get("en", {}).get("value", ""),
                 "aliases": [a["value"] for a in ent.get("aliases", {}).get("en", [])][:10],
                 "facts": {}, "accounts": [], "links": {"wikidata": f"https://www.wikidata.org/wiki/{qid}"}}
    refs: dict[str, list[str]] = {}
    for p, label in ITEM_PROPS.items():
        ids = [v["id"] for v in _claims(ent, p) if isinstance(v, dict) and "id" in v]
        if ids:
            refs[label] = ids[:12]
    for p, label in TIME_PROPS.items():
        vals = [v.get("time", "")[1:11] for v in _claims(ent, p) if isinstance(v, dict)]
        if vals:
            out["facts"][label] = vals[0]
    for p, label in STRING_PROPS.items():
        vals = [v for v in _claims(ent, p) if isinstance(v, str)]
        if vals:
            out["facts"][label] = ", ".join(vals[:3])
    for p, (platform, tpl) in ACCOUNTS.items():
        for v in _claims(ent, p)[:3]:
            if isinstance(v, str):
                out["accounts"].append({"platform": platform, "handle": v, "url": tpl.format(v),
                                        "source": "Wikidata (curated)"})
    all_ids = sorted({i for ids in refs.values() for i in ids})
    names: dict[str, str] = {}
    for i in range(0, len(all_ids), 50):
        lab = await get_json(WD, params={"action": "wbgetentities", "ids": "|".join(all_ids[i:i + 50]),
                                         "props": "labels", "languages": "en", "format": "json"})
        for k, v in lab.get("entities", {}).items():
            names[k] = v.get("labels", {}).get("en", {}).get("value", k)
    for label, ids in refs.items():
        out["facts"][label] = ", ".join(names.get(i, i) for i in ids)
    title = ent.get("sitelinks", {}).get("enwiki", {}).get("title")
    if title:
        out["links"]["wikipedia"] = f"https://en.wikipedia.org/wiki/{quote(title.replace(' ', '_'))}"
        try:
            s = await get_json(f"https://en.wikipedia.org/api/rest_v1/page/summary/{quote(title.replace(' ', '_'))}")
            out["summary"] = s.get("extract", "")
            out["image"] = (s.get("thumbnail") or {}).get("source")
        except FeedError:
            pass
    out["is_human"] = "Q5" in [v.get("id") for v in _claims(ent, "P31") if isinstance(v, dict)]
    return out


async def edgar(name: str) -> list[dict]:
    data = await get_json("https://efts.sec.gov/LATEST/search-index", params={"q": f'"{name[:80]}"'})
    out = []
    for h in (data.get("hits") or {}).get("hits", [])[:25]:
        s = h.get("_source", {})
        adsh = (h.get("_id") or "").split(":")[0]
        cik = (s.get("ciks") or [""])[0].lstrip("0")
        out.append({"form": s.get("form") or s.get("root_form", ""), "date": s.get("file_date", ""),
                    "names": s.get("display_names", []),
                    "url": f"https://www.sec.gov/Archives/edgar/data/{cik}/{adsh.replace('-', '')}/" if cik and adsh else ""})
    return out
