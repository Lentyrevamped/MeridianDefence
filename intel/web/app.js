// Shell: views, command bar, ticker, status, clocks, keys.
import { api, esc, fmt, chg, toast } from "./api.js";
import { WorldMap } from "./map.js";
import { Markets } from "./markets.js";
import { Analyst } from "./analyst.js";
import { Osint } from "./osint.js";

const statusEl = (k) => document.getElementById(`st-${k}`);
const hooks = {
  status(k, ok, why = "") { const el = statusEl(k); el.classList.toggle("live", !!ok); el.classList.toggle("warn", !ok && !!why); if (why) el.title = `${el.textContent}: ${why}`; },
  show, fly(lat, lon, zoom, label) { show("map"); map.flyTo(lat, lon, zoom || 6); if (label) toast(label); },
  ask: (q) => analyst.ask(q), ticker,
};
const map = new WorldMap("map", hooks);
const markets = new Markets(hooks);
const analyst = new Analyst(hooks);
const osint = new Osint(hooks);

function show(v) {
  document.querySelectorAll(".view").forEach((x) => x.classList.toggle("on", x.id === `v-${v}`));
  document.querySelectorAll(".rail button").forEach((b) => b.classList.toggle("on", b.dataset.view === v));
  if (v === "map") map.resize();
  if (v === "markets" && !markets._loaded) { markets._loaded = true; markets.load(); }
  if (v === "analyst") analyst.loadWatches();
  if (v === "settings") loadKeys();
}
document.querySelectorAll(".rail button").forEach((b) => b.onclick = () => show(b.dataset.view));

function ticker(items) {
  const html = items.filter((i) => !i.error).map((i) => { const c = chg(i.price, i.prev);
    return `<span data-s="${esc(i.symbol)}"><b>${esc(i.label || i.symbol)}</b>${fmt(i.price)} <i class="${c.cls}">${c.txt}</i></span>`; }).join("");
  const t = document.getElementById("ticker"); t.innerHTML = html + html;
  t.querySelectorAll("[data-s]").forEach((s) => s.onclick = () => markets.open(s.dataset.s));
}

// ---- command bar ----
const HELP = [
  ["AAPL, BTC-USD, GC=F, EURUSD=X", "open a chart"], ["goto Taiwan Strait  /  goto 26.5,56.3", "fly the map"],
  ["fly BAW12  /  ship EVER GIVEN", "find an aircraft or vessel on the map"], ["who Elon Musk", "OSINT: add a subject to the open case"],
  ["ask …  or end with ?", "ask the analyst"], ["watch Red Sea shipping", "create a watch"],
  ["dark · sat · s2 · today · terrain · offline", "switch the map view"], ["1 2 3 4 (outside a field)", "switch screens"],
];
const cmd = document.getElementById("cmd"), hint = document.getElementById("cmd-hint");
hint.innerHTML = HELP.map(([a, b]) => `<div><b>${esc(a)}</b><span>${esc(b)}</span></div>`).join("");
cmd.onfocus = () => hint.classList.add("on");
cmd.onblur = () => setTimeout(() => hint.classList.remove("on"), 150);
cmd.onkeydown = async (e) => {
  if (e.key === "Escape") { cmd.blur(); return; }
  if (e.key !== "Enter") return;
  const raw = cmd.value.trim(); if (!raw) return; cmd.value = ""; cmd.blur();
  const [head, ...rest] = raw.split(/\s+/); const arg = rest.join(" "); const h = head.toLowerCase();
  const bases = { dark: "dark", sat: "sat", satellite: "sat", s2: "s2", sentinel: "s2", today: "today", terrain: "terrain", offline: "outline", outline: "outline" };
  try {
    if (bases[h] && !arg) { show("map"); map.setBase(bases[h]); return; }
    if ((h === "goto" || h === "go") && arg) {
      const m = arg.match(/^(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)$/);
      if (m) { hooks.fly(+m[1], +m[2], 8); return; }
      const g = await api(`/api/geocode?q=${encodeURIComponent(arg)}`);
      if (!g.results.length) { toast(`No place called “${arg}”`); return; }
      const r = g.results[0]; show("map");
      if (r.bbox) map.map.fitBounds([[r.bbox[2], r.bbox[0]], [r.bbox[3], r.bbox[1]]], { maxZoom: 11, duration: 1800 }); else map.flyTo(r.lat, r.lon, 8);
      toast(r.name); return;
    }
    if (h === "fly" && arg) { const a = map.findAircraft(arg); if (a) { hooks.fly(a.lat, a.lon, 8); map.select("ac", a); } else toast(`${arg} not in the current view; zoom out or ask the analyst`); return; }
    if (h === "ship" && arg) { const s = map.findShip(arg); if (s) { hooks.fly(s.lat, s.lon, 9); map.select("ships", s); } else toast(`${arg} not in the current view`); return; }
    if (h === "who" && arg) { osint.prefill(arg); return; }
    if (h === "watch" && arg) { await api("/api/watches", { method: "POST", body: { topic: arg } }); show("analyst"); toast("Watch added"); return; }
    if (h === "ask" || raw.endsWith("?")) { analyst.ask(h === "ask" ? arg : raw); return; }
    if (/^[\^A-Za-z0-9.=-]{1,15}$/.test(raw) && !rest.length) { markets.open(raw); return; }
    analyst.ask(raw);
  } catch (err) { toast(err.message, 4000); }
};
document.addEventListener("keydown", (e) => {
  if (["INPUT", "TEXTAREA", "SELECT"].includes(document.activeElement.tagName)) return;
  if (e.key === "/") { e.preventDefault(); cmd.focus(); }
  const v = { 1: "map", 2: "markets", 3: "analyst", 4: "osint" }[e.key]; if (v) show(v);
});

