// Shell: menus, workspaces, command line, status bar, key guide.
import { api, esc, toast } from "./api.js";
import { WorldMap, BASEMAPS, CATS, SHIPS, AIR } from "./map.js";
import { Markets } from "./markets.js";
import { Analyst } from "./analyst.js";
import { Osint } from "./osint.js";

const WS = { map: ["Operations", "Map, aircraft, ships and events"], markets: ["Markets", "Prices and history"], analyst: ["Analyst", "Questions and standing watches"], osint: ["Investigations", "Cases, subjects and audit log"], settings: ["Settings", "Keys and data feeds"] };
const feed = { air: "—", sea: "—", evt: "—" };
const hooks = {
  status(k, ok, why = "") {
    const el = document.getElementById(`st-${k}`); el.classList.toggle("live", !!ok); el.classList.toggle("warn", !ok && !!why);
    el.title = `${el.title.split(" — ")[0]}${why ? " — " + why : ""}`; if (k in feed) feed[k] = ok ? "live" : why || "down"; sbFeeds();
  },
  show, toast, fly(lat, lon, zoom, label) { show("map"); map.flyTo(lat, lon, zoom || 6); if (label) toast(label); },
  ask: (q) => analyst.ask(q), coords: (s) => (document.getElementById("sb-coords").textContent = s),
  counts: (d) => (document.getElementById("sb-counts").innerHTML = `Aircraft <b>${d.ac.length.toLocaleString()}</b> Ships <b>${d.ships.length.toLocaleString()}</b> Events <b>${d.events.length.toLocaleString()}</b>`),
  feedState: () => feed,
};
const map = new WorldMap("map", hooks);
const markets = new Markets(hooks);
const analyst = new Analyst(hooks);
const osint = new Osint(hooks);
let current = "map";

function sbFeeds() {
  const f = (k, c) => `<span class="${feed[k] === "live" ? "live" : "warn"}" title="${esc(String(feed[k]))}"><i></i>${c}</span>`;
  document.getElementById("sb-feeds").innerHTML = f("air", "Aircraft") + f("sea", "Ships") + f("evt", "Events");
}

function show(v) {
  current = v;
  document.querySelectorAll(".view").forEach((x) => x.classList.toggle("on", x.id === `v-${v}`));
  document.querySelectorAll(".rail button[data-view]").forEach((b) => b.classList.toggle("on", b.dataset.view === v));
  document.getElementById("ws-title").textContent = WS[v][0]; document.getElementById("ws-sub").textContent = WS[v][1];
  document.getElementById("sb-ws").textContent = WS[v][0];
  if (v === "map") map.resize();
  if (v === "markets" && !markets._loaded) { markets._loaded = true; markets.load(); }
  if (v === "analyst") analyst.loadWatches();
  if (v === "settings") loadKeys();
}
document.querySelectorAll(".rail button[data-view]").forEach((b) => b.onclick = () => show(b.dataset.view));

// ---- menus & actions ----
const BASE_ORDER = Object.keys(BASEMAPS);
function act(a) {
  const [k, v] = a.split(":");
  if (k === "view") show(v);
  else if (k === "base") { show("map"); map.setBase(v); }
  else if (a === "base-cycle") map.setBase(BASE_ORDER[(BASE_ORDER.indexOf(map.base) + 1) % BASE_ORDER.length]);
  else if (a === "3d") map.treeClick("ovl", "terrain3d");
  else if (a === "mono") map.treeClick("ovl", "mono");
  else if (a === "home") map.map.flyTo({ center: [20, 30], zoom: 2.4, pitch: 0, bearing: 0 });
  else if (a === "ring") map.ring();
  else if (k === "toggle") { document.body.classList.toggle(`no-${v}`); setTimeout(() => map.resize(), 50); }
  else if (a === "cmd") document.getElementById("cmd").focus();
  else if (a === "help") document.getElementById("help").hidden = !document.getElementById("help").hidden;
  else if (a === "reload") location.reload();
  else if (a === "export-audit") location.href = "/api/osint/audit/export";
}
document.querySelectorAll("[data-act]").forEach((el) => el.addEventListener("click", (e) => { e.preventDefault(); act(el.dataset.act); closeMenus(); }));
const closeMenus = () => document.querySelectorAll(".menu.open").forEach((m) => m.classList.remove("open"));
document.querySelectorAll(".menu>button").forEach((b) => {
  b.onclick = (e) => { e.stopPropagation(); const m = b.parentElement, was = m.classList.contains("open"); closeMenus(); if (!was) m.classList.add("open"); };
  b.onmouseenter = () => { if (document.querySelector(".menu.open") && !b.parentElement.classList.contains("open")) { closeMenus(); b.parentElement.classList.add("open"); } };
});
document.addEventListener("click", closeMenus);

