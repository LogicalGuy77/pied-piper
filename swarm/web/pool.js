// The PIPER/USDC pool: its price now and over time, what it holds, what a
// swap would give, and its activity. Everything comes from the tracker's
// /market/pool (the PoolManager's storage and events) and /market/quote.

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
const shortHex = (hex) => `${hex.slice(0, 6)}…${hex.slice(-4)}`;
const price = (x) => (x == null ? "–" : x.toPrecision(4));
const amount = (x, digits = 4) => (x == null ? "–" : x.toLocaleString(undefined, { maximumFractionDigits: digits }));
const pct = (x, signed = true) => (x == null ? "–" : `${signed && x > 0 ? "+" : ""}${(100 * x).toFixed(2)}%`);
const when = (ms) => new Date(ms).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", second: "2-digit" });

let pool = null;   // the last /market/pool
let range = 0;     // ms shown by the chart; 0 for all

function tile(value, label, sub = "") {
  return `<div class="tile"><b>${value}</b><span>${label}</span>${sub ? `<div class="muted">${sub}</div>` : ""}</div>`;
}

async function read() {
  try {
    const res = await fetch("/market/pool");
    const p = await res.json();
    if (!res.ok) throw new Error(p.error);
    pool = p;
    $("conn").textContent = `updated ${new Date().toLocaleTimeString()}`;
    render();
  } catch (err) {
    $("conn").textContent = err.message;
  }
}

// The price as a step line: each event's price holds until the next, and the last until now.
function points() {
  const pts = pool.history.events.filter((e) => e.price != null && e.at != null).map((e) => ({ t: e.at, p: e.price, e }));
  pts.push({ t: Date.now(), p: pool.state.price, now: true });
  return pts;
}

function priceAt(pts, t) {
  let p = pts[0].p;
  for (const x of pts) if (x.t <= t) p = x.p;
  return p;
}

function render() {
  const { state, history, info, sponsor } = pool;
  const explorer = info.explorer;
  const pts = points();
  const start = range ? Math.max(pts[0].t, Date.now() - range) : pts[0].t;
  const before = priceAt(pts, start);
  const change = state.price / before - 1;

  $("price").textContent = price(state.price);
  $("change").innerHTML = `<span class="${change >= 0 ? "up" : "down"}">${pct(change)}</span> <span class="muted">${range ? `in the last ${range >= 86400000 ? "24 h" : "hour"}` : "since the pool opened"} (from ${price(before)})</span>`;
  $("inverse").textContent = `1 USDC buys about ${amount(1 / state.price, 2)} PIPER before fees · an answer token costs ${info.tokenPrice} PIPER, about ${price(Number(info.tokenPrice) * state.price)} USDC`;
  drawChart(pts, start);

  const usdcShare = state.usdc / state.tvlUsdc;
  $("tiles").innerHTML = [
    tile(amount(state.piper, 2), "PIPER in the pool", `worth ${amount(state.piper * state.price, 2)} USDC`),
    tile(amount(state.usdc, 2), "USDC in the pool", `<a href="${explorer}/token/${info.usdc.address}" target="_blank" rel="noopener">Circle's Sepolia USDC</a>`),
    tile(amount(state.tvlUsdc, 2), "USDC total value", "both sides at the pool's price"),
    tile(String(history.events.filter((e) => e.type === "buy" || e.type === "sell").length), "swaps", `${history.events.filter((e) => e.type === "buy").length} buys · ${history.events.filter((e) => e.type === "sell").length} sells`),
    tile(`${amount(Number(sponsor.piper), 2)} / ${amount(Number(sponsor.usdc), 4)}`, "PIPER / USDC to the gas sponsor", `the hook's cut so far · <a class="mono" href="${explorer}/address/${sponsor.address}" target="_blank" rel="noopener">${shortHex(sponsor.address)}</a>`),
  ].join("");
  $("bar").innerHTML = `<i style="width:${100 * (1 - usdcShare)}%"></i><i style="width:${100 * usdcShare}%"></i>`;
  $("barNote").innerHTML = `<span style="color:var(--purple)">■</span> PIPER ${pct(1 - usdcShare, false)} · <span style="color:var(--green)">■</span> USDC ${pct(usdcShare, false)} of the value, by the pool's price`;
  $("feesNote").innerHTML = `Every swap pays the liquidity providers ${pct(state.fees.lp, false)} of its input and the gas sponsor ${pct(state.fees.hookSwap, false)} of its output, through the pool's hook `
    + `(<a class="mono" href="${explorer}/address/${info.hook}" target="_blank" rel="noopener">${shortHex(info.hook)}</a>); deposits pay it ${pct(state.fees.hookDeposit, false)}. `
    + `The liquidity spans every price (full range): ${amount(Number(state.liquidity), 0)} liquidity, tick ${state.tick}. Phones swap through the router `
    + `<a class="mono" href="${explorer}/address/${info.router}" target="_blank" rel="noopener">${shortHex(info.router)}</a> with only a signature.`;

  const names = { buy: "Buy", sell: "Sell", deposit: "Deposit", withdraw: "Withdraw", open: "Opened" };
  $("activity").innerHTML = `<tr><th>Time</th><th class="l">What</th><th>PIPER</th><th>USDC</th><th>Price after</th><th class="l">Transaction</th></tr>`
    + [...history.events].reverse().map((e) => `<tr><td>${e.at ? when(e.at) : "–"}</td><td class="l"><span class="tag ${e.type}">${names[e.type] ?? e.type}</span></td>
      <td>${amount(e.piper, 4)}</td><td>${amount(e.usdc, 6)}</td><td>${price(e.price)}</td>
      <td class="l"><a class="mono" href="${explorer}/tx/${e.tx}" target="_blank" rel="noopener">${shortHex(e.tx)}</a></td></tr>`).join("");
}

