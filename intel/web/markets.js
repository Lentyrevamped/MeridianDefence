// Markets: watchlist with sparklines, quote header, history chart (line or candles), symbol search.
import { api, esc, fmt, chg, spark, toast } from "./api.js";

export class Markets {
  constructor(hooks) {
    this.hooks = hooks; this.sym = "^GSPC"; this.range = "1Y"; this.kind = "line"; this.items = [];
    const el = document.getElementById("chart");
    this.chart = LightweightCharts.createChart(el, {
      autoSize: true, layout: { background: { color: "#111418" }, textColor: "#8A939E", fontFamily: "ui-monospace, monospace", fontSize: 10 },
      grid: { vertLines: { color: "#1C2128" }, horzLines: { color: "#1C2128" } },
      rightPriceScale: { borderColor: "#2A3038" }, timeScale: { borderColor: "#2A3038", timeVisible: true },
      crosshair: { mode: 0, vertLine: { color: "#5C6570", labelBackgroundColor: "#262C34" }, horzLine: { color: "#5C6570", labelBackgroundColor: "#262C34" } },
    });
    this.series = null;
    document.querySelectorAll("#ranges button").forEach((b) => {
      if (/^(1D|5D|1M|6M|1Y|5Y|MAX)$/.test(b.textContent)) b.onclick = () => { this.range = b.textContent; this._seg(); this.load(); };
    });
    document.getElementById("ct-line").onclick = () => { this.kind = "line"; this._seg(); this.load(); };
    document.getElementById("ct-candle").onclick = () => { this.kind = "candle"; this._seg(); this.load(); };
    document.getElementById("q-add").onclick = () => this.add(this.sym);
    document.getElementById("q-ask").onclick = () => this.hooks.ask(`Explain the recent price action of ${this.sym} and what is driving it. Use the tools.`);
    const q = document.getElementById("mk-q"), dd = document.getElementById("mk-results");
    let h;
    q.oninput = () => { clearTimeout(h); h = setTimeout(async () => {
      const v = q.value.trim(); if (!v) { dd.classList.remove("on"); return; }
      try {
        const r = await api(`/api/search?q=${encodeURIComponent(v)}`);
        dd.innerHTML = r.results.map((x) => `<div data-s="${esc(x.symbol)}"><b>${esc(x.symbol)}</b><span>${esc(x.name)}</span><em>${esc(x.type)} · ${esc(x.exchange)}</em></div>`).join("") || `<div><b>—</b><span>No match. Enter to try ${esc(v.toUpperCase())}</span></div>`;
        dd.classList.add("on");
        dd.querySelectorAll("[data-s]").forEach((d) => d.onclick = () => { dd.classList.remove("on"); q.value = ""; this.open(d.dataset.s); });
      } catch { dd.classList.remove("on"); }
    }, 250); };
    q.onkeydown = (e) => { if (e.key === "Enter" && q.value.trim()) { dd.classList.remove("on"); this.open(q.value.trim().toUpperCase()); q.value = ""; } if (e.key === "Escape") dd.classList.remove("on"); };
    this._seg();
  }

  _seg() {
    document.querySelectorAll("#ranges button").forEach((b) => {
      if (/^(1D|5D|1M|6M|1Y|5Y|MAX)$/.test(b.textContent)) b.classList.toggle("on", b.textContent === this.range);
    });
    document.getElementById("ct-line").classList.toggle("on", this.kind === "line");
    document.getElementById("ct-candle").classList.toggle("on", this.kind === "candle");
  }

  async loadWatchlist() {
    try {
      const d = await api("/api/watchlist"); this.items = d.items; this.renderList();
    } catch (e) { toast(`Watchlist: ${e.message}`); }
  }