// ---- clocks & status ----
function clocks() {
  const d = new Date();
  document.getElementById("clk-utc").textContent = d.toISOString().slice(11, 16);
  document.getElementById("clk-loc").textContent = d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false });
}
document.getElementById("clk-tz").textContent = (Intl.DateTimeFormat().resolvedOptions().timeZone || "LOCAL").split("/").pop().replace(/_/g, " ").toUpperCase();
clocks(); setInterval(clocks, 10000);

let KEYINFO = {};
async function status() {
  try {
    const s = await api("/api/status"); KEYINFO = s;
    document.getElementById("demo-badge").hidden = !s.demo;
    hooks.status("ai", s.analyst, s.analyst ? "" : "needs Claude key");
    if (!s.demo && !s.keys.aisstream) hooks.status("sea", false, "needs aisstream key");
  } catch {}
}
async function loadKeys() {
  await status();
  const desc = { anthropic: "AI analyst and watches", aisstream: "Live ships", hibp: "Email breach checks", opensky_user: "OpenSky account (optional)", opensky_pass: "OpenSky password", opensanctions: "Sanctions/PEP (phase 2)" };
  document.getElementById("keys").innerHTML = Object.entries(KEYINFO.keys || {}).map(([k, ok]) =>
    `<tr><td>${esc(k)}</td><td>${esc(desc[k] || "")}</td><td>${ok ? "set" : `<code>meridian-intel keys set ${esc(k)}</code>`}</td></tr>`).join("") +
    `<tr><td>Ships feed</td><td>aisstream.io</td><td>${esc(KEYINFO.ships)} · ${(KEYINFO.ship_msgs || 0).toLocaleString()} msgs</td></tr>
     <tr><td>Conflict feed</td><td>GDELT</td><td>${KEYINFO.events_err ? esc(KEYINFO.events_err) : KEYINFO.events_age != null ? `updated ${Math.round(KEYINFO.events_age / 60)} min ago` : KEYINFO.demo ? "demo" : "loading"}</td></tr>
     <tr><td>Analyst model</td><td>${esc(KEYINFO.model)}</td><td>${KEYINFO.analyst ? "ready" : "needs key"}</td></tr>`;
}
status(); setInterval(status, 30000);
markets.loadWatchlist(); setInterval(() => markets.loadWatchlist(), 60000);
osint.init();
