// Local API helper. Same-origin; the session cookie carries the token. Mutations add the CSRF header.
export async function api(path, opts = {}) {
  const init = { method: opts.method || "GET", headers: { "X-Requested-With": "meridian" } };
  if (opts.body !== undefined) { init.headers["Content-Type"] = "application/json"; init.body = JSON.stringify(opts.body); }
  const r = await fetch(path, init);
  const ct = r.headers.get("content-type") || "";
  const data = ct.includes("json") ? await r.json() : await r.text();
  if (!r.ok) throw new Error((data && data.detail) || data || `HTTP ${r.status}`);
  return data;
}
export const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
export const safeUrl = (u) => { try { const x = new URL(u); return ["http:", "https:"].includes(x.protocol) ? x.href : "#"; } catch { return "#"; } };
export function fmt(n, d) {
  if (n == null || isNaN(n)) return "—";
  const a = Math.abs(n); d = d ?? (a >= 1000 ? 2 : a >= 1 ? 2 : 4);
  return n.toLocaleString("en-US", { minimumFractionDigits: d, maximumFractionDigits: d });
}
export function chg(price, prev) {
  if (price == null || !prev) return { txt: "", cls: "", pct: 0 };
  const p = (price / prev - 1) * 100;
  return { txt: `${p >= 0 ? "▲" : "▼"} ${Math.abs(p).toFixed(2)}%`, cls: p >= 0 ? "up" : "dn", pct: p, abs: price - prev };
}
export function toast(msg, ms = 2600) {
  const t = document.getElementById("toast"); t.textContent = msg; t.hidden = false;
  clearTimeout(t._h); t._h = setTimeout(() => (t.hidden = true), ms);
}
export function ago(ts) {
  const s = Math.max(0, Date.now() / 1000 - ts);
  if (s < 90) return "just now"; if (s < 5400) return `${Math.round(s / 60)} min ago`;
  if (s < 129600) return `${Math.round(s / 3600)} h ago`; return `${Math.round(s / 86400)} d ago`;
}
export function spark(canvas, values, w = 88, h = 26) {
  const dpr = window.devicePixelRatio || 1; canvas.width = w * dpr; canvas.height = h * dpr;
  canvas.style.width = w + "px"; canvas.style.height = h + "px";
  const c = canvas.getContext("2d"); c.scale(dpr, dpr);
  if (!values || values.length < 2) return;
  const lo = Math.min(...values), hi = Math.max(...values), r = hi - lo || 1;
  c.beginPath();
  values.forEach((v, i) => { const x = (i / (values.length - 1)) * w, y = h - 2 - ((v - lo) / r) * (h - 4); i ? c.lineTo(x, y) : c.moveTo(x, y); });
  c.strokeStyle = values[values.length - 1] >= values[0] ? "#32A467" : "#E5484D"; c.lineWidth = 1; c.stroke();
}
