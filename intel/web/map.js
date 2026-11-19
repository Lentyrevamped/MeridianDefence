// World map: basemaps, aircraft, ships, conflict events, details drawer.
import { api, esc, safeUrl, fmt, ago } from "./api.js";

maplibregl.setWorkerUrl("/static/vendor/maplibre-gl-csp-worker.js");

const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
const BASEMAPS = {
  dark: { tiles: ["a", "b", "c", "d"].map((s) => `https://${s}.basemaps.cartocdn.com/dark_nolabels/{z}/{x}/{y}@2x.png`), max: 20,
    labels: ["a", "b", "c", "d"].map((s) => `https://${s}.basemaps.cartocdn.com/dark_only_labels/{z}/{x}/{y}@2x.png`),
    attr: '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> © <a href="https://carto.com/attributions">CARTO</a>' },
  sat: { tiles: ["https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}"], max: 19,
    labels: ["https://server.arcgisonline.com/ArcGIS/rest/services/Reference/World_Boundaries_and_Places/MapServer/tile/{z}/{y}/{x}"],
    attr: "Imagery © Esri, Maxar, Earthstar Geographics" },
  s2: { tiles: ["https://tiles.maps.eox.at/wmts/1.0.0/s2cloudless-2024_3857/default/g/{z}/{y}/{x}.jpg"], max: 16,
    labels: ["https://server.arcgisonline.com/ArcGIS/rest/services/Reference/World_Boundaries_and_Places/MapServer/tile/{z}/{y}/{x}"],
    attr: 'Sentinel-2 cloudless 2024 by <a href="https://s2maps.eu">EOX</a> (Copernicus data)' },
  today: { tiles: [`https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/VIIRS_SNPP_CorrectedReflectance_TrueColor/default/${yesterday}/GoogleMapsCompatible_Level9/{z}/{y}/{x}.jpg`], max: 9,
    labels: ["https://server.arcgisonline.com/ArcGIS/rest/services/Reference/World_Boundaries_and_Places/MapServer/tile/{z}/{y}/{x}"],
    attr: `NASA GIBS · VIIRS true colour ${yesterday}` },
  terrain: { tiles: null, attr: "Terrain: AWS Terrain Tiles (Mapzen) · Natural Earth" },
  outline: { tiles: null, attr: "Natural Earth (offline)" },
};

function planeIcon(size = 48) {
  const c = document.createElement("canvas"); c.width = c.height = size; const g = c.getContext("2d");
  g.translate(size / 2, size / 2); g.scale(size / 48, size / 48); g.fillStyle = "#fff"; g.beginPath();
  g.moveTo(0, -20); g.lineTo(3, -12); g.lineTo(3, -4); g.lineTo(18, 4); g.lineTo(18, 8); g.lineTo(3, 4); g.lineTo(2.5, 13);
  g.lineTo(7, 17); g.lineTo(7, 20); g.lineTo(0, 18); g.lineTo(-7, 20); g.lineTo(-7, 17); g.lineTo(-2.5, 13); g.lineTo(-3, 4);
  g.lineTo(-18, 8); g.lineTo(-18, 4); g.lineTo(-3, -4); g.lineTo(-3, -12); g.closePath(); g.fill();
  return g.getImageData(0, 0, size, size);
}
function shipIcon(size = 32) {
  const c = document.createElement("canvas"); c.width = c.height = size; const g = c.getContext("2d");
  g.translate(size / 2, size / 2); g.fillStyle = "#fff"; g.beginPath();
  g.moveTo(0, -12); g.lineTo(6, 2); g.lineTo(5, 11); g.lineTo(-5, 11); g.lineTo(-6, 2); g.closePath(); g.fill();
  return g.getImageData(0, 0, size, size);
}

