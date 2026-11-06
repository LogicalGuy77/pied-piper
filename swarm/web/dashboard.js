// The laptop's demo screen. It watches the tracker over the same WebSocket
// the phones use, and asks the swarm itself as a client (like swarm/api.js):
// it holds no block, so the laptop never computes. Live numbers come from the
// tracker's state; the model comes from the weights' manifest, and the chart
// and the answers table are collected here from the tracker's state and log.

import { Peer } from "../src/peer.js";

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
const kc = (i) => `var(--k${i % 6})`;   // block colour
const ks = (i) => `var(--k${i % 6}s)`;  // block fill

const fmt = {
  int: (x) => Math.round(x).toLocaleString(),
  ms: (x) => (x == null ? "–" : `${Math.round(x)} ms`),
  secs: (ms) => (ms == null ? "–" : `${(ms / 1000).toFixed(1)} s`),
  bytes: (b) => (b >= 1e9 ? `${(b / 1e9).toFixed(1)} GB` : `${Math.round(b / 1e6)} MB`),
  params: (p) => (p >= 1e9 ? `${(p / 1e9).toFixed(2)}B` : `${Math.round(p / 1e6)}M`),
  rate: (x) => (x == null || !Number.isFinite(x) ? "–" : x >= 10 ? x.toFixed(0) : x.toFixed(1)),
};
const clock = (t) => new Date(t).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;

let state = null;
const serving = () => state.peers.filter((p) => p.block != null);
const lastEnd = () => state.blocks.at(-1).end;
const replicas = () => state.minReplica ?? 2; // phones per block before it counts as backed up

function blockLabel(b, short = false) {
  const parts = b.start === 0 ? [short ? "emb" : "embedding"] : [];
  parts.push(b.end - 1 > b.start ? `${short ? "" : "layers "}${b.start}–${b.end - 1}` : `${short ? "" : "layer "}${b.start}`);
  if (b.end === lastEnd()) parts.push(short ? "out" : "output");
  return parts.join(" + ");
}

// --- Joining: the QR code phones scan ---

const URL_KEY = "swarm-dashboard-url";
function phoneUrl() {
  let saved = null;
  try { saved = localStorage.getItem(URL_KEY); } catch {}
  return new URLSearchParams(location.search).get("url") || saved || state?.publicUrl || location.origin;
}
let shownUrl = null;
function showQr() {
  const url = phoneUrl();
  if (url !== shownUrl) {
    shownUrl = url;
    $("qr").src = `/qr.svg?text=${encodeURIComponent(url)}`;
  }
  if (document.activeElement !== $("url")) $("url").value = url;
  const lan = state?.lanUrls ?? [];
  $("lan").textContent = lan.length ? `On this Wi-Fi: ${lan.join("  ·  ")}` : "";
}
$("url").addEventListener("change", () => {
  const url = $("url").value.trim();
  try { url ? localStorage.setItem(URL_KEY, url) : localStorage.removeItem(URL_KEY); } catch {}
  showQr();
});
document.querySelectorAll("[data-action=join]").forEach((el) => el.addEventListener("click", () => {
  showQr();
  $("joinModal").hidden = false;
}));
$("closeJoin").addEventListener("click", () => ($("joinModal").hidden = true));
$("joinModal").addEventListener("click", (e) => { if (e.target === $("joinModal")) $("joinModal").hidden = true; });
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") $("joinModal").hidden = true;
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") { e.preventDefault(); $("search").focus(); }
});

// --- Search: filters phones on the map and rows in the table ---

let query = "";
$("search").addEventListener("input", () => { query = $("search").value.trim().toLowerCase(); if (state) render(); });
const matches = (...fields) => !query || fields.some((f) => String(f ?? "").toLowerCase().includes(query));

// --- Sidebar, hero line, model ---

function renderModel() {
  const m = state.model;
  const n = serving().length;
  $("modelName").textContent = m?.name ?? "Model";
  $("modelName").title = m?.source ?? "";
  $("modelBlocks").innerHTML = state.blocks.map((b) =>
    `<div><i style="background:${kc(b.index)}"></i><span>Block ${b.index + 1} · ${esc(blockLabel(b, true))}</span></div>`).join("");
  $("heroModel").textContent = m ? `${m.name} running on ${plural(n, "phone")}` : `${plural(n, "phone")} in the swarm`;
  if (m) {
    $("weightsLine").textContent = `${fmt.bytes(m.bytes)} · ${state.blocks.length} blocks · ${m.layers} layers`;
    $("hopPill").textContent = `${(m.hopBytes / 1024).toFixed(1)} KB per hop`;
    $("mapSub").textContent = `${m.name} · ${fmt.params(m.params)} parameters cut into ${state.blocks.length} blocks`;
  }
  $("navPhones").textContent = n;
  $("navAnswers").textContent = state.sessions.length + state.recent.length;
}

// --- Snapshot tiles ---

function healthOf() {
  const ready = state.blocks.map((b) => serving().filter((p) => p.block === b.index && p.ready).length);
  const R = replicas();
  const score = ready.reduce((sum, r) => sum + Math.min(r, R) / R, 0) / ready.length;
  const pill = ready.every((r) => r >= R) ? ["green", "Stable"] : ready.every((r) => r >= 1) ? ["amber", "No backup"] : ["red", "Blocked"];
  return { score, pill };
}

