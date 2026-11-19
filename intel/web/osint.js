// OSINT investigations: cases, subjects, guarded lookups, audit log.
import { api, esc, safeUrl, ago, toast } from "./api.js";

const MOD_LABEL = { profile: "PRF", news: "NWS", usernames: "USR", filings: "SEC", breach: "BRC", providers: "LIC" };
const MOD_NAME = { profile: "Profile", news: "News mentions", usernames: "Username sweep", filings: "SEC filings", breach: "Breach exposure", providers: "Licensed providers" };
const KIND = { public: "PUB", company: "ORG", private: "PRV" };
const MOD_HINT = {
  profile: "Wikidata + Wikipedia profile, official accounts", news: "News mentions, last 3 months (defaults to the name)",
  usernames: "Handle to sweep across ~45 platforms", filings: "SEC EDGAR full-text (defaults to the name)",
  breach: "Email address to check against known breaches", providers: "Licensed people-data providers",
};

export class Osint {
  constructor(hooks) {
    this.hooks = hooks; this.case = null; this.subject = null; this.module = null; this.meta = null;
    try { if (localStorage.getItem("mi-scope-ok")) document.getElementById("scope").hidden = true; } catch {}
    document.getElementById("scope-ok").onclick = () => { document.getElementById("scope").hidden = true; try { localStorage.setItem("mi-scope-ok", "1"); } catch {} };
    document.getElementById("c-new-btn").onclick = () => { const f = document.getElementById("c-form"); f.hidden = !f.hidden; };
    document.getElementById("c-form").onsubmit = async (e) => {
      e.preventDefault();
      try { const c = await api("/api/osint/cases", { method: "POST", body: Object.fromEntries(new FormData(e.target)) });
        e.target.reset(); e.target.hidden = true; await this.loadCases(); this.openCase(c.id); } catch (err) { toast(err.message, 4000); }
    };
  }

  async init() {
    this.meta = await api("/api/osint/meta");
    document.getElementById("c-basis").innerHTML = `<option value="">Basis for the case…</option>` +
      Object.entries(this.meta.bases).map(([k, v]) => `<option value="${k}">${esc(v)}</option>`).join("");
    await this.loadCases();
  }

  async loadCases() {
    const d = await api("/api/osint/cases"); this.cases = d.cases;
    document.getElementById("c-list").innerHTML = d.cases.map((c) => `<div class="case ${this.case?.id === c.id ? "on" : ""}" data-id="${esc(c.id)}">
      <b>${esc(c.title)}</b><span>${esc(c.id)} · ${c.subjects.length} SUBJ${c.closed ? " · CLOSED" : ""}</span></div>`).join("") || `<div class="empty">NO CASES</div>`;
    document.querySelectorAll(".case").forEach((el) => el.onclick = () => this.openCase(el.dataset.id));
  }

  prefill(name) { this.hooks.show("osint"); this._prefill = name;
    if (this.case) this.render(); else { toast("Open or create a case first, then add the subject."); document.getElementById("c-form").hidden = false; } }

  async openCase(id) {
    await this.loadCases(); this.case = this.cases.find((c) => c.id === id); this.subject = this.case.subjects[0] || null; this.module = null;
    document.querySelectorAll(".case").forEach((el) => el.classList.toggle("on", el.dataset.id === id)); this.render();
  }