export class WorldMap {
  constructor(el, hooks) {
    this.hooks = hooks; this.base = "dark"; this.data = { ac: [], ships: [], events: [] };
    this.map = new maplibregl.Map({
      container: el, center: [20, 30], zoom: 2.4, hash: "map", attributionControl: false, maxPitch: 75,
      style: { version: 8, sources: {}, layers: [{ id: "bg", type: "background", paint: { "background-color": "#0A0A0C" } }] },
    });
    this.map.addControl(new maplibregl.NavigationControl({ visualizePitch: true }), "bottom-right");
    this.map.addControl(new maplibregl.ScaleControl({ unit: "metric" }), "bottom-right");
    this.map.on("load", () => this._init());
    this.map.on("mousemove", (e) => { document.getElementById("coords").textContent = `${e.lngLat.lat.toFixed(4)}, ${e.lngLat.lng.toFixed(4)} · z${this.map.getZoom().toFixed(1)}`; });
  }

  async _init() {
    const m = this.map;
    m.addImage("plane", planeIcon(), { sdf: true, pixelRatio: 2 });
    m.addImage("ship", shipIcon(), { sdf: true, pixelRatio: 2 });
    m.addSource("dem", { type: "raster-dem", tiles: ["https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png"], encoding: "terrarium", tileSize: 256, maxzoom: 14 });
    const countries = await fetch("/static/vendor/countries-110m.geojson").then((r) => r.json());
    m.addSource("countries", { type: "geojson", data: countries });
    for (const id of ["ac", "ships", "events"]) m.addSource(id, { type: "geojson", data: { type: "FeatureCollection", features: [] } });
    this.setBase(this.base);
    this._wire();
    this.refresh(true);
    setInterval(() => this.refresh(false), 10000);
    setInterval(() => this.loadEvents(), 300000);
  }

  setBase(name) {
    const m = this.map, b = BASEMAPS[name]; this.base = name;
    for (const id of ["base", "labels", "hill", "land", "borders"]) { if (m.getLayer(id)) m.removeLayer(id); }
    for (const id of ["base", "labels"]) { if (m.getSource(id)) m.removeSource(id); }
    const before = m.getLayer("events-glow") ? "events-glow" : undefined;
    const mono = document.getElementById("ly-mono").checked;
    if (b.tiles) {
      m.addSource("base", { type: "raster", tiles: b.tiles, tileSize: 256, maxzoom: b.max });
      m.addLayer({ id: "base", type: "raster", source: "base", paint: { "raster-saturation": mono || name === "dark" ? -1 : 0, "raster-fade-duration": 200 } }, before);
    } else {
      m.addLayer({ id: "land", type: "fill", source: "countries", paint: { "fill-color": "#141417", "fill-opacity": name === "terrain" ? 0.55 : 1 } }, before);
      if (name === "terrain") m.addLayer({ id: "hill", type: "hillshade", source: "dem", paint: { "hillshade-shadow-color": "#000", "hillshade-highlight-color": "#9a9aa2", "hillshade-accent-color": "#26262B", "hillshade-exaggeration": 0.6 } }, before);
    }
    if (document.getElementById("ly-lbl").checked) {
      if (b.labels) {
        m.addSource("labels", { type: "raster", tiles: b.labels, tileSize: 256, maxzoom: 19 });
        m.addLayer({ id: "labels", type: "raster", source: "labels", paint: { "raster-saturation": -1, "raster-opacity": 0.9 } }, before);
      } else {
        m.addLayer({ id: "borders", type: "line", source: "countries", paint: { "line-color": "#85858F", "line-width": 0.6, "line-opacity": 0.7 } }, before);
      }
    }
    document.getElementById("attrib").innerHTML = b.attr + " · Feeds: adsb.lol, OpenSky, aisstream.io, GDELT";
    document.querySelectorAll("#basemaps button").forEach((x) => x.classList.toggle("on", x.dataset.b === name));
  }

