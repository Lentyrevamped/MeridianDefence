// COP: basemaps, tracks (air/maritime), events, layer tree with facets, inspector, timeline.
import { api, esc, safeUrl, fmt, ago } from "./api.js";

maplibregl.setWorkerUrl("/static/vendor/maplibre-gl-csp-worker.js");

export const C = { t1: "#E6E8EB", t2: "#8A939E", t3: "#5C6570", bg: "#111418", blue: "#4C90F0", green: "#32A467", amber: "#E8A33D", red: "#E5484D", steel: "#8FA3B8" };
const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
const REF = ["https://server.arcgisonline.com/ArcGIS/rest/services/Reference/World_Boundaries_and_Places/MapServer/tile/{z}/{y}/{x}"];
export const BASEMAPS = {
  dark: { code: "DRK", name: "Dark", tiles: ["a", "b", "c", "d"].map((s) => `https://${s}.basemaps.cartocdn.com/dark_nolabels/{z}/{x}/{y}@2x.png`), max: 20,
    labels: ["a", "b", "c", "d"].map((s) => `https://${s}.basemaps.cartocdn.com/dark_only_labels/{z}/{x}/{y}@2x.png`),
    attr: "© OpenStreetMap © CARTO" },
  sat: { code: "SAT", name: "Satellite (Esri)", tiles: ["https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}"], max: 19, labels: REF, attr: "Imagery © Esri, Maxar, Earthstar Geographics" },
  s2: { code: "S2C", name: "Sentinel-2 cloudless", tiles: ["https://tiles.maps.eox.at/wmts/1.0.0/s2cloudless-2024_3857/default/g/{z}/{y}/{x}.jpg"], max: 16, labels: REF, attr: "Sentinel-2 cloudless 2024 by EOX (Copernicus)" },
  today: { code: "D-1", name: `NASA VIIRS ${yesterday}`, tiles: [`https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/VIIRS_SNPP_CorrectedReflectance_TrueColor/default/${yesterday}/GoogleMapsCompatible_Level9/{z}/{y}/{x}.jpg`], max: 9, labels: REF, attr: `NASA GIBS VIIRS ${yesterday}` },
  terrain: { code: "TER", name: "Terrain (hillshade)", tiles: null, attr: "AWS Terrain Tiles · Natural Earth" },
  outline: { code: "OFF", name: "Offline outline", tiles: null, attr: "Natural Earth (offline)" },
};
export const CATS = [["protest", "PRT", C.amber], ["coercion", "COE", C.amber], ["assault", "ASL", C.red], ["fighting", "FGT", C.red], ["mass violence", "MAV", C.red]];
export const SHIPS = [["cargo", "CGO"], ["tanker", "TNK"], ["passenger", "PAX"], ["fishing", "FSH"], ["service", "SVC"], ["pleasure", "PLR"], ["military", "MIL"], ["other", "OTH"], ["unknown", "UNK"]];
export const AIR = [["civ", "CIV", "Civil"], ["mil", "MIL", "Military"], ["emg", "EMG", "Emergency squawk 7500/7600/7700"], ["gnd", "GND", "On ground"]];
const catColor = Object.fromEntries(CATS.map(([k, , c]) => [k, c]));
const catCode = Object.fromEntries(CATS.map(([k, c]) => [k, c]));
const shipCode = Object.fromEntries(SHIPS);

function icon(draw, size) {
  const c = document.createElement("canvas"); c.width = c.height = size; const g = c.getContext("2d");
  g.translate(size / 2, size / 2); g.fillStyle = "#fff"; g.beginPath(); draw(g); g.fill();
  return g.getImageData(0, 0, size, size);
}
const PLANE = (g) => { g.scale(1, 1); [[0, -20], [3, -12], [3, -4], [18, 4], [18, 8], [3, 4], [2.5, 13], [7, 17], [7, 20], [0, 18], [-7, 20], [-7, 17], [-2.5, 13], [-3, 4], [-18, 8], [-18, 4], [-3, -4], [-3, -12]].forEach(([x, y], i) => i ? g.lineTo(x, y) : g.moveTo(x, y)); g.closePath(); };
const HULL = (g) => { g.moveTo(0, -13); g.lineTo(6, -3); g.lineTo(6, 12); g.lineTo(-6, 12); g.lineTo(-6, -3); g.closePath(); };
const DIAMOND = (g) => { g.moveTo(0, -11); g.lineTo(11, 0); g.lineTo(0, 11); g.lineTo(-11, 0); g.closePath(); };

const airCls = (a) => (["7500", "7600", "7700"].includes(a.sq) ? "emg" : a.gnd ? "gnd" : a.mil ? "mil" : "civ");