function gauge(score) {
  const N = 41, cx = 70, cy = 70;
  let out = "";
  for (let i = 0; i < N; i++) {
    const f = i / (N - 1), a = Math.PI - Math.PI * f;
    const r1 = 50, r2 = i % 5 === 0 ? 64 : 61;
    const on = f <= score + 1e-9 && score > 0;
    const mix = Math.round(205 - 95 * f), color = on ? `rgb(${mix + 4}, ${Math.round(mix * 0.82)}, 246)` : "#e7e6ee";
    out += `<line x1="${(cx + r1 * Math.cos(a)).toFixed(1)}" y1="${(cy - r1 * Math.sin(a)).toFixed(1)}" x2="${(cx + r2 * Math.cos(a)).toFixed(1)}" y2="${(cy - r2 * Math.sin(a)).toFixed(1)}" stroke="${color}" stroke-width="2" stroke-linecap="round"/>`;
  }
  const a = Math.PI - Math.PI * score;
  out += `<circle cx="${(cx + 42 * Math.cos(a)).toFixed(1)}" cy="${(cy - 42 * Math.sin(a)).toFixed(1)}" r="3.4" fill="#1b1a24"/>`;
  return out;
}

function phoneBars() {
  const phones = [...serving()].sort((a, b) => a.block - b.block || a.joinedAt - b.joinedAt).slice(0, 16);
  const slots = Math.max(phones.length, 12), gap = 140 / slots, w = Math.min(6, gap * 0.45);
  const max = Math.max(1, ...phones.map((p) => p.served));
  let out = "";
  for (let i = 0; i < slots; i++) {
    const x = gap * i + gap / 2 - w / 2, p = phones[i];
    out += `<rect x="${x.toFixed(1)}" y="4" width="${w.toFixed(1)}" height="48" rx="${w / 2}" fill="#f1f0f6"/>`;
    if (p) {
      const h = 6 + 42 * (p.served / max);
      out += `<rect x="${x.toFixed(1)}" y="${(52 - h).toFixed(1)}" width="${w.toFixed(1)}" height="${h.toFixed(1)}" rx="${w / 2}" fill="${kc(p.block)}" opacity="${p.ready ? 1 : 0.35}"><title>${esc(p.id)}: ${fmt.int(p.served)} tokens served</title></rect>`;
    }
  }
  return out;
}

function speedTicks(speeds) {
  const N = 34, gap = 140 / N, max = Math.max(...speeds, 0.001);
  const shown = speeds.slice(-N);
  let out = "";
  for (let i = 0; i < N; i++) {
    const s = shown[i - (N - shown.length)], x = gap * i + gap / 2;
    const h = s == null ? 26 : 14 + 26 * (s / max);
    out += `<line x1="${x.toFixed(1)}" x2="${x.toFixed(1)}" y1="${(52 - h).toFixed(1)}" y2="52" stroke="${s == null ? "#e7e6ee" : "#2fb67a"}" stroke-width="1.6" stroke-linecap="round" opacity="${s == null ? 1 : 0.55 + 0.45 * (s / max)}"/>`;
  }
  if (shown.length) {
    const x = gap * (N - 1) + gap / 2, label = fmt.rate(shown.at(-1));
    const bw = 10 + label.length * 6.2, bx = Math.min(140 - bw, Math.max(0, x - bw / 2));
    out += `<rect x="${bx.toFixed(1)}" y="0" width="${bw.toFixed(1)}" height="14" rx="7" fill="#1b1a24"/><text x="${(bx + bw / 2).toFixed(1)}" y="10.2" text-anchor="middle" font-size="8.5" font-weight="600" fill="#fff">${label}</text>`;
    out += `<path d="M${x - 3} 55 L${x + 3} 55 L${x} 51 Z" fill="#1b1a24"/>`;
  }
  return out;
}

function servedSteps() {
  const pts = state.history.slice(-28).map((h) => h.servedPerSec);
  if (pts.length < 2) return `<rect x="0" y="40" width="140" height="12" rx="3" fill="#f3f0fd"/>`;
  const max = Math.max(...pts, 0.001), w = 140 / pts.length;
  let d = `M0 52`;
  pts.forEach((v, i) => { const y = 52 - 6 - 40 * (v / max); d += ` L${(i * w).toFixed(1)} ${y.toFixed(1)} L${((i + 1) * w).toFixed(1)} ${y.toFixed(1)}`; });
  return `<defs><linearGradient id="sg" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#cdbff9"/><stop offset="1" stop-color="#f5f1ff"/></linearGradient></defs>`
    + `<path d="${d} L140 52 Z" fill="url(#sg)"/><path d="${d.replace("M0 52 L", "M")}" fill="none" stroke="#8b6ff0" stroke-width="1.4"/>`;
}

function renderTiles() {
  const { score, pill } = healthOf();
  $("health").textContent = Math.round(100 * score);
  $("healthPill").innerHTML = `<span class="pill ${pill[0]}">${pill[1]}</span>`;
  $("gauge").innerHTML = gauge(score);
  const phones = serving();
  $("ready").textContent = phones.filter((p) => p.ready).length;
  $("readyOf").textContent = `/${phones.length}`;
  const missing = missingBlocks();
  $("readySub").textContent = missing.length ? `missing block${missing.length === 1 ? "" : "s"} ${missing.map((b) => b.index + 1).join(", ")}` : "serving a block";
  $("readySub").classList.toggle("warn", missing.length > 0);
  $("phoneBars").innerHTML = phoneBars();
  const speeds = [...state.recent].reverse().filter((r) => r.msPerToken).map((r) => 1000 / r.msPerToken);
  $("speed").textContent = speeds.length ? fmt.rate(speeds.slice(-10).reduce((a, b) => a + b, 0) / Math.min(10, speeds.length)) : "–";
  $("speedTicks").innerHTML = speedTicks(speeds);
  $("served").textContent = fmt.int(state.throughput.served);
  $("servedSteps").innerHTML = servedSteps();
}

