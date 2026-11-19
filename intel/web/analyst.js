// Analyst chat + topic watches.
import { api, esc, ago, toast } from "./api.js";

export class Analyst {
  constructor(hooks) {
    this.hooks = hooks;
    const f = document.getElementById("chat-form"), inp = document.getElementById("chat-in");
    f.onsubmit = (e) => { e.preventDefault(); const q = inp.value.trim(); if (q) { inp.value = ""; this.ask(q); } };
    inp.onkeydown = (e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); f.requestSubmit(); } };
    document.getElementById("w-form").onsubmit = async (e) => {
      e.preventDefault(); const fd = Object.fromEntries(new FormData(e.target));
      await api("/api/watches", { method: "POST", body: fd }); e.target.reset(); toast("Watch added"); this.loadWatches();
    };
    this._msg("a", "Ask about markets, aircraft, ships, conflicts or news. I use the live feeds and can move the map or set up a watch.");
  }

  _msg(who, text, wait) {
    const log = document.getElementById("chat-log"), d = document.createElement("div");
    d.className = `msg ${who}${wait ? " wait" : ""}`; d.textContent = text; log.appendChild(d); log.scrollTop = log.scrollHeight; return d;
  }

  async ask(q) {
    this.hooks.show("analyst"); this._msg("u", q);
    const w = this._msg("a", "Checking the feeds…", true);
    try {
      const r = await api("/api/ask", { method: "POST", body: { q } });
      w.classList.remove("wait"); w.textContent = r.answer;
      for (const a of r.actions || []) {
        if (a.type === "fly") { this.hooks.fly(a.lat, a.lon, a.zoom, a.label); }
        if (a.type === "watches") this.loadWatches();
      }
      this.hooks.status("ai", !r.needs_key);
    } catch (e) { w.classList.remove("wait"); w.textContent = `Error: ${e.message}`; }
  }

  async loadWatches() {
    const d = await api("/api/watches");
    const el = document.getElementById("w-list");
    el.innerHTML = d.watches.length ? d.watches.map((w) => `<div class="card" data-id="${w.id}"><div class="ch"><b>${esc(w.topic)}</b>
      <button class="mini" data-run>Run now</button><button class="mini" data-del>Remove</button></div>
      <div class="muted" style="font-size:12px">${esc(w.query)}${w.symbols.length ? " · " + esc(w.symbols.join(", ")) : ""}${w.last_run ? " · checked " + ago(w.last_run) : " · not run yet"}</div>
      ${w.digests.slice(0, 2).map((g) => `<div class="digest"><time>${new Date(g.ts * 1000).toLocaleString()}</time>${esc(g.body)}</div>`).join("")}</div>`).join("")
      : `<div class="muted">No watches yet.${d.analyst ? "" : " The analyst needs a Claude API key to run them (Keys tab)."}</div>`;
    el.querySelectorAll(".card").forEach((c) => {
      c.querySelector("[data-del]").onclick = async () => { await api(`/api/watches/${c.dataset.id}`, { method: "DELETE" }); this.loadWatches(); };
      c.querySelector("[data-run]").onclick = async (e) => {
        e.target.textContent = "Running…";
        try { await api(`/api/watches/${c.dataset.id}/run`, { method: "POST" }); } catch (err) { toast(err.message, 4000); }
        this.loadWatches();
      };
    });
  }
}