export class WorldMap {
  constructor(el, hooks) {
    this.hooks = hooks; this.base = "dark"; this.data = { ac: [], ships: [], events: [] };
    this.vis = { ac: true, ships: true, events: true, labels: true, mono: false, terrain3d: false, milfeed: false };
    this.f = { air: new Set(AIR.map((x) => x[0])), ship: new Set(SHIPS.map((x) => x[0])), cat: new Set(CATS.map((x) => x[0])) };
    this.hist = []; this.closed = new Set(["OVL"]); this.rings = [];
    this.map = new maplibregl.Map({
      container: el, center: [20, 30], zoom: 2.4, hash: "map", attributionControl: false, maxPitch: 75,
      style: { version: 8, sources: {}, layers: [{ id: "bg", type: "background", paint: { "background-color": C.bg } }] },
    });
    this.map.addControl(new maplibregl.NavigationControl({ visualizePitch: true }), "top-right");
    this.map.addControl(new maplibregl.ScaleControl({ unit: "metric" }), "bottom-left");
    this.map.on("load", () => this._init());
    this.map.on("mousemove", (e) => this.hooks.coords(`${e.lngLat.lat.toFixed(4)} ${e.lngLat.lng.toFixed(4)} Z${this.map.getZoom().toFixed(1)}`));
    document.querySelectorAll("[data-lpt]").forEach((b) => b.onclick = () => {
      document.querySelectorAll("[data-lpt]").forEach((x) => x.classList.toggle("on", x === b));
      document.getElementById("tree").hidden = b.dataset.lpt !== "layers"; document.getElementById("sources").hidden = b.dataset.lpt !== "sources";
      document.querySelector("#v-map .psearch").hidden = b.dataset.lpt !== "layers";
      if (b.dataset.lpt === "sources") this.renderSources();
    });
    const q = document.getElementById("lp-q");
    q.oninput = () => this.renderTree();
    q.onkeydown = (e) => { if (e.key === "Enter") this.search(q.value.trim()); };
  }

  async _init() {
    const m = this.map;
    m.addImage("plane", icon(PLANE, 48), { sdf: true, pixelRatio: 2 });
    m.addImage("hull", icon(HULL, 32), { sdf: true, pixelRatio: 2 });
    m.addImage("diamond", icon(DIAMOND, 26), { sdf: true, pixelRatio: 2 });
    m.addSource("dem", { type: "raster-dem", tiles: ["https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png"], encoding: "terrarium", tileSize: 256, maxzoom: 14 });
    const countries = await fetch("/static/vendor/countries-110m.geojson").then((r) => r.json());
    m.addSource("countries", { type: "geojson", data: countries });
    for (const id of ["ac", "ships", "events", "rings"]) m.addSource(id, { type: "geojson", data: { type: "FeatureCollection", features: [] } });
    this.setBase(this.base);
    this._layers();
    this.refresh(true);
    setInterval(() => this.refresh(false), 10000);
    setInterval(() => this.loadEvents(), 300000);
    setInterval(() => this.drawTimeline(), 1000);
    new ResizeObserver(() => this.drawTimeline()).observe(document.getElementById("tl-canvas"));
    document.getElementById("d-back").onclick = () => this.showFeed();
  }

  setBase(name) {
    const m = this.map, b = BASEMAPS[name]; this.base = name;
    for (const id of ["base", "labels", "hill", "land", "borders"]) if (m.getLayer(id)) m.removeLayer(id);
    for (const id of ["base", "labels"]) if (m.getSource(id)) m.removeSource(id);
    const before = m.getLayer("rings") ? "rings" : undefined;
    if (b.tiles) {
      m.addSource("base", { type: "raster", tiles: b.tiles, tileSize: 256, maxzoom: b.max });
      m.addLayer({ id: "base", type: "raster", source: "base", paint: { "raster-saturation": this.vis.mono || name === "dark" ? -1 : -0.15, "raster-brightness-max": name === "dark" ? 0.9 : 0.85, "raster-fade-duration": 150 } }, before);
    } else {
      m.addLayer({ id: "land", type: "fill", source: "countries", paint: { "fill-color": "#1A1E24", "fill-opacity": name === "terrain" ? 0.6 : 1 } }, before);
      if (name === "terrain") m.addLayer({ id: "hill", type: "hillshade", source: "dem", paint: { "hillshade-shadow-color": "#000", "hillshade-highlight-color": "#8A939E", "hillshade-accent-color": "#262C34", "hillshade-exaggeration": 0.55 } }, before);
    }
    if (this.vis.labels) {
      if (b.labels) {
        m.addSource("labels", { type: "raster", tiles: b.labels, tileSize: 256, maxzoom: 19 });
        m.addLayer({ id: "labels", type: "raster", source: "labels", paint: { "raster-saturation": -1, "raster-opacity": 0.85 } }, before);
      } else m.addLayer({ id: "borders", type: "line", source: "countries", paint: { "line-color": "#5C6570", "line-width": 0.6 } }, before);
    }
    document.getElementById("attrib").textContent = `${b.attr} · TRK-A adsb.lol/OpenSky · TRK-M aisstream.io · EVT-G GDELT`;
    document.getElementById("base-name").textContent = `BASE ${b.code}`;
    this.renderTree();
  }