// --- Swarm map ---

function phoneStatus(p) {
  const r = p.report ?? {};
  if (!p.ready) return ["Loading", "var(--soft)"];
  if (p.silentMs > 2500 && !p.busy) return [`Silent ${Math.round(p.silentMs / 1000)} s`, "var(--red)"];
  if (r.hidden) return ["In background", "var(--red)"];
  if (p.busy) return ["Computing", "var(--purple)"];
  return ["Ready", "var(--green)"];
}

// What a phone has earned, paid out or not, in PIPER (18 decimals).
const piper = (e) => {
  const units = BigInt(e.pending ?? 0) + BigInt(e.paid ?? 0);
  return (Number(units / 10n ** 12n) / 1e6).toFixed(units >= 10n ** 18n ? 2 : 4);
};

function renderMap() {
  $("mapGrid").innerHTML = state.blocks.map((b) => {
    const holders = serving().filter((p) => p.block === b.index).sort((a, c) => a.joinedAt - c.joinedAt);
    const ready = holders.filter((p) => p.ready).length;
    const pill = ready >= replicas() ? ["green", `${ready} ready`] : ready === 1 ? ["amber", "no backup"] : ["red", "waiting"];
    const shown = holders.filter((p) => matches(p.id, p.report?.device, `block ${b.index + 1}`));
    const phones = shown.map((p) => {
      const [label, color] = phoneStatus(p);
      const detail = [label, p.rtt != null && `ping ${fmt.ms(p.rtt)}`, p.tokenMs != null && `${fmt.ms(p.tokenMs)}/tok`, `${fmt.int(p.served)} served`,
        p.earned && `${piper(p.earned)} PIPER`].filter(Boolean).join(" · ");
      return `<div class="ph${p.ready ? "" : " loading"}">
        <div class="av" style="background:${ks(b.index)};color:${kc(b.index)}">${esc(p.id)}</div>
        <div class="who"><b>Phone ${esc(p.id)}<i class="st" style="background:${color}"></i></b><span title="${esc(detail)}">${esc(detail)}</span></div></div>`;
    }).join("");
    return `<div class="blk">
      <div class="blk-head"><i style="background:${kc(b.index)}"></i><b>Block ${b.index + 1}</b><span class="pill ${pill[0]}">${pill[1]}</span></div>
      <div class="holds">${esc(blockLabel(b))} · ${b.bytes ? fmt.bytes(b.bytes) : ""}</div>
      ${phones || `<div class="empty">${holders.length ? "No match" : "No phone yet. Scan the QR code."}</div>`}</div>`;
  }).join("");
  const askers = state.clients ?? [];
  $("askers").textContent = askers.length
    ? `Asking only (no block): ${askers.map((id) => (id === myId ? `${id} (this dashboard)` : id)).join(", ")}`
    : "";
}

// --- Answers table ---

// Questions asked from this browser, kept across reloads: { id, asker, text, t }.
// Session ids restart with the tracker, so a match also needs the same asker and a nearby time.
const QKEY = "swarm.questions";
const asked = (() => { try { return JSON.parse(localStorage.getItem(QKEY)) ?? []; } catch { return []; } })();
function remember(id, asker, text) {
  asked.push({ id, asker, text, t: Date.now() });
  asked.splice(0, asked.length - 50);
  try { localStorage.setItem(QKEY, JSON.stringify(asked)); } catch {}
}
function questionOf(r) {
  return asked.findLast((q) => q.id === r.id && q.asker === r.asker && q.t <= r.at + 5000 && r.at - q.t < 30 * 60e3)?.text ?? null;
}
const selected = new Set();
let liveOnly = false;

function rowsData() {
  const live = state.sessions.map((s) => ({
    key: `${s.id}.${s.turn}`, id: s.id, turn: s.turn, asker: s.asker, route: s.route, tokens: s.tokens, reroutes: s.reroutes, status: "live", at: s.startAt,
    firstMs: s.firstAt ? s.firstAt - s.startAt : null,
    msPerToken: s.firstAt && s.tokens > 1 ? (state.now - s.firstAt) / (s.tokens - 1) : null,
  }));
  const keys = new Set(live.map((r) => r.key));
  const rows = [...live, ...(liveOnly ? [] : state.recent.filter((r) => !keys.has(r.key)))];
  return rows.filter((r) => matches(questionOf(r), r.asker, r.route.join(" "), `#${r.id}`)).slice(0, 14);
}

const RESULT = {
  live: ["purple", "In progress"], done: ["green", "Complete"], failed: ["red", "Failed"], ended: ["grey", "Ended"],
};

function routeChips(route) {
  return `<span class="route">${route.map((id, i) =>
    `${i ? '<span class="arrow">›</span>' : ""}<i style="background:${ks(i)};color:${kc(i)}" title="Block ${i + 1}: phone ${esc(id)}">${esc(id)}</i>`).join("")}</span>`;
}

