// The management view: throughput, capacity and utilization for the swarm,
// each block and each phone. Watches the tracker like the demo dashboard.

const $ = (id) => document.getElementById(id);

const num = (x, digits = 1) => (x == null || !Number.isFinite(x) ? "–" : x.toFixed(digits));
const ms = (x) => (x == null ? "–" : `${Math.round(x)} ms`);
const pct = (x) => (x == null ? "–" : `${Math.round(100 * x)}%`);
const dur = (msTotal) => {
  const s = Math.round(msTotal / 1000);
  return s < 60 ? `${s} s` : s < 3600 ? `${Math.floor(s / 60)} min ${s % 60} s` : `${Math.floor(s / 3600)} h ${Math.floor((s % 3600) / 60)} min`;
};
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
const capacity = (p) => (p.report?.decodeMsPerToken ? 1000 / p.report.decodeMsPerToken : null);
const utilBar = (u) => (u == null ? "–" : `${pct(u)}<span class="util${u > 0.85 ? " hot" : ""}"><i style="width:${Math.min(100, 100 * u)}%"></i></span>`);

function tile(value, label, sub = "") {
  return `<div class="tile"><b>${value}</b><span>${label}</span>${sub ? `<div class="muted">${sub}</div>` : ""}</div>`;
}

function render(state) {
  const t = state.throughput;
  const ready = state.peers.filter((p) => p.ready);
  // Fastest answer the swarm could give one asker right now: the quickest
  // ready phone of each block, one after another.
  const bestHop = state.blocks.map((b) => Math.min(...ready.filter((p) => p.block === b.index && p.tokenMs != null).map((p) => p.tokenMs)));
  const fastest = bestHop.every(Number.isFinite) ? 1000 / bestHop.reduce((a, b) => a + b, 0) : null;

  $("tiles").innerHTML = [
    tile(num(t.generatedPerSec), "answer tok/s", "last minute, all askers together"),
    tile(num(t.generatedPerSecWhileAnswering), "answer tok/s while answering", `averaged over ${dur(t.answeringMs)} with a question in flight`),
    tile(num(t.perAnswer), "tok/s per answer", t.answers ? `average of the last ${t.answers} answers` : "no finished answers yet"),
    tile(num(fastest), "fastest possible tok/s", "one asker, quickest phone per block"),
    tile(num(t.servedPerSec), "served tok/s", "all phones, all blocks, last minute"),
    tile(t.generated.toLocaleString(), "answer tokens", `${t.served.toLocaleString()} served · up ${dur(t.uptimeMs)}`),
    tile(`${ready.length}<span class="muted" style="font-size:14px"> / ${state.peers.length}</span>`, "phones ready", `${state.sessions.filter((s) => s.active).length} answering now`),
  ].join("");

  const blockRows = state.blocks.map((b) => {
    const holders = state.peers.filter((p) => p.block === b.index);
    const r = holders.filter((p) => p.ready);
    const caps = r.map(capacity).filter((x) => x != null);
    const utils = r.map((p) => p.utilization).filter((x) => x != null);
    const served = r.map((p) => p.servedPerSec).filter((x) => x != null);
    const parts = b.start === 0 ? ["embedding"] : [];
    parts.push(b.end - b.start > 1 ? `layers ${b.start}–${b.end - 1}` : `layer ${b.start}`);
    if (b.end === state.blocks.at(-1).end) parts.push("output");
    return { b, holders, r, label: parts.join(" + "), cap: caps.length ? caps.reduce((x, y) => x + y, 0) : null,
      util: utils.length ? utils.reduce((x, y) => x + y, 0) / utils.length : null,
      served: served.length ? served.reduce((x, y) => x + y, 0) : null };
  });
  const minCap = Math.min(...blockRows.map((x) => x.cap ?? Infinity));
  $("blocks").innerHTML = `<tr><th>Block</th><th class="l">Holds</th><th>Phones ready</th><th>Capacity tok/s</th><th>Served tok/s</th><th>Avg utilization</th><th class="l"></th></tr>`
    + blockRows.map((x) => `<tr class="b${x.b.index % 3}"><td>Block ${x.b.index + 1}</td><td class="l muted">${x.label}</td>
      <td class="${x.r.length < 2 ? "bad" : ""}">${x.r.length} / ${x.holders.length}</td><td>${num(x.cap)}</td><td>${num(x.served)}</td>
      <td>${utilBar(x.util)}</td><td class="l">${x.cap != null && x.cap === minCap && blockRows.length > 1 ? '<span class="warn">bottleneck</span>' : ""}</td></tr>`).join("");

  const phones = [...state.peers].sort((a, b) => a.block - b.block || a.joinedAt - b.joinedAt);
  $("phones").innerHTML = `<tr><th>Phone</th><th>Block</th><th class="l">Status</th><th>Served tok/s</th><th>Avg tok/s since join</th>
    <th>Capacity tok/s</th><th>Utilization</th><th>Compute / token</th><th>Hop time</th><th>Network</th><th>Ping</th>
    <th>Served</th><th>Battery</th><th class="l">Device</th></tr>`
    + phones.map((p) => {
      const r = p.report ?? {};
      const age = (state.now - p.joinedAt) / 1000;
      const status = [];
      if (!p.ready) status.push("loading");
      else if (p.busy) status.push("computing");
      else status.push("idle");
      if (p.sessions) status.push(`${p.sessions} session${p.sessions > 1 ? "s" : ""}`);
      if (r.queued) status.push(`${r.queued} queued`);
      if (r.hidden) status.push('<span class="bad">background</span>');
      if (p.silentMs > 2500) status.push(`<span class="bad">silent ${Math.round(p.silentMs / 1000)} s</span>`);
      const network = p.tokenMs != null && r.decodeMsPerToken != null ? Math.max(0, p.tokenMs - r.decodeMsPerToken) : null;
      return `<tr class="b${p.block % 3}"><td><b>${esc(p.id)}</b></td><td>${p.block + 1}</td><td class="l">${status.join(" · ")}</td>
        <td>${num(p.servedPerSec)}</td><td>${num(age > 0 ? p.served / age : null)}</td><td>${num(capacity(p))}</td>
        <td>${utilBar(p.utilization)}</td><td>${ms(r.decodeMsPerToken)}</td><td>${ms(p.tokenMs)}</td><td>${ms(network)}</td><td>${ms(p.rtt)}</td>
        <td>${p.served.toLocaleString()}</td><td>${r.battery != null ? `${r.battery}%${r.charging ? " ⚡" : ""}` : "–"}</td>
        <td class="l muted">${esc([r.device, r.cores && `${r.cores} cores`, r.memoryGB && `${r.memoryGB} GB`].filter(Boolean).join(" · "))}</td></tr>`;
    }).join("");
}

function connect() {
  const ws = new WebSocket(location.origin.replace(/^http/, "ws") + "/ws");
  ws.onopen = () => {
    $("conn").textContent = "live";
    ws.send(JSON.stringify({ type: "watch" }));
  };
  ws.onmessage = (e) => {
    const msg = JSON.parse(e.data);
    if (msg.type === "state") render(msg);
  };
  ws.onclose = () => {
    $("conn").textContent = "reconnecting…";
    setTimeout(connect, 2000);
  };
}

connect();