  _layers() {
    const m = this.map;
    m.addLayer({ id: "rings", type: "line", source: "rings", paint: { "line-color": C.red, "line-width": 1.2, "line-dasharray": [4, 3] } });
    m.addLayer({ id: "rings-fill", type: "fill", source: "rings", paint: { "fill-color": C.red, "fill-opacity": 0.06 } });
    m.addLayer({ id: "events-halo", type: "circle", source: "events", filter: ["==", ["get", "cat"], "mass violence"],
      paint: { "circle-radius": ["interpolate", ["linear"], ["zoom"], 2, 10, 8, 24], "circle-color": C.red, "circle-opacity": 0.16, "circle-blur": 0.5 } });
    m.addLayer({ id: "events", type: "symbol", source: "events", layout: {
      "icon-image": "diamond", "icon-allow-overlap": true, "icon-ignore-placement": true,
      "icon-size": ["interpolate", ["linear"], ["zoom"], 2, ["+", 0.45, ["*", 0.012, ["min", ["get", "mentions"], 40]]], 8, ["+", 0.8, ["*", 0.02, ["min", ["get", "mentions"], 40]]]] },
      paint: { "icon-color": ["match", ["get", "cat"], ...CATS.flatMap(([k, , c]) => [k, c]), C.t2], "icon-halo-color": "#000", "icon-halo-width": 1, "icon-opacity": ["match", ["get", "cat"], "protest", 0.85, "coercion", 0.7, 1] } });
    m.addLayer({ id: "ships", type: "symbol", source: "ships", layout: {
      "icon-image": "hull", "icon-size": ["interpolate", ["linear"], ["zoom"], 2, 0.4, 9, 0.85], "icon-rotate": ["get", "hdg"],
      "icon-rotation-alignment": "map", "icon-allow-overlap": true, "icon-ignore-placement": true },
      paint: { "icon-color": ["match", ["get", "cls"], "military", C.blue, "tanker", "#B9C7D6", C.steel], "icon-halo-color": "#000", "icon-halo-width": 0.8 } });
    m.addLayer({ id: "ac", type: "symbol", source: "ac", layout: {
      "icon-image": "plane", "icon-size": ["interpolate", ["linear"], ["zoom"], 2, 0.4, 9, 0.85], "icon-rotate": ["get", "trk"],
      "icon-rotation-alignment": "map", "icon-allow-overlap": true, "icon-ignore-placement": true },
      paint: { "icon-color": ["match", ["get", "k"], "emg", C.red, "mil", C.blue, "gnd", C.t3, C.t1],
        "icon-halo-color": ["case", ["==", ["get", "k"], "emg"], "rgba(229,72,77,.6)", "#000"], "icon-halo-width": ["case", ["==", ["get", "k"], "emg"], 3, 0.8] } });
    m.addLayer({ id: "sel", type: "circle", source: "ac", filter: ["==", ["get", "id"], ""], paint: { "circle-radius": 14, "circle-color": "rgba(0,0,0,0)", "circle-stroke-color": "#F1F1EE", "circle-stroke-width": 1.5 } });
    const hover = new maplibregl.Popup({ closeButton: false, closeOnClick: false, offset: 12 });
    for (const id of ["ac", "ships", "events"]) {
      m.on("mouseenter", id, (e) => { m.getCanvas().style.cursor = "crosshair"; const p = e.features[0].properties;
        hover.setLngLat(e.lngLat).setText(id === "ac" ? `A-${String(p.id).toUpperCase()} ${p.cs || ""}` : id === "ships" ? `M-${p.id} ${p.name || ""}` : `E-${p.id} ${catCode[p.cat]} ${p.place}`).addTo(m); });
      m.on("mouseleave", id, () => { m.getCanvas().style.cursor = ""; hover.remove(); });
      m.on("click", id, (e) => this.select(id, e.features[0].properties));
    }
    m.on("moveend", () => this.refresh(true));
    this.applyFilters();
  }

  applyFilters() {
    const m = this.map; if (!m.getLayer("ac")) return;
    const v = (on) => (on ? "visible" : "none");
    m.setLayoutProperty("ac", "visibility", v(this.vis.ac)); m.setLayoutProperty("ships", "visibility", v(this.vis.ships));
    m.setLayoutProperty("events", "visibility", v(this.vis.events)); m.setLayoutProperty("events-halo", "visibility", v(this.vis.events && this.f.cat.has("mass violence")));
    m.setFilter("ac", ["in", ["get", "k"], ["literal", [...this.f.air]]]);
    m.setFilter("ships", ["in", ["get", "cls"], ["literal", [...this.f.ship]]]);
    m.setFilter("events", ["in", ["get", "cat"], ["literal", [...this.f.cat]]]);
  }