function renderTable() {
  const rows = rowsData();
  $("rowsEmpty").hidden = rows.length > 0;
  $("rows").innerHTML = rows.map((r) => {
    const [tone, label] = RESULT[r.status];
    const q = questionOf(r);
    return `<tr class="${selected.has(r.key) ? "sel" : ""}">
      <td><input type="checkbox" data-sel="${r.key}" ${selected.has(r.key) ? "checked" : ""} aria-label="Select answer ${r.id}"></td>
      <td class="q"><b title="${esc(q ?? "")}">${esc(q ?? `Question from phone ${r.asker}`)}</b><span>#${r.id}${r.turn > 1 ? ` turn ${r.turn}` : ""} · asked by ${esc(r.asker)} · ${clock(r.at)}</span></td>
      <td><span class="pill ${tone}"><span class="d"></span>${label}</span>${r.reroutes ? ` <span class="pill amber">rerouted ${r.reroutes}×</span>` : ""}</td>
      <td>${routeChips(r.route)}</td>
      <td>${r.tokens}</td>
      <td>${r.msPerToken ? `${fmt.rate(1000 / r.msPerToken)} tok/s` : "–"}<small class="cell-sub">first token ${fmt.secs(r.firstMs)}</small></td>
      <td>${q ? `<button class="row-act" data-reask="${r.key}" title="Ask this again" aria-label="Ask this again">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M20 11a8 8 0 1 0-2.3 5.7M20 4v7h-7"/></svg></button>` : ""}</td></tr>`;
  }).join("");
  const visible = rows.map((r) => r.key);
  $("selAll").checked = visible.length > 0 && visible.every((key) => selected.has(key));
  $("selChip").hidden = selected.size === 0;
  $("selChip").innerHTML = `${selected.size} selected <span aria-hidden="true">×</span>`;
  $("filterLive").classList.toggle("on", liveOnly);
}

$("rows").addEventListener("change", (e) => {
  const key = e.target.dataset.sel;
  if (!key) return;
  e.target.checked ? selected.add(key) : selected.delete(key);
  renderTable();
});
$("rows").addEventListener("click", (e) => {
  const btn = e.target.closest("[data-reask]");
  if (!btn) return;
  const row = rowsData().find((r) => r.key === btn.dataset.reask);
  $("askInput").value = (row && questionOf(row)) ?? "";
  $("home").scrollIntoView({ behavior: "smooth" });
  $("askForm").requestSubmit();
});
$("selAll").addEventListener("change", () => {
  const keys = rowsData().map((r) => r.key);
  if ($("selAll").checked) keys.forEach((key) => selected.add(key));
  else keys.forEach((key) => selected.delete(key));
  renderTable();
});
$("selChip").addEventListener("click", () => { selected.clear(); renderTable(); });
$("filterLive").addEventListener("click", () => { liveOnly = !liveOnly; renderTable(); });
$("export").addEventListener("click", () => {
  const rows = rowsData().filter((r) => !selected.size || selected.has(r.key));
  const cells = [["session", "turn", "question", "asker", "result", "route", "tokens", "tokens_per_s", "first_token_s", "time"],
    ...rows.map((r) => [r.id, r.turn, questionOf(r) ?? "", r.asker, r.status, r.route.join(" > "), r.tokens,
      r.msPerToken ? (1000 / r.msPerToken).toFixed(2) : "", r.firstMs != null ? (r.firstMs / 1000).toFixed(2) : "", new Date(r.at).toISOString()])];
  const csv = cells.map((row) => row.map((c) => `"${String(c).replace(/"/g, '""')}"`).join(",")).join("\n");
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([csv], { type: "text/csv" }));
  a.download = "swarm-answers.csv";
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
});

// --- Overview chart ---

const TABS = {
  throughput: { unit: "tok/s", main: ["generatedPerSec", "answer tokens"], faint: ["servedPerBlock", "served per block"] },
  phones: { unit: "phones", main: ["ready", "ready"], faint: ["phones", "joined"] },
  latency: { unit: "ms", main: ["hopMs", "per hop"], faint: ["rttMs", "ping"] },
};
let tab = "throughput";
let hoverFromEnd = 0; // which point the tooltip sits on, counted from the newest