  async render() {
    const c = this.case, m = document.getElementById("os-main"); if (!c) return;
    const ORDER = ["profile", "usernames", "news", "filings", "breach", "providers"];
    const mods = this.subject ? ORDER.filter((k) => this.meta.modules[this.subject.kind].includes(k)) : [];
    if (this.subject && !mods.includes(this.module)) this.module = mods.includes("profile") ? "profile" : mods[0];
    m.innerHTML = `<div class="os-head"><span class="rp-type">CASE</span><div><h2>${esc(c.title)}</h2><p><span class="id">${esc(c.id)}</span> · ${esc(this.meta.bases[c.basis] || c.basis)}${c.client ? " · client " + esc(c.client) : ""}</p>
      <p>Purpose: ${esc(c.purpose)}</p></div><span class="sp"></span>
      <a class="btn" href="/api/osint/audit/export?case=${encodeURIComponent(c.id)}">EXPORT AUDIT</a>${c.closed ? "" : `<button class="btn" id="c-close">CLOSE</button>`}</div>
      <div class="os-body">
      <h3>Subjects</h3>
      <div class="subjects">${c.subjects.map((s) => `<button class="chip ${this.subject?.id === s.id ? "on" : ""}" data-sid="${s.id}"><em>${KIND[s.kind]}</em>${esc(s.name)}</button>`).join("") || '<span class="chip dim">none</span>'}</div>
      ${c.closed ? "" : `<form class="addsub" id="addsub"><input name="name" placeholder="Subject name" value="${esc(this._prefill || "")}" required>
        <select name="kind"><option value="public">PUB · public figure</option><option value="company">ORG · company</option><option value="private">PRV · private individual</option></select>
        <button class="btn pri">ADD</button></form><div class="cands" id="cands"></div>`}
      ${this.subject ? `<h3>Modules <small>${esc(MOD_NAME[this.module])}</small></h3><div class="mods" id="mods">${mods.map((k) => `<button data-m="${k}" class="${k === this.module ? "on" : ""}" title="${esc(MOD_NAME[k])}">${MOD_LABEL[k]}</button>`).join("")}</div>
        <form class="lk" id="lk"><input name="q" placeholder="${esc(MOD_HINT[this.module])}"><button class="btn pri">RUN</button></form>
        <div id="res"></div>` : `<div class="empty">ADD A SUBJECT</div>`}
      <h3>Audit log <span id="vfy"></span></h3><div id="audit"></div></div>`;
    this._prefill = null;
    m.querySelectorAll("[data-sid]").forEach((b) => b.onclick = () => { this.subject = c.subjects.find((s) => s.id === +b.dataset.sid); this.render(); });
    m.querySelectorAll("[data-m]").forEach((b) => b.onclick = () => { this.module = b.dataset.m; this.render(); });
    const close = document.getElementById("c-close");
    if (close) close.onclick = async () => { await api(`/api/osint/cases/${encodeURIComponent(c.id)}/close`, { method: "POST" }); this.openCase(c.id); };
    const add = document.getElementById("addsub"); if (add) add.onsubmit = (e) => { e.preventDefault(); this.addSubject(Object.fromEntries(new FormData(add))); };
    const lk = document.getElementById("lk"); if (lk) lk.onsubmit = (e) => { e.preventDefault(); this.run(new FormData(lk).get("q")); };
    if (this.subject && this.module === "providers") this.run("");
    this.loadAudit();
  }

  async addSubject({ name, kind }) {
    const c = this.case;
    try {
      if (kind === "private") {
        const s = await api(`/api/osint/cases/${encodeURIComponent(c.id)}/subjects`, { method: "POST", body: { name, kind } });
        await this.openCase(c.id); this.subject = this.case.subjects.find((x) => x.id === s.id); this.render(); return;
      }
      const r = await api(`/api/osint/cases/${encodeURIComponent(c.id)}/link-search`, { method: "POST", body: { name } });
      const el = document.getElementById("cands");
      el.innerHTML = `<div class="note" style="cursor:default;border:0;padding:4px 0">Select Wikidata entity (required for PUB/ORG):</div>` +
        r.results.map((x, i) => `<div data-i="${i}"><b>${esc(x.label)}</b><span>${esc(x.description)} · ${esc(x.id)}</span></div>`).join("") +
        `<div data-private><b>NONE</b><span>add as PRV instead</span></div>`;
      el.querySelectorAll("[data-i]").forEach((d) => d.onclick = async () => { const x = r.results[+d.dataset.i];
        const s = await api(`/api/osint/cases/${encodeURIComponent(c.id)}/subjects`, { method: "POST", body: { name: x.label || name, kind, wikidata: x.id } });
        await this.openCase(c.id); this.subject = this.case.subjects.find((y) => y.id === s.id); this.render(); });
      el.querySelector("[data-private]").onclick = () => this.addSubject({ name, kind: "private" });
    } catch (e) { toast(e.message, 5000); }
  }

  async run(q) {
    const res = document.getElementById("res"); res.innerHTML = `<div class="res"><div class="note">RUNNING ${MOD_LABEL[this.module]}…</div></div>`;
    try {
      const r = await api("/api/osint/lookup", { method: "POST", body: { case: this.case.id, subject: this.subject.id, module: this.module, query: q || "" } });
      res.innerHTML = this.renderResult(r.module, r.data);
    } catch (e) { res.innerHTML = `<div class="res"><h3 class="bad">REFUSED / FAILED</h3><div class="note">${esc(e.message)}</div></div>`; }
    this.loadAudit();
  }