  renderList() {
    const tb = document.getElementById("wl");
    tb.innerHTML = this.items.map((it, i) => { const c = chg(it.price, it.prev);
      return `<tr data-i="${i}" class="${it.symbol === this.sym ? "on" : ""}"><td class="s"><b>${esc(it.symbol)}</b><span>${esc(it.label || it.name || "")}</span></td>
      <td><canvas></canvas></td><td class="p">${it.error ? '<span class="dim">n/a</span>' : fmt(it.price)}</td><td class="c ${c.cls}">${it.error ? "" : (c.pct >= 0 ? "+" : "") + c.pct.toFixed(2) + "%"}</td>
      <td class="x" title="Remove">×</td></tr>`; }).join("");
    const ok = this.items.filter((it) => !it.error && it.prev).map((it) => ({ ...it, pct: chg(it.price, it.prev).pct })).sort((a, b) => b.pct - a.pct);
    const adv = ok.filter((x) => x.pct > 0).length, dec = ok.filter((x) => x.pct < 0).length, avgc = ok.length ? ok.reduce((a, x) => a + x.pct, 0) / ok.length : 0;
    const mv = (x) => `<div class="mv" data-s="${esc(x.symbol)}"><b>${esc(x.symbol)}</b><span>${esc(x.label || x.name || "")}</span><em class="${x.pct >= 0 ? "up" : "dn"}">${x.pct >= 0 ? "+" : ""}${x.pct.toFixed(2)}%</em></div>`;
    const mvEl = document.getElementById("movers");
    if (mvEl) {
      mvEl.innerHTML = `<div class="sect">Breadth</div><div class="breadth"><span class="up">${adv} advancing</span><span class="dn">${dec} declining</span><span>Average ${avgc >= 0 ? "+" : ""}${avgc.toFixed(2)}%</span></div>
        <div class="bbar"><i class="up" style="width:${ok.length ? (adv / ok.length) * 100 : 0}%"></i><i class="dn" style="width:${ok.length ? (dec / ok.length) * 100 : 0}%"></i></div>
        <div class="sect">Strongest</div>${ok.slice(0, 3).map(mv).join("")}<div class="sect">Weakest</div>${ok.slice(-3).reverse().map(mv).join("")}`;
      mvEl.querySelectorAll("[data-s]").forEach((d) => d.onclick = () => this.open(d.dataset.s));
    }
    tb.querySelectorAll("tr").forEach((tr) => { const it = this.items[+tr.dataset.i];
      spark(tr.querySelector("canvas"), it.spark, 46, 20);
      tr.onclick = (e) => { if (e.target.classList.contains("x")) { this.remove(it.symbol); return; } this.open(it.symbol); };
    });
  }

  async add(sym) {
    await api("/api/watchlist", { method: "POST", body: { symbol: sym, label: this.name || sym } });
    toast(`${sym} added to watchlist`); this.loadWatchlist();
  }
  async remove(sym) { await api(`/api/watchlist/${encodeURIComponent(sym)}`, { method: "DELETE" }); this.loadWatchlist(); }

  open(sym) { this.sym = sym.toUpperCase(); this.hooks.show("markets"); this.renderList(); this.load(); }