function chartSvg() {
  const pts = state.history.slice(-Number($("range").value)).map((h) => ({ ...h, servedPerBlock: h.servedPerSec / state.blocks.length }));
  const W = 340, H = 236, x0 = 18, x1 = 322, y0 = 30, y1 = 184;
  if (pts.length < 2) {
    return `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Collecting data"><text x="${W / 2}" y="${H / 2}" text-anchor="middle" font-size="12" fill="#a9a8b6">Collecting data: a point every 5 seconds</text></svg>`;
  }
  const t = TABS[tab];
  const val = (p, k) => p[k] ?? null;
  const all = pts.flatMap((p) => [val(p, t.main[0]), val(p, t.faint[0])]).filter((v) => v != null);
  const max = Math.max(...all, tab === "phones" ? 2 : 1) * 1.18;
  const X = (i) => x0 + ((x1 - x0) * i) / (pts.length - 1);
  const Y = (v) => y1 - ((y1 - y0) * v) / max;
  const line = (k) => {
    let d = "", pen = false;
    pts.forEach((p, i) => { const v = val(p, k); if (v == null) { pen = false; return; } d += `${pen ? "L" : "M"}${X(i).toFixed(1)} ${Y(v).toFixed(1)} `; pen = true; });
    return d;
  };
  const labels = 7;
  const hi = Math.max(0, pts.length - 1 - hoverFromEnd);
  let svg = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(t.main[1])} over time" id="chartSvg">`;
  for (let g = 0; g <= 4; g++) {
    const y = y0 + ((y1 - y0) * g) / 4;
    svg += `<line x1="${x0}" x2="${x1}" y1="${y}" y2="${y}" stroke="#ececf2" stroke-dasharray="1 4" stroke-linecap="round"/>`;
  }
  // Labels at round times back from now (every 10 s, 30 s, 1 min, ...), at most `labels` of them.
  const span = (pts.at(-1).t - pts[0].t) / 1000;
  const step = [5, 10, 15, 20, 30, 60, 120, 300, 600].find((s) => span / s < labels) ?? 600;
  const perSec = (pts.length - 1) / span; // points per second
  for (let ago = 0; ago <= span + 0.5; ago += step) {
    const i = pts.length - 1 - ago * perSec, x = X(i);
    svg += `<line x1="${x}" x2="${x}" y1="${y0}" y2="${y1}" stroke="#ececf2" stroke-dasharray="1 4" stroke-linecap="round"/>`;
    const text = ago === 0 ? "now" : ago < 60 ? `-${ago}s`
      : ago % 60 ? `-${Math.floor(ago / 60)}:${String(ago % 60).padStart(2, "0")}` : `-${ago / 60}m`;
    const near = Math.abs(i - hi) <= (step * perSec) / 2;
    if (near) svg += `<circle cx="${x}" cy="${H - 22}" r="12" fill="#fff" stroke="#e4e2ec"/>`;
    svg += `<text x="${x}" y="${H - 18}" text-anchor="middle" font-size="10" fill="${near ? "#1b1a24" : "#a9a8b6"}" font-weight="${near ? 600 : 400}">${text}</text>`;
  }
  svg += `<path d="${line(t.faint[0])}" fill="none" stroke="#9ed9dd" stroke-width="1.6" stroke-linejoin="round"/>`;
  svg += `<path d="${line(t.main[0])}" fill="none" stroke="#6d4ce6" stroke-width="2.2" stroke-linejoin="round"/>`;
  const hv = val(pts[hi], t.main[0]);
  if (hv != null) {
    const x = X(hi), y = Y(hv), label = `${fmt.rate(hv)} ${t.unit}`;
    const bw = 16 + label.length * 6, bx = Math.min(x1 - bw + 10, Math.max(x0 - 10, x - bw - 8));
    svg += `<line x1="${x}" x2="${x}" y1="${y}" y2="${y1}" stroke="#1b1a24" stroke-dasharray="2 3"/>`;
    svg += `<circle cx="${x}" cy="${y}" r="5" fill="#fff" stroke="#6d4ce6" stroke-width="2.4"/>`;
    svg += `<rect x="${bx}" y="${Math.max(2, y - 11)}" width="${bw}" height="22" rx="11" fill="#1b1a24"/>`;
    svg += `<text x="${bx + bw / 2}" y="${Math.max(2, y - 11) + 14.5}" text-anchor="middle" font-size="10.5" font-weight="600" fill="#fff">${esc(label)}</text>`;
  }
  svg += `<rect x="${x0}" y="0" width="${x1 - x0}" height="${y1}" fill="transparent" data-hit="1"/></svg>`;
  const last = pts.at(-1);
  return svg + `<div class="now"><span class="live-dot"></span>Now <b>${fmt.rate(val(last, t.main[0]))} ${t.unit}</b> ${esc(t.main[1])}`
    + ` · <span style="color:#3fb3bb">${fmt.rate(val(last, t.faint[0]))}</span> ${esc(t.faint[1])}</div>`;
}

function renderChart() {
  $("chart").innerHTML = chartSvg();
}
$("chart").addEventListener("pointermove", (e) => {
  const svg = $("chartSvg");
  if (!svg) return;
  const n = state.history.slice(-Number($("range").value)).length;
  const box = svg.getBoundingClientRect();
  const fx = ((e.clientX - box.left) / box.width * 340 - 18) / (322 - 18);
  const i = Math.round(Math.min(1, Math.max(0, fx)) * (n - 1));
  const from = n - 1 - i;
  if (from !== hoverFromEnd) { hoverFromEnd = from; renderChart(); }
});
$("chart").addEventListener("pointerleave", () => { hoverFromEnd = 0; renderChart(); });
function setTab(next) {
  tab = next;
  document.querySelectorAll("#seg button").forEach((b) => b.classList.toggle("on", b.dataset.tab === tab));
  if (state) renderChart();
}
$("seg").addEventListener("click", (e) => { if (e.target.dataset.tab) setTab(e.target.dataset.tab); });
const tabNames = Object.keys(TABS);
$("prevTab").addEventListener("click", () => setTab(tabNames[(tabNames.indexOf(tab) + 2) % 3]));
$("nextTab").addEventListener("click", () => setTab(tabNames[(tabNames.indexOf(tab) + 1) % 3]));
$("range").addEventListener("change", () => state && renderChart());

// --- Activity log ---

const ICON = {
  join: '<path d="M12 5v14M5 12h14"/>',
  ready: '<path d="m5 12 5 5 9-10"/>',
  ask: '<path d="M4 5h16v11H8l-4 4z"/>',
  done: '<circle cx="12" cy="12" r="8"/><path d="m8.5 12 2.5 2.5 4.5-5"/>',
  reroute: '<path d="M4 7h11l-3-3M20 17H9l3 3"/>',
  left: '<path d="M10 4H5v16h5M15 8l4 4-4 4M19 12H9"/>',
  fail: '<path d="M6 6l12 12M18 6 6 18"/>',
  other: '<circle cx="12" cy="12" r="3"/>',
};
const TONE = { join: "var(--green)", ready: "var(--k0)", ask: "var(--purple)", done: "var(--green)", reroute: "var(--amber)", left: "var(--red)", fail: "var(--red)", other: "var(--muted)" };