  _wire() {
    const m = this.map;
    m.addLayer({ id: "events-glow", type: "circle", source: "events", filter: ["==", ["get", "cat"], "mass violence"],
      paint: { "circle-radius": ["interpolate", ["linear"], ["zoom"], 2, 9, 8, 22], "circle-color": "#F1F1EE", "circle-opacity": 0.18, "circle-blur": 0.6 } });
    m.addLayer({ id: "events", type: "circle", source: "events", paint: {
      "circle-radius": ["interpolate", ["linear"], ["zoom"], 2, ["+", 2.5, ["*", 0.08, ["min", ["get", "mentions"], 40]]], 8, ["+", 5, ["*", 0.2, ["min", ["get", "mentions"], 40]]]],
      "circle-color": ["match", ["get", "cat"], "protest", "rgba(0,0,0,0)", "coercion", "#85858F", "assault", "#85858F", "#F1F1EE"],
      "circle-stroke-color": ["match", ["get", "cat"], "protest", "#F1F1EE", "#0A0A0C"], "circle-stroke-width": ["match", ["get", "cat"], "protest", 1.4, 0.6],
      "circle-opacity": 0.9 } });
    m.addLayer({ id: "ships", type: "symbol", source: "ships", layout: {
      "icon-image": "ship", "icon-size": ["interpolate", ["linear"], ["zoom"], 2, 0.45, 9, 0.9], "icon-rotate": ["get", "hdg"],
      "icon-rotation-alignment": "map", "icon-allow-overlap": true, "icon-ignore-placement": true },
      paint: { "icon-color": ["match", ["get", "cls"], "tanker", "#F1F1EE", "cargo", "#C8C8C4", "military", "#F1F1EE", "#85858F"], "icon-halo-color": "#0A0A0C", "icon-halo-width": 1 } });
    m.addLayer({ id: "ac", type: "symbol", source: "ac", layout: {
      "icon-image": "plane", "icon-size": ["interpolate", ["linear"], ["zoom"], 2, 0.42, 9, 0.85], "icon-rotate": ["get", "trk"],
      "icon-rotation-alignment": "map", "icon-allow-overlap": true, "icon-ignore-placement": true },
      paint: { "icon-color": ["case", ["get", "emerg"], "#FFFFFF", ["get", "mil"], "#F1F1EE", ["get", "gnd"], "#555", "#BDBDB8"],
        "icon-halo-color": ["case", ["get", "emerg"], "#F1F1EE", "#0A0A0C"], "icon-halo-width": ["case", ["get", "emerg"], 3, 1] } });
    const hover = new maplibregl.Popup({ closeButton: false, closeOnClick: false, offset: 10 });
    for (const id of ["ac", "ships", "events"]) {
      m.on("mouseenter", id, (e) => { m.getCanvas().style.cursor = "pointer"; const p = e.features[0].properties;
        hover.setLngLat(e.lngLat).setHTML(esc(id === "ac" ? (p.cs || p.id) : id === "ships" ? (p.name || p.id) : `${p.cat} · ${p.place}`)).addTo(m); });
      m.on("mouseleave", id, () => { m.getCanvas().style.cursor = ""; hover.remove(); });
      m.on("click", id, (e) => this.select(id, e.features[0].properties));
    }
    m.on("moveend", () => this.refresh(true));
    document.querySelectorAll("#basemaps button").forEach((b) => b.onclick = () => this.setBase(b.dataset.b));
    const vis = (id, on) => { for (const l of id === "events" ? ["events", "events-glow"] : [id]) m.setLayoutProperty(l, "visibility", on ? "visible" : "none"); };
    document.getElementById("ly-air").onchange = (e) => vis("ac", e.target.checked);
    document.getElementById("ly-sea").onchange = (e) => vis("ships", e.target.checked);
    document.getElementById("ly-evt").onchange = (e) => vis("events", e.target.checked);
    document.getElementById("ly-mil").onchange = () => this.refresh(true);
    document.getElementById("ly-lbl").onchange = () => this.setBase(this.base);
    document.getElementById("ly-mono").onchange = () => this.setBase(this.base);
    document.getElementById("ly-3d").onchange = (e) => {
      if (e.target.checked) { m.setTerrain({ source: "dem", exaggeration: 1.3 }); m.easeTo({ pitch: 60 }); }
      else { m.setTerrain(null); m.easeTo({ pitch: 0 }); }
    };
    document.getElementById("d-back").onclick = () => this.showFeed();
  }