  // ---------- layer tree ----------
  renderTree() {
    const el = document.getElementById("tree"); if (!el) return;
    const q = (document.getElementById("lp-q").value || "").toLowerCase();
    const match = (s) => !q || s.toLowerCase().includes(q);
    const count = (arr, key) => arr.reduce((o, x) => ((o[key(x)] = (o[key(x)] || 0) + 1), o), {});
    const ac = count(this.data.ac, airCls), sh = count(this.data.ships, (s) => s.cls || "unknown"), ev = count(this.data.events, (e) => e.cat);
    const max = (o) => Math.max(1, ...Object.values(o));
    const row = (kind, key, code, name, n, mx, sel, color, radio) => match(`${code} ${name}`) ? `<div class="row ${radio ? "radio" : "chk"} ${sel ? "sel" : "off"}" data-k="${kind}" data-v="${esc(key)}" title="${esc(name)}">
      <span class="sw" ${color && sel ? `style="background:${color};border-color:${color}"` : ""}></span><span class="nm"><span class="mono">${esc(code)}</span>${name ? ` <span class="dim">${esc(name)}</span>` : ""}</span>
      <span class="n">${n ?? ""}</span>${mx ? `<span class="barv"><i style="width:${Math.round(((n || 0) / mx) * 100)}%"></i></span>` : "<span></span>"}</div>` : "";
    const grp = (code, title, n, on, toggle, body) => `<div class="grp ${this.closed.has(code) ? "closed" : ""}" data-g="${code}">
      <div class="gh"><span class="car">${this.closed.has(code) ? "▸" : "▾"}</span>${toggle ? `<span class="row chk ${on ? "sel" : ""}" data-k="vis" data-v="${toggle}" style="padding:0;height:auto;grid-template-columns:9px;display:inline-grid"><span class="sw"></span></span>` : ""}
      <b class="mono">${code}</b><span class="muted">${title}</span><span class="n">${n ?? ""}</span></div><div class="gb">${body}</div></div>`;
    const topPlaces = Object.entries(count(this.data.events, (e) => e.place || e.cc)).sort((a, b) => b[1] - a[1]).slice(0, 8);
    const pmax = Math.max(1, ...topPlaces.map((x) => x[1]));
    el.innerHTML =
      grp("TRK-A", "Air tracks", this.data.ac.length.toLocaleString(), this.vis.ac, "ac", AIR.map(([k, c, n]) => row("air", k, c, n, ac[k] || 0, max(ac), this.f.air.has(k), { civ: C.t1, mil: C.blue, emg: C.red, gnd: C.t3 }[k])).join("")) +
      grp("TRK-M", "Maritime tracks", this.data.ships.length.toLocaleString(), this.vis.ships, "ships", SHIPS.map(([k, c]) => row("ship", k, c, k, sh[k] || 0, max(sh), this.f.ship.has(k), k === "military" ? C.blue : C.steel)).join("")) +
      grp("EVT-G", "Events · 60 min", this.data.events.length.toLocaleString(), this.vis.events, "events",
        CATS.map(([k, c, col]) => row("cat", k, c, k, ev[k] || 0, max(ev), this.f.cat.has(k), col)).join("") +
        `<div class="sect" style="padding-left:24px">Top locations</div>` + topPlaces.map(([p, n]) => row("place", p, "LOC", p, n, pmax, true, null)).join("")) +
      grp("BASE", "Basemap", BASEMAPS[this.base].code, null, null, Object.entries(BASEMAPS).map(([k, b]) => row("base", k, b.code, b.name, null, 0, this.base === k, null, true)).join("")) +
      grp("OVL", "Overlays", "", null, null, [["labels", "LBL", "Labels and borders"], ["mono", "MNO", "Mono imagery"], ["terrain3d", "3DT", "3D terrain"], ["milfeed", "MILG", "Global military feed (TRK-A)"]]
        .map(([k, c, n]) => row("ovl", k, c, n, null, 0, this.vis[k], null)).join("") + (this.rings.length ? row("rings", "clear", "RNG", `${this.rings.length} range ring(s), click to clear`, null, 0, true, C.red) : ""));
    el.querySelectorAll(".gh").forEach((h) => h.onclick = (e) => { if (e.target.closest("[data-k]")) return; const g = h.parentElement.dataset.g; this.closed.has(g) ? this.closed.delete(g) : this.closed.add(g); this.renderTree(); });
    el.querySelectorAll("[data-k]").forEach((r) => r.onclick = (e) => { e.stopPropagation(); this.treeClick(r.dataset.k, r.dataset.v); });
  }