// The tracker stamps its log in UTC (HH:MM:SS); this is that moment in ms.
function eventTime(hms, now) {
  const [h, m, s] = hms.split(":").map(Number), d = new Date(now);
  const t = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), h, m, s);
  return t > now + 60e3 ? t - 864e5 : t;
}

function parseEvent(line) {
  const at = eventTime(line.slice(0, 8), state.now);
  const time = new Date(at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false }), text = line.slice(9);
  const ev = (kind, group, title, main, sub = "") => ({ time, kind, group, title, main, sub });
  let m;
  if ((m = text.match(/^(\S+) joined, holds block (\d+) \((.+)\)/))) return ev("join", "phones", "Phone joined", `Phone ${m[1]} → Block ${m[2]}`, m[3]);
  if ((m = text.match(/^(\S+) joined as a client/))) return ev("join", "phones", "Asker connected", `${m[1]} asks without a block`, "Holds no weights, never computes");
  if ((m = text.match(/^(\S+) ready with block (\d+)/))) return ev("ready", "phones", "Block loaded", `Phone ${m[1]} is serving`, `Block ${m[2]} weights in memory`);
  if ((m = text.match(/^block (\d+) (\[\d+, \d+\)) splits into (.+?): (.+)/))) return ev("reroute", "phones", "Block split", `Block ${m[1]} ${m[2]} → ${m[3]}`, m[4]);
  if ((m = text.match(/^(\S+) moves to block (\d+) \((.+?)\): (.+)/))) return ev("reroute", "phones", "Phone moved", `Phone ${m[1]} → Block ${m[2]}`, `${m[3]}: ${m[4]}`);
  if ((m = text.match(/^(\S+) earns into (.+)/))) return ev("join", "phones", "Wallet linked", `Phone ${m[1]}`, `Earns into ${m[2]}`);
  if ((m = text.match(/^session (\d+)(?: turn (\d+))?: (\S+) asks(?: again)? via (.+)/))) return ev("ask", "answers", "Question asked", `Session ${m[1]}${m[2] ? ` turn ${m[2]}` : ""} by ${m[3]}`, `Route ${m[4]}`);
  if ((m = text.match(/^session (\d+)(?: turn (\d+))? done: (.+)/))) return ev("done", "answers", "Answer complete", `Session ${m[1]}${m[2] ? ` turn ${m[2]}` : ""}`, m[3]);
  if ((m = text.match(/^session (\d+) (?:saved to|updated on) Arkiv: (.+)/))) return ev("done", "answers", "Saved to Arkiv", `Session ${m[1]}`, m[2]);
  if ((m = text.match(/^session (\d+): saving to Arkiv failed: (.+)/))) return ev("fail", "problems", "Arkiv save failed", `Session ${m[1]}`, m[2]);
  if ((m = text.match(/^session (\d+)(?: turn \d+)?: continuing via (.+)/))) return ev("reroute", "problems", "Rerouted", `Session ${m[1]} → ${m[2]}`);
  if ((m = text.match(/^session (\d+)(?: turn \d+)?: (.+), waiting for phones to load/))) return ev("reroute", "problems", "Waiting for phones", `Session ${m[1]}`, m[2]);
  if ((m = text.match(/^session (\d+) expired (.+)/))) return ev("other", "answers", "Conversation closed", `Session ${m[1]}`, `Expired ${m[2]}`);
  if ((m = text.match(/^session (\d+)(?: turn \d+)? (cut|failed|ended)[: ](.*)/))) return ev("fail", "problems", m[2] === "ended" ? "Answer ended" : "Answer failed", `Session ${m[1]}`, m[3]);
  // A client (this dashboard, swarm/api.js) leaving takes no block with it: not a problem.
  if ((m = text.match(/^(\S+) (?:left|stopped responding) \(client\)/))) return ev("other", "phones", "Asker left", `${m[1]} disconnected`, "Was only asking; every block is unaffected");
  if ((m = text.match(/^(\S+) (left|stopped responding) \((.+)\)/))) return ev("left", "problems", m[2] === "left" ? "Phone left" : "Phone went silent", `Phone ${m[1]}`, m[3]);
  if ((m = text.match(/^(paying|payout|.+ withdrew) (.+)/))) return ev("other", "all", "Rewards", text);
  if ((m = text.match(/^dropped a bad frame (.+)/))) return ev("fail", "problems", "Bad frame", "Frame dropped", m[1]);
  return ev("other", "all", "Tracker", text);
}