  bbox() {
    const b = this.map.getBounds();
    const c = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
    let w = b.getWest(), e = b.getEast();
    if (e - w >= 360) { w = -180; e = 180; } else { w = c(w, -180, 179.9); e = c(e, w + 0.01, 180); }
    return { s: c(b.getSouth(), -90, 89.9).toFixed(3), w: w.toFixed(3), n: c(b.getNorth(), -89.9, 90).toFixed(3), e: e.toFixed(3) };
  }

  async refresh(force) {
    if (!this.map.getSource("ac")) return;
    const now = Date.now(); if (!force && now - (this._last || 0) < 9000) return; this._last = now;
    const q = new URLSearchParams(this.bbox()).toString();
    const mil = document.getElementById("ly-mil").checked;
    const tasks = [];
    if (document.getElementById("ly-air").checked) tasks.push(api(`/api/aircraft?${q}${mil ? "&mil=true" : ""}`).then((d) => {
      this.data.ac = d.ac; this._set("ac", d.ac.map((a) => ({ ...a, emerg: ["7500", "7600", "7700"].includes(a.sq) })));
      document.getElementById("n-air").textContent = d.ac.length.toLocaleString(); this.hooks.status("air", true);
    }).catch((e) => this.hooks.status("air", false, e.message)));
    if (document.getElementById("ly-sea").checked) tasks.push(api(`/api/ships?${q}`).then((d) => {
      this.data.ships = d.ships; this._set("ships", d.ships);
      document.getElementById("n-sea").textContent = d.ships.length.toLocaleString();
      this.hooks.status("sea", d.status === "live" || d.status === "demo", d.status);
    }).catch((e) => this.hooks.status("sea", false, e.message)));
    if (!this.data.events.length) tasks.push(this.loadEvents());
    await Promise.all(tasks);
  }

  async loadEvents() {
    try {
      const d = await api("/api/events"); this.data.events = d.events; this._set("events", d.events);
      document.getElementById("n-evt").textContent = d.events.length.toLocaleString();
      this.hooks.status("evt", d.events.length > 0, d.err || "");
      if (!this._detail) this.showFeed();
    } catch (e) { this.hooks.status("evt", false, e.message); }
  }

  _set(id, rows) {
    this.map.getSource(id).setData({ type: "FeatureCollection", features: rows.map((r) => ({ type: "Feature", properties: r, geometry: { type: "Point", coordinates: [r.lon, r.lat] } })) });
  }

  showFeed() {
    this._detail = null; document.getElementById("d-title").textContent = "Conflict feed · last hour"; document.getElementById("d-back").hidden = true;
    const evs = [...this.data.events].sort((a, b) => b.mentions - a.mentions).slice(0, 150);
    const body = document.getElementById("d-body");
    body.innerHTML = evs.length ? evs.map((e, i) => `<div class="ev" data-i="${i}"><div class="t"><b>${esc(e.place || e.cc)}</b><span class="cat ${["fighting", "mass violence"].includes(e.cat) ? "hot" : ""}">${esc(e.cat)}</span></div>
      <div class="m">${esc([e.a1, e.a2].filter(Boolean).join(" → ") || "—")} · ${e.mentions} mentions · tone ${e.tone}</div></div>`).join("")
      : `<div class="empty">No events yet.</div>`;
    body.querySelectorAll(".ev").forEach((el) => el.onclick = () => { const e = evs[+el.dataset.i]; this.flyTo(e.lat, e.lon, 7); this.select("events", e); });
  }