  renderResult(mod, d) {
    const link = (u, t, cls = "", sub = "") => `<a class="${cls}" target="_blank" rel="noopener noreferrer" href="${esc(safeUrl(u))}">${esc(t)}<span>${esc(sub)}</span></a>`;
    if (mod === "profile") {
      return `<div class="res prof">${d.image ? `<img src="${esc(safeUrl(d.image))}" alt="">` : "<div></div>"}<div>
        <div style="font-size:15px;font-weight:500">${esc(d.label)} <span class="mono dim">${esc(d.id)}</span></div><p class="muted">${esc(d.description)}${d.aliases?.length ? " · aka " + esc(d.aliases.join(", ")) : ""}</p>
        <p>${esc(d.summary || "")}</p>
        <dl class="kv">${Object.entries(d.facts || {}).map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`).join("")}</dl>
        <div class="sect" style="padding-left:0">Official accounts · Wikidata</div>
        <div class="acc">${(d.accounts || []).map((a) => link(a.url, a.platform, "found", a.handle)).join("") || `<span class="muted">none listed</span>`}</div>
        <div class="links" style="padding:8px 0 0">${Object.entries(d.links || {}).map(([k, u]) => `<a target="_blank" rel="noopener noreferrer" href="${esc(safeUrl(u))}">${esc(k)}</a>`).join("")}</div></div></div>`;
    }
    if (mod === "usernames") {
      const f = d.results.filter((r) => r.status === "found").length;
      return `<div class="res"><h3>${f} hits / ${d.results.length} sites <small>found = profile exists · manual = login wall · same handle ≠ same person</small></h3>
        <div class="acc">${d.results.map((r) => link(r.url, r.site, r.status, r.status + (r.detail ? " · " + r.detail : ""))).join("")}</div></div>`;
    }
    if (mod === "news") return `<div class="res"><h3>${d.articles.length} articles</h3>${d.articles.map((a) => `<div class="ev"><div class="t"><b>${link(a.url, a.title)}</b></div><div class="m">${esc(a.domain)} · ${esc(a.ts)} · ${esc(a.lang)}</div></div>`).join("")}</div>`;
    if (mod === "filings") return `<div class="res"><h3>${d.filings.length} filings</h3>${d.filings.map((f) => `<div class="ev"><div class="t"><b>${f.url ? link(f.url, f.form) : esc(f.form)}</b><span class="muted">${esc(f.date)}</span></div><div class="m">${esc((f.names || []).join("; "))}</div></div>`).join("") || `<span class="muted">No filings.</span>`}</div>`;
    if (mod === "breach") {
      if (d.status === "needs key") return `<div class="res">Breach checks need a Have I Been Pwned key: <code>${esc(d.how)}</code></div>`;
      return `<div class="res"><h3>${d.status === "clean" ? "No known breaches" : d.status === "demo" ? "Demo mode: no breach data" : `${d.breaches.length} breaches`}</h3>${d.breaches.map((b) => `<div class="ev"><div class="t"><b>${esc(b.name)}</b><span class="muted">${esc(b.date)}</span></div><div class="m">${esc((b.data || []).join(", "))}</div></div>`).join("")}</div>`;
    }
    if (mod === "providers") return `<div class="res"><h3>Licensed providers <small>they verify licence and permissible purpose; use them for addresses, phones and records</small></h3><div class="acc">${d.providers.map((p) => link(p.url, p.name, "", `${p.region} · ${p.for}`)).join("")}</div></div>`;
    return `<pre>${esc(JSON.stringify(d, null, 2))}</pre>`;
  }

  async loadAudit() {
    const d = await api(`/api/osint/audit?case=${encodeURIComponent(this.case.id)}`);
    document.getElementById("vfy").innerHTML = d.verify.ok ? `<span class="vfy">CHAIN OK · ${d.verify.rows}</span>` : `<span class="vfy bad">CHAIN BROKEN @${d.verify.break_at}</span>`;
    document.getElementById("audit").innerHTML = `<table class="audit"><tr><th>SEQ</th><th>T</th><th>SUBJECT</th><th>MOD</th><th>QUERY</th><th>OUTCOME</th><th>HASH</th></tr>` +
      d.entries.map((e) => `<tr><td>${String(e.seq).padStart(5, "0")}</td><td>${new Date(e.ts * 1000).toISOString().slice(5, 19).replace("T", " ")}</td><td>${esc(e.subject)} <span class="dim">${esc(KIND[e.kind] || e.kind)}</span></td><td class="mono">${esc(MOD_LABEL[e.module] || e.module)}</td><td>${esc(e.query)}</td><td class="${e.outcome === "ok" ? "ok" : e.outcome.startsWith("refused") ? "bad" : ""}">${esc(e.outcome)}${e.results ? ` · ${e.results}` : ""}</td><td class="h">${esc(e.hash.slice(0, 12))}</td></tr>`).join("") + `</table>`;
  }
}