  treeClick(k, v) {
    const tog = (set) => (set.has(v) ? set.delete(v) : set.add(v));
    if (k === "vis") this.vis[v] = !this.vis[v];
    else if (k === "air") tog(this.f.air); else if (k === "ship") tog(this.f.ship); else if (k === "cat") tog(this.f.cat);
    else if (k === "base") { this.setBase(v); return; }
    else if (k === "place") { const e = this.data.events.find((x) => (x.place || x.cc) === v); if (e) { this.flyTo(e.lat, e.lon, 6); this.select("events", e); } return; }
    else if (k === "rings") { this.rings = []; this.map.getSource("rings").setData({ type: "FeatureCollection", features: [] }); }
    else if (k === "ovl") {
      this.vis[v] = !this.vis[v];
      if (v === "labels" || v === "mono") { this.setBase(this.base); return; }
      if (v === "terrain3d") { if (this.vis[v]) { this.map.setTerrain({ source: "dem", exaggeration: 1.3 }); this.map.easeTo({ pitch: 60 }); } else { this.map.setTerrain(null); this.map.easeTo({ pitch: 0 }); } }
      if (v === "milfeed") this.refresh(true);
    }
    this.applyFilters(); this.renderTree();
  }

  renderSources() {
    const s = this.hooks.feedState();
    document.getElementById("sources").innerHTML = [["TRK-A", "adsb.lol · OpenSky", s.air], ["TRK-M", "aisstream.io", s.sea], ["EVT-G", "GDELT 2.0 events", s.evt], ["IMG", BASEMAPS[this.base].name, "ok"], ["DEM", "AWS Terrain Tiles", "ok"], ["NE", "Natural Earth 110m (local)", "ok"]]
      .map(([c, n, st]) => `<div class="src"><b>${c}</b><span>${esc(n)}</span><em class="${st === "ok" || st === "live" || st === "demo" ? "ok" : "bad"}">${esc(String(st || "—").toUpperCase().slice(0, 18))}</em></div>`).join("");
  }

  search(q) {
    if (!q) return;
    const a = this.findAircraft(q); if (a) { this.flyTo(a.lat, a.lon, 8); this.select("ac", a); return; }
    const s = this.findShip(q); if (s) { this.flyTo(s.lat, s.lon, 9); this.select("ships", s); return; }
    const e = this.data.events.find((x) => (x.place || "").toLowerCase().includes(q.toLowerCase())); if (e) { this.flyTo(e.lat, e.lon, 6); this.select("events", e); return; }
    this.hooks.toast(`No track or event matches “${q}” in view`);
  }

  // ---------- data ----------
  bbox() {
    const b = this.map.getBounds(); const c = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
    let w = b.getWest(), e = b.getEast();
    if (e - w >= 360) { w = -180; e = 180; } else { w = c(w, -180, 179.9); e = c(e, w + 0.01, 180); }
    return { s: c(b.getSouth(), -90, 89.9).toFixed(3), w: w.toFixed(3), n: c(b.getNorth(), -89.9, 90).toFixed(3), e: e.toFixed(3) };
  }

  async refresh(force) {
    if (!this.map.getSource("ac")) return;
    const now = Date.now(); if (!force && now - (this._last || 0) < 9000) return; this._last = now;
    const q = new URLSearchParams(this.bbox()).toString();
    const tasks = [];
    if (this.vis.ac) tasks.push(api(`/api/aircraft?${q}${this.vis.milfeed ? "&mil=true" : ""}`).then((d) => {
      this.data.ac = d.ac.map((a) => ({ ...a, k: airCls(a) })); this._set("ac", this.data.ac); this.hooks.status("air", true);
    }).catch((e) => this.hooks.status("air", false, e.message)));
    if (this.vis.ships) tasks.push(api(`/api/ships?${q}`).then((d) => {
      this.data.ships = d.ships.map((s) => ({ ...s, cls: s.cls || "unknown" })); this._set("ships", this.data.ships);
      this.hooks.status("sea", d.status === "live" || d.status === "demo", d.status);
    }).catch((e) => this.hooks.status("sea", false, e.message)));
    if (!this.data.events.length) tasks.push(this.loadEvents());
    await Promise.all(tasks);
    this.hist.push({ t: Date.now(), ac: this.data.ac.length, ships: this.data.ships.length });
    this.hist = this.hist.filter((h) => Date.now() - h.t < 3600e3);
    this.renderTree(); this.hooks.counts(this.data);
    if (this._detail) this._refreshDetail();
  }

  async loadEvents() {
    try {
      const d = await api("/api/events"); this.data.events = d.events; this._set("events", d.events);
      this.hooks.status("evt", d.events.length > 0, d.err || "");
      if (!this._detail) this.showFeed();
      this.renderTree();
    } catch (e) { this.hooks.status("evt", false, e.message); }
  }

  _set(id, rows) {
    this.map.getSource(id).setData({ type: "FeatureCollection", features: rows.map((r) => ({ type: "Feature", properties: r, geometry: { type: "Point", coordinates: [r.lon, r.lat] } })) });
  }

