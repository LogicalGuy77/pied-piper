// The laptop's view of the swarm: a QR code for joining, every phone's
// block and measurements, the questions in flight and the tracker's log.
// It watches the tracker over the same WebSocket the phones use.

const $ = (id) => document.getElementById(id);
const URL_KEY = "swarm-dashboard-url";
let state = null;

// The address phones open: ?url=, then one typed here before, then the
// tracker's --public-url, then this page's own address.
function phoneUrl() {
  return new URLSearchParams(location.search).get("url") || localStorage.getItem(URL_KEY)
    || state?.publicUrl || location.origin;
}

let shownUrl = null;
function showQr() {
  const url = phoneUrl();
  if (url === shownUrl) return;
  shownUrl = url;
  $("qr").src = `/qr.svg?text=${encodeURIComponent(url)}`;
  if (document.activeElement !== $("url")) $("url").value = url;
}

$("url").addEventListener("change", () => {
  const url = $("url").value.trim();
  if (url) localStorage.setItem(URL_KEY, url);
  else localStorage.removeItem(URL_KEY);
  showQr();
});

const ms = (x) => (x == null ? "–" : `${Math.round(x)} ms`);
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);

function phoneCard(p) {
  const r = p.report ?? {};
  const flags = [];
  if (!p.ready) flags.push(["loading", ""]);
  if (p.busy) flags.push(["computing", ""]);
  if (r.hidden) flags.push(["in background", "bad"]);
  else if (r.wakeLock === false) flags.push(["no wake lock", "warn"]);
  if (p.silentMs > 2500) flags.push([`silent ${(p.silentMs / 1000).toFixed(0)} s`, "bad"]);
  if (r.battery != null) flags.push([`${r.battery}%${r.charging ? " ⚡" : ""}`, r.battery < 20 && !r.charging ? "warn" : ""]);
  const lines = [
    `ping ${ms(p.rtt)} · token ${ms(p.tokenMs)} · prefill ${p.prefillMsPerToken == null ? "–" : `${p.prefillMsPerToken.toFixed(0)} ms/tok`}`,
    `served ${p.served} tok · ${p.sessions} answering${p.idleSessions ? `, ${p.idleSessions} idle` : ""}${r.avgComputeMs ? ` · compute ${r.avgComputeMs.toFixed(0)} ms/tok` : ""}`,
  ];
  if (r.device || r.cores) lines.push([r.device, r.cores && `${r.cores} cores`, r.memoryGB && `${r.memoryGB} GB`].filter(Boolean).join(" · "));
  return `<div class="phone${p.ready ? "" : " loading"}">
    <div class="top"><span>${esc(p.id)}</span><span>${flags.map(([t, c]) => `<span class="flag ${c}">${esc(t)}</span>`).join(" ")}</span></div>
    <div class="mono muted">${lines.map(esc).join("<br>")}</div></div>`;
}

function render() {
  showQr();
  $("nPhones").textContent = state.peers.length;
  $("nSessions").textContent = state.sessions.filter((s) => s.active).length;
  $("nServed").textContent = state.peers.reduce((sum, p) => sum + p.served, 0);
  $("blocks").innerHTML = state.blocks.map((b) => {
    const holders = state.peers.filter((p) => p.block === b.index);
    const ready = holders.filter((p) => p.ready).length;
    const parts = b.start === 0 ? ["embedding"] : [];
    parts.push(`layers ${b.start}–${b.end - 1}`);
    if (b.end === state.blocks.at(-1).end) parts.push("output");
    const warn = ready === 0 ? "no phone ready: questions wait" : ready === 1 ? "only one phone: no backup" : "";
    return `<div class="block" data-b="${b.index % 3}">
      <div class="name">Block ${b.index + 1} · ${ready} ready</div>
      <div class="muted" style="font-size:12px">${parts.join(" + ")}</div>
      ${warn ? `<div class="warn">${warn}</div>` : ""}
      ${holders.map(phoneCard).join("")}</div>`;
  }).join("");
  $("sessions").textContent = state.sessions.length
    ? state.sessions.map((s) => `#${s.id}  ${s.asker} ${s.active ? "asks" : "idle"} via ${s.route.join(" → ")} · ` +
      (s.active ? `${s.tokens} tokens` : `${s.context} tokens cached`) +
      `${s.turn > 1 ? ` · turn ${s.turn}` : ""}${s.reroutes ? ` · rerouted ${s.reroutes}×` : ""}`).join("\n")
    : "None right now.";
  const log = $("events");
  const atBottom = log.scrollTop + log.clientHeight >= log.scrollHeight - 4;
  log.textContent = state.events.join("\n");
  if (atBottom) log.scrollTop = log.scrollHeight;
}

function connect() {
  const ws = new WebSocket(location.origin.replace(/^http/, "ws") + "/ws");
  ws.onopen = () => {
    $("conn").textContent = "Connected to the tracker.";
    ws.send(JSON.stringify({ type: "watch" }));
  };
  ws.onmessage = (e) => {
    const msg = JSON.parse(e.data);
    if (msg.type !== "state") return;
    state = msg;
    render();
  };
  ws.onclose = () => {
    $("conn").textContent = "Lost the tracker. Reconnecting…";
    setTimeout(connect, 2000);
  };
}

showQr();
connect();