function drawChart(pts, start) {
  const svg = $("chart");
  const W = svg.clientWidth || 800, H = 260, L = 64, R = 12, T = 12, B = 26;
  const end = Date.now();
  const shown = [{ t: start, p: priceAt(pts, start) }, ...pts.filter((x) => x.t > start)];
  const ps = shown.map((x) => x.p);
  let lo = Math.min(...ps), hi = Math.max(...ps);
  const pad = (hi - lo) * 0.15 || lo * 0.02;
  lo -= pad;
  hi += pad;
  const x = (t) => L + ((t - start) / Math.max(1, end - start)) * (W - L - R);
  const y = (p) => T + (1 - (p - lo) / (hi - lo)) * (H - T - B);
  let d = `M${x(shown[0].t)},${y(shown[0].p)}`;
  for (let i = 1; i < shown.length; i++) d += `H${x(shown[i].t)}V${y(shown[i].p)}`;
  d += `H${x(end)}`;
  const up = shown.at(-1).p >= shown[0].p;
  const color = up ? "var(--green)" : "var(--red)";
  const grid = [0, 0.5, 1].map((f) => {
    const p = lo + pad + f * (hi - lo - 2 * pad);
    return `<line x1="${L}" x2="${W - R}" y1="${y(p)}" y2="${y(p)}" stroke="var(--line)"/><text x="${L - 8}" y="${y(p) + 4}" text-anchor="end" font-size="11" fill="var(--muted)">${price(p)}</text>`;
  }).join("");
  const dots = pts.filter((q) => q.e && (q.e.type === "buy" || q.e.type === "sell") && q.t >= start)
    .map((q) => `<circle cx="${x(q.t)}" cy="${y(q.p)}" r="4" fill="${q.e.type === "buy" ? "var(--green)" : "var(--red)"}" stroke="var(--surface)" stroke-width="1.5"/>`).join("");
  svg.setAttribute("viewBox", `0 0 ${W} ${H}`);
  svg.innerHTML = `${grid}
    <path d="${d}V${H - B}H${x(shown[0].t)}Z" fill="${color}" opacity=".08"/>
    <path d="${d}" fill="none" stroke="${color}" stroke-width="2"/>${dots}
    <text x="${L}" y="${H - 6}" font-size="11" fill="var(--muted)">${when(start)}</text>
    <text x="${W - R}" y="${H - 6}" font-size="11" fill="var(--muted)" text-anchor="end">now</text>
    <line id="cross" y1="${T}" y2="${H - B}" stroke="var(--soft)" stroke-dasharray="3 3" visibility="hidden"/>`;
  svg.onmousemove = (ev) => {
    const box = svg.getBoundingClientRect();
    const px = ((ev.clientX - box.left) / box.width) * W;
    if (px < L || px > W - R) return hideTip();
    const t = start + ((px - L) / (W - L - R)) * (end - start);
    const p = priceAt(pts, t);
    const cross = svg.querySelector("#cross");
    cross.setAttribute("x1", px);
    cross.setAttribute("x2", px);
    cross.setAttribute("visibility", "visible");
    const tip = $("tip");
    tip.style.display = "block";
    tip.style.left = `${(px / W) * box.width}px`;
    tip.style.top = `${(y(p) / H) * box.height}px`;
    tip.textContent = `${price(p)} USDC · ${when(t)}`;
  };
  svg.onmouseleave = hideTip;
}