  ring(km = [100, 250, 500]) {
    const c = this.map.getCenter(), feats = km.map((r) => {
      const pts = []; for (let i = 0; i <= 96; i++) { const a = (i / 96) * 2 * Math.PI; const dlat = (r / 111.32) * Math.cos(a); const dlon = (r / (111.32 * Math.cos((c.lat * Math.PI) / 180))) * Math.sin(a); pts.push([c.lng + dlon, c.lat + dlat]); }
      return { type: "Feature", properties: { km: r }, geometry: { type: "Polygon", coordinates: [pts] } };
    });
    this.rings.push(...feats); this.map.getSource("rings").setData({ type: "FeatureCollection", features: this.rings });
    this.hooks.toast(`RNG ${km.join(" / ")} km at ${c.lat.toFixed(3)} ${c.lng.toFixed(3)}`); this.renderTree();
  }

  // ---------- inspector ----------
  showFeed() {
    this._detail = null; this.map.setFilter("sel", ["==", ["get", "id"], ""]);
    document.getElementById("d-type").textContent = "FEED"; document.getElementById("d-title").textContent = "EVT-G · last 60 min";
    document.getElementById("d-back").hidden = true; document.getElementById("d-tabs").hidden = true;
    const evs = [...this.data.events].filter((e) => this.f.cat.has(e.cat)).sort((a, b) => b.mentions - a.mentions).slice(0, 200);
    const body = document.getElementById("d-body");
    body.innerHTML = evs.length ? evs.map((e, i) => `<div class="ev" data-i="${i}"><span class="sw" style="background:${catColor[e.cat]}"></span><b>${esc(e.place || e.cc)}</b><span class="cat" style="color:${catColor[e.cat]}">${catCode[e.cat]}</span>
      <span class="t2"><span class="mono">E-${esc(e.id)}</span> · ${esc([e.a1, e.a2].filter(Boolean).join(" → ") || "—")} · MEN ${e.mentions} · TONE ${e.tone} · ${esc(String(e.ts).slice(8, 10) + ":" + String(e.ts).slice(10, 12))}Z</span></div>`).join("")
      : `<div class="empty">NO EVENTS</div>`;
    body.querySelectorAll(".ev").forEach((el) => el.onclick = () => { const e = evs[+el.dataset.i]; this.flyTo(e.lat, e.lon, 7); this.select("events", e); });
  }

  _refreshDetail() {
    const { kind, p } = this._detail; if (kind === "events") return;
    const list = kind === "ac" ? this.data.ac : this.data.ships; const cur = list.find((x) => String(x.id) === String(p.id));
    if (cur) { this._detail.p = cur; this._render(this._tab); }
  }

  select(kind, p) {
    if (typeof p.mil === "string") p = { ...p, mil: p.mil === "true", gnd: p.gnd === "true" };
    this._detail = { kind, p }; this._tab = "Overview";
    this.map.setFilter("sel", kind === "ac" ? ["==", ["get", "id"], p.id] : ["==", ["get", "id"], ""]);
    document.getElementById("d-back").hidden = false; this._render("Overview");
  }