// ---- key guide ----
const GUIDE = [
  ["Workspaces", [["1", "Operations: map with aircraft, ships and conflict events"], ["2", "Markets: any instrument with price history"], ["3", "Analyst: ask questions, set standing watches"], ["4", "Investigations: cases, subjects and audit log"]]],
  ["Map", [["[  ]", "Hide or show the layer panel and inspector"], ["T", "Hide or show the timeline"], ["B", "Next basemap"], ["H", "World view"], ["R", "Range rings at map centre"]]],
  ["Event colours", [["Amber", "Protest, coercion"], ["Red", "Assault, fighting, mass violence"], ["Blue aircraft", "Military"], ["Red aircraft", "Emergency squawk 7500/7600/7700"]]],
  ["Command line", [["AAPL  GC=F  BTC-USD", "Open an instrument"], ["goto <place | lat,lon>", "Move the map"], ["fly <callsign | hex>", "Find an aircraft"], ["ship <name | MMSI>", "Find a vessel"], ["who <name>", "Add a subject to the open case"], ["watch <topic>", "Create a standing watch"], ["ask <question>  or end with ?", "Ask the analyst"], ["sat  ter  drk  off", "Switch basemap"]]],
  ["General", [["/", "Command line"], ["?", "This guide"], ["Esc", "Close menus and dialogs"]]],
];
document.getElementById("help-body").innerHTML = [GUIDE.filter((_, i) => i % 2 === 0), GUIDE.filter((_, i) => i % 2 === 1)]
  .map((col) => `<section>${col.map(([h, rows]) => `<div class="sect">${esc(h)}</div><dl class="kv">${rows.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`).join("")}</dl>`).join("")}</section>`).join("");
document.getElementById("help").onclick = (e) => { if (e.target.id === "help") act("help"); };

// ---- command line ----
const HINT = GUIDE.find((g) => g[0] === "Command line")[1];
const cmd = document.getElementById("cmd"), hint = document.getElementById("cmd-hint");
hint.innerHTML = HINT.map(([a, b]) => `<div><b>${esc(a)}</b><span>${esc(b)}</span></div>`).join("");
cmd.onfocus = () => hint.classList.add("on");
cmd.onblur = () => setTimeout(() => hint.classList.remove("on"), 150);
cmd.onkeydown = async (e) => {
  if (e.key === "Escape") { cmd.blur(); return; }
  if (e.key !== "Enter") return;
  const raw = cmd.value.trim(); if (!raw) return; cmd.value = ""; cmd.blur();
  const [head, ...rest] = raw.split(/\s+/); const arg = rest.join(" "); const h = head.toLowerCase();
  const bases = Object.fromEntries(Object.entries(BASEMAPS).map(([k, b]) => [b.code.toLowerCase(), k]));
  Object.assign(bases, { dark: "dark", sat: "sat", satellite: "sat", terrain: "terrain", offline: "outline", today: "today" });
  try {
    if (bases[h] && !arg) { show("map"); map.setBase(bases[h]); return; }
    if ((h === "goto" || h === "go") && arg) {
      const m = arg.match(/^(-?\d+(?:\.\d+)?)\s*,?\s+?(-?\d+(?:\.\d+)?)$/) || arg.match(/^(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)$/);
      if (m) { hooks.fly(+m[1], +m[2], 8); return; }
      const g = await api(`/api/geocode?q=${encodeURIComponent(arg)}`);
      if (!g.results.length) { toast(`No place: ${arg}`); return; }
      const r = g.results[0]; show("map");
      if (r.bbox) map.map.fitBounds([[r.bbox[2], r.bbox[0]], [r.bbox[3], r.bbox[1]]], { maxZoom: 11, duration: 1800 }); else map.flyTo(r.lat, r.lon, 8);
      toast(r.name); return;
    }
    if ((h === "fly" || h === "ship") && arg) { show("map"); map.search(arg); return; }
    if (h === "who" && arg) { osint.prefill(arg); return; }
    if (h === "watch" && arg) { await api("/api/watches", { method: "POST", body: { topic: arg } }); show("analyst"); toast("Watch added"); return; }
    if (h === "ask" || raw.endsWith("?")) { analyst.ask(h === "ask" ? arg : raw); return; }
    if (/^[\^A-Za-z0-9.=-]{1,15}$/.test(raw) && !rest.length) { markets.open(raw); return; }
    analyst.ask(raw);
  } catch (err) { toast(err.message, 4000); }
};
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") { document.getElementById("help").hidden = true; closeMenus(); }
  if (["INPUT", "TEXTAREA", "SELECT"].includes(document.activeElement.tagName) || e.ctrlKey || e.metaKey || e.altKey) return;
  const k = e.key;
  if (k === "/") { e.preventDefault(); cmd.focus(); return; }
  const v = { 1: "map", 2: "markets", 3: "analyst", 4: "osint" }[k]; if (v) { show(v); return; }
  if (k === "?") act("help");
  if (current !== "map") return;
  if (k === "[") act("toggle:lp"); if (k === "]") act("toggle:rp"); if (k === "t" || k === "T") act("toggle:tl");
  if (k === "b" || k === "B") act("base-cycle"); if (k === "h" || k === "H") act("home"); if (k === "r" || k === "R") act("ring");
});

// ---- clocks, status, keys ----
function clocks() {
  const d = new Date();
  document.getElementById("clk-utc").textContent = d.toISOString().slice(11, 19);
  document.getElementById("band-clock").textContent = d.toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short" }).replace(",", "") + "  " + d.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
  document.getElementById("clk-loc").textContent = d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false });
}
document.getElementById("clk-tz").textContent = " " + (Intl.DateTimeFormat().resolvedOptions().timeZone || "LCL").split("/").pop().replace(/_/g, " ").slice(0, 14);
clocks(); setInterval(clocks, 1000);

let K = {};
async function status() {
  try {
    const s = await api("/api/status"); K = s;
    document.getElementById("demo-badge").hidden = !s.demo;
    document.getElementById("band-mode").textContent = s.demo ? "Demo data" : "Live data";
    document.getElementById("anl-model").textContent = `${s.model} · ${s.analyst ? "Ready" : "No key set"}`;
    hooks.status("ai", s.analyst, s.analyst ? "" : "needs Claude key");
    if (!s.demo && !s.keys.aisstream) hooks.status("sea", false, "needs aisstream key");
  } catch {}
}
async function loadKeys() {
  await status();
  const desc = { anthropic: "Analyst and standing watches", aisstream: "Ship tracks", hibp: "Breach checks", opensky_user: "OpenSky account (optional)", opensky_pass: "OpenSky password (optional)", opensanctions: "Sanctions and PEP checks (phase 2)" };
  document.getElementById("keys").innerHTML = Object.entries(K.keys || {}).map(([k, ok]) =>
    `<tr><td>${esc(k)}</td><td>${esc(desc[k] || "")}</td><td class="r">${ok ? '<span class="ok">Set</span>' : `<code>meridian-intel keys set ${esc(k)}</code>`}</td></tr>`).join("") +
    `<tr><td>Ships</td><td>aisstream.io</td><td class="r">${esc(K.ships)} · ${(K.ship_msgs || 0).toLocaleString()} msgs</td></tr>
     <tr><td>Events</td><td>GDELT</td><td class="r">${K.events_err ? esc(K.events_err) : K.events_age != null ? `${Math.round(K.events_age / 60)} min ago` : K.demo ? "demo" : "loading"}</td></tr>
     <tr><td>Analyst</td><td>${esc(K.model)}</td><td class="r">${K.analyst ? '<span class="ok">Ready</span>' : "No key set"}</td></tr>`;
}
status(); setInterval(status, 30000); sbFeeds();
markets.loadWatchlist(); setInterval(() => markets.loadWatchlist(), 60000);
osint.init();