function hideTip() {
  $("tip").style.display = "none";
  $("chart").querySelector("#cross")?.setAttribute("visibility", "hidden");
}

$("ranges").addEventListener("click", (ev) => {
  const b = ev.target.closest("button");
  if (!b) return;
  range = Number(b.dataset.r);
  for (const x of $("ranges").children) x.classList.toggle("on", x === b);
  if (pool) render();
});

// --- What a swap would give ---

let quoteTimer = null;
let quoteSeq = 0;
function requote() {
  clearTimeout(quoteTimer);
  const side = $("side").value;
  $("unit").textContent = side === "buy" ? "USDC" : "PIPER";
  const value = $("amount").value.trim();
  if (!(Number(value) > 0)) return ($("out").innerHTML = `<div class="muted">Enter how much ${side === "buy" ? "USDC to pay" : "PIPER to sell"}.</div>`);
  $("out").innerHTML = `<div class="muted">Asking the pool…</div>`;
  const seq = ++quoteSeq;
  quoteTimer = setTimeout(async () => {
    try {
      const res = await fetch(`/market/quote?side=${side}&amount=${encodeURIComponent(value)}`);
      const q = await res.json();
      if (seq !== quoteSeq) return;
      if (!res.ok) throw new Error(q.error);
      const out = side === "buy" ? Number(q.amountOut) / 1e18 : Number(q.amountOut) / 1e6;
      const outSym = side === "buy" ? "PIPER" : "USDC";
      $("out").innerHTML = `<div class="big">${amount(out, side === "buy" ? 4 : 6)} ${outSym}</div>
        <div class="row"><span>Pool price now</span><b>${price(q.price)} USDC per PIPER</b></div>
        <div class="row"><span>Your price, every fee in</span><b>${price(q.rate)} USDC per PIPER</b></div>
        <div class="row"><span>${side === "buy" ? "You pay more than the pool price by" : "You get less than the pool price by"}</span><b class="${q.cost > 0.05 ? "warn" : ""}">${pct(q.cost, false)}</b></div>
        <div class="row"><span>Pool price after</span><b>${price(q.priceAfter)} <span class="${q.move >= 0 ? "up" : "down"}">(${pct(q.move)})</span></b></div>
        <div class="row"><span>The least a phone accepts (1% slippage)</span><b>${amount(out * 0.99, side === "buy" ? 4 : 6)} ${outSym}</b></div>
        ${q.cost > 0.05 ? `<div class="warn">The pool is small: this trade moves the price by ${pct(Math.abs(q.move), false)}. Smaller trades get closer to the pool price.</div>` : ""}`;
    } catch (err) {
      if (seq === quoteSeq) $("out").innerHTML = `<div class="down">${esc(err.message)}</div>`;
    }
  }, 300);
}
$("side").addEventListener("change", () => {
  $("amount").value = $("side").value === "buy" ? "1" : "100";
  requote();
});
$("amount").addEventListener("input", requote);
$("calc").addEventListener("submit", (ev) => ev.preventDefault());
addEventListener("resize", () => pool && render());

read();
requote();
setInterval(read, 15000);