  _render(tab) {
    const { kind, p } = this._detail; this._tab = tab;
    const L = (u, t) => `<a target="_blank" rel="noopener noreferrer" href="${esc(safeUrl(u))}">${esc(t)} ↗</a>`;
    const kv = (rows) => `<dl class="kv">${rows.map(([k, v, mono]) => `<dt>${esc(k)}</dt><dd class="${mono ? "mono" : ""}">${v}</dd>`).join("")}</dl>`;
    let type, title, sym, color, tabs;
    const loc = kv([["Lat", fmt(+p.lat, 5), 1], ["Lon", fmt(+p.lon, 5), 1], ["MGRS-ish", `${(+p.lat).toFixed(2)}N ${(+p.lon).toFixed(2)}E`, 1]]) +
      `<div class="links"><a href="#" data-fly>Center map</a><a href="#" data-ring>Range ring here</a></div>`;
    if (kind === "ac") {
      type = "AIR"; title = `A-${String(p.id).toUpperCase()}`; sym = "A"; color = { emg: C.red, mil: C.blue, gnd: C.t3, civ: C.t1 }[airCls(p)];
      tabs = {
        Overview: kv([["Callsign", esc(p.cs || "—"), 1], ["Class", AIR.find((x) => x[0] === airCls(p))[1], 1], ["Altitude", p.gnd ? "GND" : `${fmt(+p.alt, 0)} ft`, 1], ["Ground speed", `${fmt(+p.gs, 0)} kt`, 1], ["Track", `${fmt(+p.trk, 0)}°`, 1], ["Squawk", esc(p.sq || "—") + (["7500", "7600", "7700"].includes(p.sq) ? ` <span class="cat" style="color:${C.red}">EMG</span>` : ""), 1]]),
        Details: kv([["ICAO 24", esc(String(p.id).toUpperCase()), 1], ["Type", esc(p.type || "—"), 1], ["Registration", esc(p.reg || "—"), 1], ["Military flag", p.mil ? "YES" : "NO", 1], ["Country", esc(p.country || "—")]]),
        Location: loc,
        Source: kv([["Feed", "TRK-A", 1], ["Provider", esc(p.src)], ["Refresh", "10 s"]]) + `<div class="links">${L(`https://globe.adsb.lol/?icao=${encodeURIComponent(p.id)}`, "adsb.lol")}${p.cs ? L(`https://www.flightradar24.com/${encodeURIComponent(p.cs)}`, "FR24") : ""}</div>`,
      };
    } else if (kind === "ships") {
      type = "SEA"; title = `M-${p.id}`; sym = "M"; color = p.cls === "military" ? C.blue : C.steel;
      tabs = {
        Overview: kv([["Name", esc(p.name || "—")], ["Class", `${shipCode[p.cls] || "UNK"} <span class="dim">${esc(p.cls)}</span>`, 1], ["Speed", `${fmt(+p.sog, 1)} kn`, 1], ["Course", `${fmt(+p.cog, 0)}°`, 1], ["Heading", `${fmt(+p.hdg, 0)}°`, 1], ["Destination", esc(p.dest || "—"), 1]]),
        Details: kv([["MMSI", esc(p.id), 1], ["IMO", esc(p.imo || "—"), 1], ["Callsign", esc(p.callsign || "—"), 1], ["Last report", p.ts ? ago(+p.ts) : "—"]]),
        Location: loc,
        Source: kv([["Feed", "TRK-M", 1], ["Provider", "aisstream.io"]]) + `<div class="links">${L(`https://www.marinetraffic.com/en/ais/details/ships/mmsi:${encodeURIComponent(p.id)}`, "MarineTraffic")}${L(`https://www.vesselfinder.com/vessels/details/${encodeURIComponent(p.id)}`, "VesselFinder")}</div>`,
      };
    } else {
      type = "EVT"; title = `E-${p.id}`; sym = "E"; color = catColor[p.cat];
      tabs = {
        Overview: kv([["Location", esc(p.place)], ["Category", `<span class="cat" style="color:${catColor[p.cat]}">${catCode[p.cat]}</span> ${esc(p.cat)}`], ["Actors", esc([p.a1, p.a2].filter(Boolean).join(" → ") || "—")], ["Mentions", esc(p.mentions), 1], ["Tone", esc(p.tone), 1], ["Goldstein", fmt(+p.gold, 1), 1]]),
        Details: kv([["CAMEO", esc(p.code), 1], ["Country", esc(p.cc), 1], ["Added", esc(String(p.ts).replace(/(\d{4})(\d\d)(\d\d)(\d\d)(\d\d).*/, "$1-$2-$3 $4:$5Z")), 1]]) + `<div class="note">Machine-coded from news. One event is a lead; a cluster is signal.</div>`,
        Location: loc,
        Source: kv([["Feed", "EVT-G", 1], ["Provider", "GDELT 2.0"]]) + `<div class="links">${L(p.url, "Source article")}</div>`,
      };
    }
    document.getElementById("d-type").textContent = type; document.getElementById("d-title").textContent = title;
    const tb = document.getElementById("d-tabs"); tb.hidden = false;
    tb.innerHTML = Object.keys(tabs).map((t) => `<button class="${t === tab ? "on" : ""}">${t}</button>`).join("");
    tb.querySelectorAll("button").forEach((b) => b.onclick = () => this._render(b.textContent));
    const name = kind === "ac" ? p.cs || p.type || "Aircraft" : kind === "ships" ? p.name || "Vessel" : p.place;
    const body = document.getElementById("d-body");
    body.innerHTML = `<div class="ent"><span class="sym" style="background:${color}">${sym}</span><div><div class="id">${esc(title)}</div><div class="nm">${esc(name)}</div></div></div>` + tabs[tab];
    body.querySelector("[data-fly]")?.addEventListener("click", (e) => { e.preventDefault(); this.flyTo(+p.lat, +p.lon, 8); });
    body.querySelector("[data-ring]")?.addEventListener("click", (e) => { e.preventDefault(); this.map.jumpTo({ center: [+p.lon, +p.lat] }); this.ring(); });
  }

