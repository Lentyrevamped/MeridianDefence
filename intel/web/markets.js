// Markets: watchlist with sparklines, quote header, history chart (line or candles), symbol search.
import { api, esc, fmt, chg, spark, toast } from "./api.js";

export class Markets {
  constructor(hooks) {
    this.hooks = hooks; this.sym = "^GSPC"; this.range = "1Y"; this.kind = "line"; this.items = [];
    const el = document.getElementById("chart");
    this.chart = LightweightCharts.createChart(el, {
      autoSize: true, layout: { background: { color: "#0A0A0C" }, textColor: "#85858F", fontFamily: "Inter", fontSize: 11 },
      grid: { vertLines: { color: "rgba(241,241,238,.04)" }, horzLines: { color: "rgba(241,241,238,.06)" } },
      rightPriceScale: { borderColor: "rgba(241,241,238,.08)" }, timeScale: { borderColor: "rgba(241,241,238,.08)", timeVisible: true },
      crosshair: { vertLine: { color: "rgba(241,241,238,.3)", labelBackgroundColor: "#26262B" }, horzLine: { color: "rgba(241,241,238,.3)", labelBackgroundColor: "#26262B" } },
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
        dd.innerHTML = r.results.map((x) => `<div data-s="${esc(x.symbol)}"><b>${esc(x.symbol)}</b><span>${esc(x.name)}</span><em>${esc(x.type)} · ${esc(x.exchange)}</em></div>`).join("") || `<div><span>No match. Press Enter to try “${esc(v.toUpperCase())}”.</span></div>`;
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
      const d = await api("/api/watchlist"); this.items = d.items; this.renderList(); this.hooks.ticker(d.items);
    } catch (e) { toast(`Watchlist: ${e.message}`); }
  }

  renderList() {
    const tb = document.getElementById("wl");
    tb.innerHTML = this.items.map((it, i) => { const c = chg(it.price, it.prev);
      return `<tr data-i="${i}" class="${it.symbol === this.sym ? "on" : ""}"><td class="s"><b>${esc(it.symbol)}</b><span>${esc(it.label || it.name || "")}</span></td>
      <td><canvas></canvas></td><td class="p">${it.error ? `<span class="dn">${esc(it.error).slice(0, 30)}</span>` : `<b>${fmt(it.price)}</b><span class="${c.cls}">${c.txt}</span>`}</td>
      <td class="x" title="Remove">×</td></tr>`; }).join("");
    tb.querySelectorAll("tr").forEach((tr) => { const it = this.items[+tr.dataset.i];
      spark(tr.querySelector("canvas"), it.spark);
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
      document.getElementById("q-name").textContent = `${h.name} · ${h.exchange} · ${h.currency}`;
      document.getElementById("q-px").textContent = fmt(h.price);
      const qc = document.getElementById("q-chg"); qc.className = c.cls; qc.textContent = c.txt ? `${c.abs >= 0 ? "+" : ""}${fmt(c.abs)}  ${c.txt}` : "";
      document.getElementById("q-src").textContent = `source: ${h.src}`;
      if (this.series) this.chart.removeSeries(this.series);
      if (this.kind === "candle") {
        this.series = this.chart.addCandlestickSeries({ upColor: "#F1F1EE", downColor: "#26262B", borderUpColor: "#F1F1EE", borderDownColor: "#85858F", wickUpColor: "#F1F1EE", wickDownColor: "#85858F" });
        this.series.setData(h.points.map((p) => ({ time: p.t, open: p.o ?? p.c, high: p.h ?? p.c, low: p.l ?? p.c, close: p.c })));
      } else {
        this.series = this.chart.addAreaSeries({ lineColor: "#F1F1EE", lineWidth: 1.5, topColor: "rgba(241,241,238,.18)", bottomColor: "rgba(241,241,238,0)", priceLineColor: "#85858F" });
        this.series.setData(h.points.map((p) => ({ time: p.t, value: p.c })));
      }
      this.chart.timeScale().fitContent();
      const cl = h.points.map((p) => p.c), hi = Math.max(...cl), lo = Math.min(...cl);
      const first = cl[0], last = cl[cl.length - 1];
      const rets = cl.slice(1).map((v, i) => Math.log(v / cl[i]));
      const sd = Math.sqrt(rets.reduce((a, r) => a + r * r, 0) / Math.max(1, rets.length));
      const per = { "1D": 78 * 252, "5D": 26 * 252, "1M": 7 * 252, "6M": 252, "1Y": 252, "5Y": 52, MAX: 12 }[rng];
      document.getElementById("q-stats").innerHTML = [["Range change", `${((last / first - 1) * 100).toFixed(2)}%`], ["High", fmt(hi)], ["Low", fmt(lo)],
        ["From high", `${((last / hi - 1) * 100).toFixed(2)}%`], ["Ann. volatility", `${(sd * Math.sqrt(per) * 100).toFixed(1)}%`], ["Points", h.points.length.toLocaleString()]]
        .map(([k, v]) => `<div><span>${k}</span><b>${v}</b></div>`).join("");
    } catch (e) {
      document.getElementById("q-name").textContent = `No data: ${e.message}`;
      document.getElementById("q-px").textContent = "—"; document.getElementById("q-chg").textContent = "";
    }
  }
}