let logKey = "";
function renderLog() {
  const filter = $("logFilter").value, q = $("logSearch").value.trim().toLowerCase();
  const key = `${state.events.length}|${state.events.at(-1)}|${filter}|${q}`;
  const items = state.events.map(parseEvent);
  $("bell").hidden = !items.slice(-10).some((e) => e.group === "problems");
  if (key === logKey) return;
  logKey = key;
  const shown = items.reverse()
    .filter((e) => filter === "all" || e.group === filter)
    .filter((e) => !q || `${e.title} ${e.main} ${e.sub}`.toLowerCase().includes(q))
    .slice(0, 30);
  $("logList").innerHTML = shown.length ? shown.map((e) => `<div class="log-item">
      <div class="lic" style="color:${TONE[e.kind]}"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${ICON[e.kind]}</svg></div>
      <div class="lt"><small style="color:${TONE[e.kind]}">${esc(e.title)}</small><b title="${esc(e.main)}">${esc(e.main)}</b><span title="${esc(e.sub)}">${esc(e.sub)}</span></div>
      <time>${esc(e.time.slice(0, 5))}</time></div>`).join("")
    : `<div class="empty">Nothing here yet.</div>`;
}
$("logFilter").addEventListener("change", () => state && renderLog());
$("logSearch").addEventListener("input", () => state && renderLog());
$("logSearchBtn").addEventListener("click", () => {
  $("logSearchWrap").hidden = !$("logSearchWrap").hidden;
  if (!$("logSearchWrap").hidden) $("logSearch").focus();
});

// --- Asking from the hero, as a client ---

let myId = null;
let askerConnected = false;
let tokenizerReady = false;
let asking = false;
const asker = new Peer({
  server: location.origin,
  role: "client",
  onEvent: (e) => { if (e.type === "closed") { askerConnected = false; myId = null; } },
});
asker.loadTokenizer()
  .then(() => { tokenizerReady = true; updateAsk(); })
  .catch((err) => { $("askStatus").textContent = `Couldn't load the tokenizer: ${err.message}`; });

// Blocks with no ready phone: an answer needs every block.
function missingBlocks() {
  if (!state) return [];
  return state.blocks.filter((b) => !serving().some((p) => p.block === b.index && p.ready));
}
const blockList = (bs) => {
  const n = bs.map((b) => b.index + 1);
  return n.length === 1 ? `block ${n[0]}` : `blocks ${n.slice(0, -1).join(", ")} and ${n.at(-1)}`;
};

function updateAsk() {
  const missing = missingBlocks();
  $("askGo").disabled = asking || !tokenizerReady || !state || missing.length > 0 || !$("askInput").value.trim();
  if (asking) return;
  $("askStatus").textContent = !tokenizerReady ? "Loading the tokenizer…"
    : !state ? "Connecting to the tracker…"
    : missing.length ? `Waiting for a phone to serve ${blockList(missing)}. Scan the QR code to join.`
    : `Ready. Your question goes through ${state.blocks.length} phones, one per block. This laptop only asks.`;
}
$("askInput").addEventListener("input", updateAsk);

$("askForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const text = $("askInput").value.trim();
  if (!text || asking || $("askGo").disabled) return;
  asking = true;
  updateAsk();
  $("answer").hidden = false;
  $("answerQ").textContent = text;
  const out = $("answerText");
  out.classList.remove("error");
  out.innerHTML = '<span class="caret"></span>';
  $("answerMeta").textContent = "";
  $("askStatus").textContent = "Asking the swarm…";
  let answer = "";
  try {
    if (!askerConnected) {
      await asker.connect();
      askerConnected = true;
      myId = asker.id;
    }
    const tok = asker.tokenizer;
    const decoder = tok.streamDecoder();
    let n = 0, firstMs = 0, restMs = 0, route = [], session = null;
    for await (const step of asker.ask(tok.chat([{ role: "user", content: text }]), { maxNew: 200, stopIds: tok.stopIds })) {
      if (session == null) { session = step.session; remember(session, myId, text); }
      n++;
      if (n === 1) firstMs = step.ms; else restMs += step.ms;
      route = step.route;
      answer += decoder.push(step.token);
      out.textContent = answer;
      out.insertAdjacentHTML("beforeend", '<span class="caret"></span>');
      $("answerMeta").innerHTML = `${routeChips(route)} <span>${plural(n, "token")} · first token ${fmt.secs(firstMs)}</span>`;
      $("askStatus").textContent = `Streaming through ${route.join(" → ")}…`;
    }
    answer += decoder.flush();
    out.textContent = answer;
    const speed = n > 1 ? `${fmt.rate((1000 * (n - 1)) / restMs)} tok/s` : "";
    $("answerMeta").innerHTML = `${routeChips(route)} <span>${plural(n, "token")} · first token ${fmt.secs(firstMs)}${speed ? ` · then ${speed}` : ""}</span>`;
    $("askInput").value = "";
  } catch (err) {
    out.textContent = answer;
    out.classList.add("error");
    out.textContent += (answer ? "\n" : "") + err.message;
  }
  asking = false;
  updateAsk();
});

// --- Section highlighting in the sidebar ---

const NAMES = { home: "Home", map: "Swarm Map", answers: "Answers", log: "Activity Log" };
const observer = new IntersectionObserver((entries) => {
  const top = entries.filter((e) => e.isIntersecting).sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top)[0];
  if (!top) return;
  document.querySelectorAll("[data-nav]").forEach((a) => a.classList.toggle("on", a.dataset.nav === top.target.id));
  $("crumb").textContent = NAMES[top.target.id];
}, { rootMargin: "-20% 0px -60% 0px" });
Object.keys(NAMES).forEach((id) => observer.observe($(id)));

// --- Collected here: what the tracker's state doesn't carry ---

// The model and each block's size, from the manifest the phones load.
let manifest = null;
fetch("/weights/manifest.json").then((r) => r.json()).then((m) => {
  manifest = m;
  if (state) { enrich(state); render(); }
}).catch(() => {});