  select(kind, p) {
    this._detail = p; document.getElementById("d-back").hidden = false;
    const t = document.getElementById("d-title"), body = document.getElementById("d-body");
    if (kind === "ac") {
      t.textContent = "Aircraft";
      body.innerHTML = `<div class="big">${esc(p.cs || p.id)}</div><dl class="kv">
        <dt>ICAO hex</dt><dd>${esc(p.id)}</dd><dt>Type</dt><dd>${esc(p.type || "—")}</dd><dt>Registration</dt><dd>${esc(p.reg || "—")}</dd>
        <dt>Altitude</dt><dd>${p.gnd === true || p.gnd === "true" ? "on ground" : fmt(+p.alt, 0) + " ft"}</dd><dt>Ground speed</dt><dd>${fmt(+p.gs, 0)} kt</dd>
        <dt>Track</dt><dd>${fmt(+p.trk, 0)}°</dd><dt>Squawk</dt><dd>${esc(p.sq || "—")}${["7500", "7600", "7700"].includes(p.sq) ? " · EMERGENCY" : ""}</dd>
        <dt>Military</dt><dd>${p.mil === true || p.mil === "true" ? "yes" : "no"}</dd><dt>Source</dt><dd>${esc(p.src)}</dd></dl>
        <div class="links"><a target="_blank" rel="noopener noreferrer" href="https://globe.adsb.lol/?icao=${encodeURIComponent(p.id)}">adsb.lol globe</a>
        <a target="_blank" rel="noopener noreferrer" href="https://www.flightradar24.com/${encodeURIComponent(p.cs || "")}">Flightradar24</a></div>`;
    } else if (kind === "ships") {
      t.textContent = "Vessel";
      body.innerHTML = `<div class="big">${esc(p.name || "Unknown vessel")}</div><dl class="kv">
        <dt>MMSI</dt><dd>${esc(p.id)}</dd><dt>Class</dt><dd>${esc(p.cls)}</dd><dt>Speed</dt><dd>${fmt(+p.sog, 1)} kn</dd>
        <dt>Course</dt><dd>${fmt(+p.cog, 0)}°</dd><dt>Destination</dt><dd>${esc(p.dest || "—")}</dd>
        <dt>Last report</dt><dd>${p.ts ? ago(+p.ts) : "—"}</dd></dl>
        <div class="links"><a target="_blank" rel="noopener noreferrer" href="https://www.marinetraffic.com/en/ais/details/ships/mmsi:${encodeURIComponent(p.id)}">MarineTraffic</a>
        <a target="_blank" rel="noopener noreferrer" href="https://www.vesselfinder.com/vessels/details/${encodeURIComponent(p.id)}">VesselFinder</a></div>`;
    } else {
      t.textContent = "Event";
      body.innerHTML = `<div class="big">${esc(p.place)}</div><dl class="kv">
        <dt>Category</dt><dd>${esc(p.cat)} (CAMEO ${esc(p.code)})</dd><dt>Actors</dt><dd>${esc([p.a1, p.a2].filter(Boolean).join(" → ") || "—")}</dd>
        <dt>Mentions</dt><dd>${esc(p.mentions)}</dd><dt>Tone</dt><dd>${esc(p.tone)}</dd><dt>Goldstein</dt><dd>${fmt(+p.gold, 1)}</dd>
        <dt>Added</dt><dd>${esc(String(p.ts).replace(/(\d{4})(\d\d)(\d\d)(\d\d)(\d\d).*/, "$1-$2-$3 $4:$5 UTC"))}</dd></dl>
        <div class="links"><a target="_blank" rel="noopener noreferrer" href="${esc(safeUrl(p.url))}">Source article</a></div>
        <p class="muted" style="padding:0 12px;font-size:12px">GDELT codes events automatically from news. One dot is a lead; a cluster is a signal.</p>`;
    }
  }

  flyTo(lat, lon, zoom = 6) { this.map.flyTo({ center: [lon, lat], zoom, speed: 1.6 }); }

  findAircraft(q) {
    q = q.toUpperCase().replace(/\s/g, "");
    return this.data.ac.find((a) => (a.cs || "").toUpperCase() === q || a.id.toUpperCase() === q || (a.reg || "").toUpperCase() === q);
  }
  findShip(q) { q = q.toUpperCase(); return this.data.ships.find((s) => (s.name || "").toUpperCase().includes(q) || String(s.id) === q); }
  resize() { this.map.resize(); }
}