  async load() {
    const sym = this.sym, rng = this.range;
    document.getElementById("q-sym").textContent = sym;
    try {
      const h = await api(`/api/history?s=${encodeURIComponent(sym)}&r=${rng}`);
      if (sym !== this.sym || rng !== this.range) return;
      this.name = h.name;
      const c = chg(h.price, h.prev);
      document.getElementById("q-name").textContent = `${h.name} · ${h.exchange}`;
      document.getElementById("q-px").textContent = fmt(h.price);
      const qc = document.getElementById("q-chg"); qc.className = c.cls; qc.textContent = c.txt ? `${c.abs >= 0 ? "+" : ""}${fmt(c.abs)} (${c.pct >= 0 ? "+" : ""}${c.pct.toFixed(2)}%)` : "";
      document.getElementById("q-src").textContent = `${rng} · ${h.currency || ""}`;
      if (this.series) this.chart.removeSeries(this.series);
      if (this.kind === "candle") {
        this.series = this.chart.addCandlestickSeries({ upColor: "#32A467", downColor: "#E5484D", borderUpColor: "#32A467", borderDownColor: "#E5484D", wickUpColor: "#32A467", wickDownColor: "#E5484D" });
        this.series.setData(h.points.map((p) => ({ time: p.t, open: p.o ?? p.c, high: p.h ?? p.c, low: p.l ?? p.c, close: p.c })));
      } else {
        const upc = (h.points.at(-1)?.c ?? 0) >= (h.points[0]?.c ?? 0);
        this.series = this.chart.addAreaSeries({ lineColor: upc ? "#32A467" : "#E5484D", lineWidth: 1.5, topColor: upc ? "rgba(50,164,103,.16)" : "rgba(229,72,77,.16)", bottomColor: "rgba(0,0,0,0)", priceLineColor: "#5C6570", priceLineStyle: 2 });
        this.series.setData(h.points.map((p) => ({ time: p.t, value: p.c })));
      }
      for (const x of this.extra || []) this.chart.removeSeries(x); this.extra = [];
      const P = h.points, hasVol = P.some((p) => p.v > 0);
      const sma = (n) => { const o = []; let sum = 0; P.forEach((p, i) => { sum += p.c; if (i >= n) sum -= P[i - n].c; if (i >= n - 1) o.push({ time: p.t, value: sum / n }); }); return o; };
      const lineOpt = (color) => ({ color, lineWidth: 1, priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false });
      const leg = [];
      if (P.length > 60) { const a = this.chart.addLineSeries(lineOpt("#8B9AAB")); a.setData(sma(20)); const b = this.chart.addLineSeries(lineOpt("#4C90F0")); b.setData(sma(50)); this.extra.push(a, b); leg.push('<span><i style="background:#8B9AAB"></i>20-period average</span>', '<span><i style="background:#4C90F0"></i>50-period average</span>'); }
      if (hasVol) {
        const v = this.chart.addHistogramSeries({ priceScaleId: "vol", priceFormat: { type: "volume" }, lastValueVisible: false, priceLineVisible: false });
        this.chart.priceScale("vol").applyOptions({ scaleMargins: { top: 0.82, bottom: 0 } });
        v.setData(P.map((p) => ({ time: p.t, value: p.v, color: p.c >= (p.o ?? p.c) ? "rgba(50,164,103,.35)" : "rgba(229,72,77,.35)" }))); this.extra.push(v);
        leg.push('<span><i style="background:rgba(139,154,171,.5)"></i>Volume</span>');
      }
      this.chart.priceScale("right").applyOptions({ scaleMargins: { top: 0.06, bottom: hasVol ? 0.22 : 0.06 } });
      document.getElementById("q-legend").innerHTML = leg.join("");
      this.chart.timeScale().fitContent();
      const cl = h.points.map((p) => p.c), hi = Math.max(...cl), lo = Math.min(...cl);
      const first = cl[0], last = cl[cl.length - 1];
      const rets = cl.slice(1).map((v, i) => Math.log(v / cl[i]));
      const sd = Math.sqrt(rets.reduce((a, r) => a + r * r, 0) / Math.max(1, rets.length));
      const per = { "1D": 78 * 252, "5D": 26 * 252, "1M": 7 * 252, "6M": 252, "1Y": 252, "5Y": 52, MAX: 12 }[rng];
      const P2 = h.points, lastT = P2.at(-1).t, pct = (x) => (x == null ? '<span class="dim">—</span>' : `<span class="${x >= 0 ? "up" : "dn"}">${x >= 0 ? "+" : ""}${x.toFixed(2)}%</span>`);
      const back = (secs) => { const t = lastT - secs; if (P2[0].t > t + secs * 0.05) return null; const p = P2.find((x) => x.t >= t); return p ? (last / p.c - 1) * 100 : null; };
      const y0 = Date.UTC(new Date(lastT * 1000).getUTCFullYear(), 0, 1) / 1000;
      const D = 86400, perf = [["1 day", D], ["1 week", 7 * D], ["1 month", 30 * D], ["3 months", 91 * D], ["6 months", 182 * D], ["Year to date", lastT - y0], ["1 year", 365 * D], ["3 years", 1095 * D], ["5 years", 1826 * D]];
      let peak = cl[0], mdd = 0, ddStart = 0, ddLen = 0, cur = 0; cl.forEach((v, i) => { if (v > peak) { peak = v; cur = 0; } else cur++; mdd = Math.min(mdd, v / peak - 1); ddLen = Math.max(ddLen, cur); });
      const pr = cl.slice(1).map((v, i) => (v / cl[i] - 1) * 100), ups = pr.filter((x) => x > 0).length;
      const sec = (t, rows) => `<div class="sect">${t}</div><dl class="kv">${rows.map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join("")}</dl>`;
      document.getElementById("q-stats").innerHTML =
        sec("Range", [["Change", pct((last / first - 1) * 100)], ["High", fmt(hi)], ["Low", fmt(lo)], ["From high", pct((last / hi - 1) * 100)], ["From low", pct((last / lo - 1) * 100)], ["First", fmt(first)], ["Last", fmt(last)]]) +
        sec("Performance", perf.map(([k, sx]) => [k, pct(back(sx))])) +
        sec("Risk", [["Annualised volatility", `${(sd * Math.sqrt(per) * 100).toFixed(1)}%`], ["Maximum drawdown", pct(mdd * 100)], ["Longest drawdown", `${ddLen.toLocaleString()} periods`], ["Up periods", `${pr.length ? Math.round((ups / pr.length) * 100) : 0}%`], ["Best period", pct(Math.max(...pr))], ["Worst period", pct(Math.min(...pr))]]) +
        sec("Data", [["Points", h.points.length.toLocaleString()], ["Source", esc(h.src)], ["Exchange", esc(h.exchange || "—")], ["Currency", esc(h.currency || "—")]]);
    } catch (e) {
      document.getElementById("q-name").textContent = `No data: ${e.message}`;
      document.getElementById("q-px").textContent = "—"; document.getElementById("q-chg").textContent = "";
    }
  }
}