function modelInfo() {
  if (!manifest) return null;
  const c = manifest.config;
  const files = [manifest.embed, manifest.final_norm, ...manifest.layers, ...(manifest.lm_head ? [manifest.lm_head] : [])];
  return {
    name: manifest.source.split("/").at(-1) + (manifest.dtype && manifest.dtype !== "float32" ? ` · ${manifest.dtype}` : ""),
    source: manifest.source,
    bytes: files.reduce((sum, f) => sum + f.bytes, 0),
    params: files.flatMap((f) => f.tensors).reduce((sum, t) => sum + t.shape.reduce((a, b) => a * b, 1), 0),
    layers: c.num_layers, hopBytes: c.hidden_size * 4,
  };
}

// The weights a phone holding this block downloads (the same files as Peer.loadBlock).
function blockBytes({ start, end }) {
  const L = manifest.config.num_layers;
  const files = manifest.layers.slice(start, end);
  if (start === 0 || (end === L && !manifest.lm_head)) files.push(manifest.embed);
  if (end === L) files.push(manifest.final_norm, ...(manifest.lm_head ? [manifest.lm_head] : []));
  return files.reduce((sum, f) => sum + f.bytes, 0);
}

// The chart: a point every 5 seconds from the moment this page opened.
const history = [];
let lastTotals = null;
function sampleHistory() {
  if (!state) return;
  const t = Date.now(), { generated, served } = state.throughput, prev = lastTotals;
  lastTotals = { t, generated, served };
  if (!prev) return;
  const dt = (t - prev.t) / 1000;
  const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
  history.push({
    t, generatedPerSec: (generated - prev.generated) / dt, servedPerSec: (served - prev.served) / dt,
    phones: state.peers.length, ready: state.peers.filter((p) => p.ready).length, sessions: state.sessions.length,
    hopMs: mean(state.peers.map((p) => p.tokenMs).filter((x) => x != null)),
    rttMs: mean(state.peers.map((p) => p.rtt).filter((x) => x != null)),
  });
  if (history.length > 120) history.shift();
  renderChart();
}
setInterval(sampleHistory, 5000);

// Finished answers, from the tracker's log, which keeps only its last lines:
// "session 3: D asks via A → B → C" then "session 3 done: 75 tokens, first
// token 4.3 s, then 137 ms per token · per hop A 26 ms, ...". Keyed by session and turn.
const answers = new Map();
const asks = new Map(); // "session.turn" -> asker
function collectAnswers(events, now) {
  for (const line of events) {
    const text = line.slice(9);
    let m;
    if ((m = text.match(/^session (\d+)(?: turn (\d+))?: (\S+) asks/))) asks.set(`${m[1]}.${m[2] ?? 1}`, m[3]);
    m = text.match(/^session (\d+)(?: turn (\d+))? (.+?): (\d+) tokens, first token ([\d.]+) s(?:, then (\d+) ms per token)? · per hop (.*?)(?: · rerouted (\d+)×)?$/);
    if (!m) continue;
    const key = `${m[1]}.${m[2] ?? 1}`;
    if (answers.has(key)) continue;
    const why = m[3];
    answers.set(key, {
      key, id: Number(m[1]), turn: Number(m[2] ?? 1), asker: asks.get(key) ?? "?",
      route: m[7].split(", ").map((hop) => hop.split(" ")[0]), tokens: Number(m[4]), reroutes: Number(m[8] ?? 0),
      firstMs: 1000 * Number(m[5]), msPerToken: m[6] ? Number(m[6]) : null, at: eventTime(line.slice(0, 8), now),
      status: why === "done" ? "done" : /^(cut|failed)/.test(why) ? "failed" : "ended",
    });
  }
}

// When this page first saw each answer in progress, for its live timing.
const seen = new Map(); // "session.turn" -> { startAt, firstAt }
function enrich(msg) {
  msg.model = modelInfo();
  if (manifest) msg.blocks = msg.blocks.map((b) => ({ ...b, bytes: blockBytes(b) }));
  // Idle conversations (between a phone's questions) hold KV caches but aren't answering.
  msg.sessions = msg.sessions.filter((s) => s.active).map((s) => {
    const key = `${s.id}.${s.turn}`;
    const t = seen.get(key) ?? { startAt: msg.now, firstAt: 0 };
    if (s.tokens && !t.firstAt) t.firstAt = msg.now;
    seen.set(key, t);
    return { ...s, ...t };
  });
  collectAnswers(msg.events, msg.now);
  msg.recent = [...answers.values()].sort((a, b) => b.at - a.at).slice(0, 20);
  msg.history = history;
  return msg;
}

// --- Watching the tracker ---

function render() {
  renderModel();
  renderTiles();
  renderMap();
  renderTable();
  renderChart();
  renderLog();
  updateAsk();
  if (!$("joinModal").hidden) showQr();
}

function connect() {
  const ws = new WebSocket(location.origin.replace(/^http/, "ws") + "/ws");
  ws.onopen = () => {
    $("conn").innerHTML = `<span class="live-dot"></span>${esc(location.host)} · live`;
    ws.send(JSON.stringify({ type: "watch" }));
  };
  ws.onmessage = (e) => {
    const msg = JSON.parse(e.data);
    if (msg.type !== "state") return;
    const first = !state;
    state = enrich(msg);
    if (first) sampleHistory();
    render();
  };
  ws.onclose = () => {
    $("conn").innerHTML = '<span class="live-dot off"></span>reconnecting…';
    setTimeout(connect, 2000);
  };
}
connect();