  // ---------- timeline ----------
  drawTimeline() {
    const cv = document.getElementById("tl-canvas"); if (!cv || !cv.offsetWidth) return;
    const dpr = window.devicePixelRatio || 1, W = cv.offsetWidth, H = cv.offsetHeight;
    if (cv.width !== W * dpr || cv.height !== H * dpr) { cv.width = W * dpr; cv.height = H * dpr; }
    const g = cv.getContext("2d"); g.setTransform(dpr, 0, 0, dpr, 0, 0); g.clearRect(0, 0, W, H);
    const now = Date.now(), span = 3600e3, x = (t) => ((t - (now - span)) / span) * (W - 8) + 4;
    const rows = [["EVT-G", 4, 36], ["TRK-A", 44, 22], ["TRK-M", 70, 22]];
    g.font = "10px ui-monospace, monospace";
    for (const [, y, h] of rows) { g.fillStyle = "#151920"; g.fillRect(0, y, W, h); }
    // axis ticks every 10 min
    g.fillStyle = "#5C6570"; g.strokeStyle = "#2A3038";
    for (let m = 0; m <= 60; m += 5) {
      const t = now - span + m * 60e3, X = x(t); g.beginPath(); g.moveTo(X + 0.5, 0); g.lineTo(X + 0.5, m % 10 ? 4 : H - 12); g.stroke();
      if (m % 10 === 0 && m < 60) g.fillText(new Date(t).toISOString().slice(11, 16), X + 3, H - 2);
    }
    // events: stacked bars per 15-min slot by category
    const slots = {};
    for (const e of this.data.events) {
      const s = String(e.ts); let t = Date.UTC(+s.slice(0, 4), +s.slice(4, 6) - 1, +s.slice(6, 8), +s.slice(8, 10), +s.slice(10, 12));
      if (isNaN(t)) continue; t -= t % 900e3; (slots[t] ||= {})[e.cat] = (slots[t][e.cat] || 0) + 1;
    }
    const smax = Math.max(1, ...Object.values(slots).map((o) => Object.values(o).reduce((a, b) => a + b, 0)));
    for (const [t, o] of Object.entries(slots)) {
      let y = 40; const x0 = x(+t), x1 = x(+t + 15 * 60e3);
      for (const [k, , col] of CATS) { const n = o[k] || 0; if (!n) continue; const h = (n / smax) * 34; g.fillStyle = col; g.globalAlpha = 0.85; g.fillRect(x0 + 1, y - h, Math.max(2, x1 - x0 - 2), h); y -= h; }
      g.globalAlpha = 1;
    }
    // tracks: step lines
    const line = (key, y0, h, col) => {
      const pts = this.hist.filter((p) => p.t > now - span); if (!pts.length) return;
      const mx = Math.max(1, ...pts.map((p) => p[key])); g.strokeStyle = col; g.fillStyle = col; g.globalAlpha = 0.25; g.beginPath(); g.moveTo(x(pts[0].t), y0 + h);
      pts.forEach((p) => g.lineTo(x(p.t), y0 + h - 2 - (p[key] / mx) * (h - 4))); g.lineTo(x(now), y0 + h - 2 - (pts[pts.length - 1][key] / mx) * (h - 4)); g.lineTo(x(now), y0 + h); g.fill();
      g.globalAlpha = 1; g.beginPath(); pts.forEach((p, i) => (i ? g.lineTo : g.moveTo).call(g, x(p.t), y0 + h - 2 - (p[key] / mx) * (h - 4))); g.stroke();
    };
    line("ac", 44, 22, C.t1); line("ships", 70, 22, C.steel);
    for (const [label, y] of rows) { g.fillStyle = "#8A939E"; g.fillText(label, 6, y + 11); }
    g.strokeStyle = "#F1F1EE"; g.beginPath(); g.moveTo(x(now) + 0.5, 0); g.lineTo(x(now) + 0.5, H - 12); g.stroke();
    document.getElementById("tl-now").textContent = new Date().toISOString().replace("T", " ").slice(0, 19) + "Z";
    const ev = {}; this.data.events.forEach((e) => (ev[e.cat] = (ev[e.cat] || 0) + 1));
    document.getElementById("tl-legend").innerHTML = CATS.map(([k, c, col]) => `<div><i style="background:${col}"></i>${c}<span>${ev[k] || 0}</span></div>`).join("") +
      `<div><i style="background:${C.t1}"></i>AIR<span>${this.data.ac.length}</span></div><div><i style="background:${C.steel}"></i>SEA<span>${this.data.ships.length}</span></div>`;
  }

  flyTo(lat, lon, zoom = 6) { this.map.flyTo({ center: [lon, lat], zoom, speed: 1.6 }); }
  findAircraft(q) { q = q.toUpperCase().replace(/\s|^A-/g, ""); return this.data.ac.find((a) => (a.cs || "").toUpperCase() === q || String(a.id).toUpperCase() === q || (a.reg || "").toUpperCase() === q); }
  findShip(q) { q = q.toUpperCase().replace(/^M-/, ""); return this.data.ships.find((s) => (s.name || "").toUpperCase().includes(q) || String(s.id) === q); }
  resize() { this.map.resize(); this.drawTimeline(); }
}
