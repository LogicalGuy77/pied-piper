// The laptop's tracker. Serves the phone page, the dashboard and the weights
// over HTTP and runs the swarm over a WebSocket at /ws: assigns and rebalances
// blocks, picks routes, reroutes answers when a phone leaves, and in v1 relays
// every frame between phones.
//
//   node swarm/tracker.js [--port 8080] [--host 0.0.0.0] [--weights DIR]
//                         [--min-blocks 3] [--min-replica 2]
//                         [--tls-cert FILE --tls-key FILE] [--public-url URL]
//                         [--heartbeat-timeout 5000] [--busy-timeout 20000] [--session-idle 600000]
//
// Blocks: the first phones make one whole path of --min-blocks blocks, the
// next ones give every block --min-replica holders, and after that the
// largest block splits in two each time it gathers enough phones for both
// halves (src/blocks.js).
//
// With a certificate it serves HTTPS and WSS, which phones on the LAN need:
// browsers only allow Wake Lock and similar APIs on https:// pages.
// --public-url is the address phones should open (a tunnel, say); the
// dashboard shows it as a QR code.
//
// With ARKIV_PRIVATE_KEY in swarm/.env, every finished conversation and its
// metrics are saved to Arkiv's Rabdi testnet (src/arkiv.js), and /arkiv shows
// what is there.
//
// PIPER: every phone gets a wallet with no sign-up (a Privy guest wallet,
// with PRIVY_APP_ID; otherwise one kept in the browser), proves it holds it
// by signing a challenge (src/wallet-auth.js), and earns --reward PIPER for
// every --reward-params parameter-ops it computes (src/rewards.js). Once
// chain/deploy.js has deployed everything on Sepolia:
//  - the treasury pays phones every --payout-every ms;
//  - asking costs PIPER: the phone signs the most it will pay, the gas
//    sponsor opens the query on-chain, the answer stops at the stop token or
//    the token limit that pays for, and the sponsor settles it for the
//    tokens run, refunding the rest (src/market.js). --free-asks turns this off;
//    clients (api.js) never pay;
//  - phones swap PIPER and USDC on the Uniswap v4 pool with a signature;
//  - /manage#key=… (printed at start) can send a phone PIPER from the faucet.
// The gas sponsor (SPONSOR_PRIVATE_KEY) pays the gas of everything phones
// only sign; the pool's hook pays it a cut of every swap and deposit.
// An answer token costs --price-margin times what the phones earn for it
// through the whole model, rounded to 0.001 PIPER; the tracker sets that
// price on the market when it starts.
//   [--reward 1] [--reward-params 1e9] [--payout-min 1] [--payout-every 60000] [--free-asks] [--price-margin 1.5]

import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { createReadStream, readdirSync, readFileSync, statSync } from "node:fs";
import { createServer } from "node:http";
import { createServer as createTlsServer } from "node:https";
import { networkInterfaces } from "node:os";
import { basename, dirname, extname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import qrcode from "qrcode-generator";
import { parseUnits } from "viem";
import { WebSocketServer } from "ws";
import { createArkivStore, describeError } from "./src/arkiv.js";
import { costModel, initialCut, paramsModel, placeJoin, repairMove, splitPoint } from "./src/blocks.js";
import { createMarket } from "./src/market.js";
import { KIND, readHeader } from "./src/protocol.js";
import { createRewards } from "./src/rewards.js";
import { newNonce, verifyWallet, walletChallenge } from "./src/wallet-auth.js";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

// swarm/.env holds the saver wallet's key; the environment wins over the file.
try {
  process.loadEnvFile(join(ROOT, "swarm", ".env"));
} catch {}

const { values: opts } = parseArgs({
  options: {
    port: { type: "string", default: "8080" },
    host: { type: "string", default: "0.0.0.0" },
    weights: { type: "string", default: join(ROOT, "weights", "smollm2-135m-instruct") },
    "min-blocks": { type: "string", default: "3" },
    "min-replica": { type: "string", default: "2" },
    "tls-cert": { type: "string" },
    "tls-key": { type: "string" },
    "public-url": { type: "string" },
    "heartbeat-timeout": { type: "string", default: "5000" },
    "busy-timeout": { type: "string", default: "20000" },
    "session-idle": { type: "string", default: "600000" },
    reward: { type: "string", default: "1" },
    "reward-params": { type: "string", default: "1e9" },
    "payout-min": { type: "string", default: "1" },
    "free-asks": { type: "boolean", default: false },
    "price-margin": { type: "string", default: "1.5" },
    "payout-every": { type: "string", default: "60000" },
    ledger: { type: "string", default: join(ROOT, "swarm", "data", "rewards.json") },
  },
});

const HEARTBEAT_TIMEOUT = Number(opts["heartbeat-timeout"]);
const BUSY_TIMEOUT = Number(opts["busy-timeout"]);
const SESSION_IDLE = Number(opts["session-idle"]); // a conversation idle this long frees its KV caches
const MAX_REROUTES = 5;      // per session, for phones leaving; rebalancing doesn't count
const ROUTE_WAIT = 60000;    // how long a session may wait for its blocks' phones to load
const MIN_REPLICA = Number(opts["min-replica"]);
if (!(MIN_REPLICA >= 1)) {
  console.error(`--min-replica must be at least 1, got ${opts["min-replica"]}`);
  process.exit(1);
}

// Phones cache weights under this version, so re-exported weights replace the cache.
function versionOf(dir) {
  const hash = createHash("sha256");
  for (const name of readdirSync(dir, { recursive: true }).sort()) {
    const st = statSync(join(dir, name));
    if (st.isFile()) hash.update(`${name} ${st.size} ${st.mtimeMs}\n`);
  }
  return hash.digest("hex").slice(0, 12);
}
if (!statSync(join(resolve(opts.weights), "manifest.json"), { throwIfNoEntry: false })) {
  console.error(`No weights in ${opts.weights}. Export them first:\n  .venv/bin/python reference/export.py`);
  process.exit(1);
}
const weightsVersion = versionOf(resolve(opts.weights));

// The blocks, in layer order: { id, index, start, end }. They change when a
// block splits; id stays the same for a block's lifetime, index is its place.
const manifest = JSON.parse(readFileSync(join(resolve(opts.weights), "manifest.json"), "utf8"));
const cost = costModel(manifest);
const params = paramsModel(manifest);
let blocks;
try {
  const bounds = initialCut(manifest, Number(opts["min-blocks"]));
  blocks = bounds.slice(0, -1).map((start, index) => ({ id: index + 1, index, start, end: bounds[index + 1] }));
} catch (err) {
  console.error(`--min-blocks: ${err.message}`);
  process.exit(1);
}
let nextBlockId = blocks.length + 1;

let arkiv = null;
try {
  arkiv = createArkivStore({
    privateKey: process.env.ARKIV_PRIVATE_KEY?.trim() || null,
    accessKey: process.env.ARKIV_ACCESS_KEY?.trim() ?? "",
    model: basename(resolve(opts.weights)),
  });
} catch (err) {
  console.error(`Arkiv is off: ${err.message}`);
}
const ARKIV_OFF = "Arkiv is off: set ARKIV_PRIVATE_KEY in swarm/.env and restart the tracker";

// The contracts chain/deploy.js deployed (PIPER_DEPLOYMENT: another file of them).
const PRIVY_APP_ID = process.env.PRIVY_APP_ID?.trim() || null;
let deployment = null;
try {
  deployment = JSON.parse(readFileSync(process.env.PIPER_DEPLOYMENT?.trim() || join(ROOT, "swarm", "chain", "deployment.json"), "utf8"));
  if (!deployment.piper) deployment = null; // the old single-token deployment
} catch {}
const treasuryKey = process.env.TREASURY_PRIVATE_KEY?.trim() || null;
const sponsorKey = process.env.SPONSOR_PRIVATE_KEY?.trim() || null;
const rpcUrl = process.env.CHAIN_RPC_URL?.trim() || undefined;
const rewards = createRewards({
  file: resolve(opts.ledger),
  rewardPerUnit: opts.reward,
  unitParams: Number(opts["reward-params"]),
  payoutMin: opts["payout-min"],
  chain: treasuryKey && deployment ? { privateKey: treasuryKey, relayerKey: sponsorKey, token: deployment.piper, rpcUrl } : null,
  log: (line) => queueMicrotask(() => log(line)), // may log while loading the ledger, before log() can run
});
const REWARD_PER_TOKEN = (Number(opts.reward) * params({ start: 0, end: manifest.config.num_layers })) / Number(opts["reward-params"]);
const PRICE_PER_TOKEN = BigInt(Math.max(1, Math.round(REWARD_PER_TOKEN * Number(opts["price-margin"]) * 1000))) * 10n ** 15n;
const PAYOUTS_OFF = !treasuryKey
  ? "set TREASURY_PRIVATE_KEY in swarm/.env"
  : "deploy first: node swarm/chain/deploy.js";
// Paid questions, swaps and the faucet. null until it has read the chain.
let market = null;
const MARKET_OFF = !deployment ? "deploy first: node swarm/chain/deploy.js" : !sponsorKey ? "set SPONSOR_PRIVATE_KEY in swarm/.env" : null;
const pendingMarket = MARKET_OFF ? null
  : createMarket({ deployment, sponsorKey, treasuryKey, rpcUrl, log: (line) => log(line) });
// /manage's faucet needs this key, since phones load pages from the same server.
const MANAGE_KEY = process.env.MANAGE_KEY?.trim() || randomBytes(12).toString("hex");

// --- HTTP: the page, the code it imports, and the weights ---

// URL prefix -> directory. The browser sees the same layout as the repo, so
// relative imports like ../../engine/src/stage.js work unchanged.
const STATIC = [
  ["/swarm/web/", join(ROOT, "swarm", "web")],
  ["/swarm/src/", join(ROOT, "swarm", "src")],
  ["/engine/src/", join(ROOT, "engine", "src")],
  ["/weights/", resolve(opts.weights)],
];
const TYPES = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".json": "application/json", ".svg": "image/svg+xml" };

function serveStatic(req, res) {
  const url = new URL(req.url, "http://x");
  const path = decodeURIComponent(url.pathname);
  const redirects = {
    "/": "/swarm/web/", "/dashboard": "/swarm/web/dashboard.html", "/manage": "/swarm/web/manage.html", "/arkiv": "/swarm/web/arkiv.html",
    "/pool": "/swarm/web/pool.html",
  };
  if (redirects[path]) {
    res.writeHead(302, { location: redirects[path] });
    return res.end();
  }
  if (path === "/qr.svg") {
    const qr = qrcode(0, "M");
    qr.addData((url.searchParams.get("text") ?? "").slice(0, 500));
    qr.make();
    res.writeHead(200, { "content-type": TYPES[".svg"], "cache-control": "no-cache" });
    return res.end(qr.createSvgTag({ cellSize: 8, margin: 2, scalable: true }));
  }
  if (path === "/wallet/config") {
    const info = rewards.info();
    return sendJson(res, {
      privyAppId: PRIVY_APP_ID,
      payouts: info.payouts,
      payoutsOff: info.payouts ? null : PAYOUTS_OFF,
      token: info.token,
      explorer: info.explorer,
      reward: info.rewardPerUnit,
      rewardParams: info.unitParams,
      paramsPerToken: params({ start: 0, end: manifest.config.num_layers }),
      payoutMin: info.payoutMin,
      payoutEvery: Number(opts["payout-every"]),
      market: market ? market.info() : null,
      marketOff: market ? null : MARKET_OFF ?? "reading the contracts…",
      paidAsks: !!market && !opts["free-asks"],
    });
  }
  if (path === "/market/status") {
    if (!market) return sendJson(res, { error: MARKET_OFF ?? "reading the contracts…" }, 503);
    return Promise.all([market.poolPrice(), market.sponsorStatus(), treasuryKey ? market.balances(rewards.info().treasury) : null]).then(
      ([price, sponsor, treasury]) => sendJson(res, { price, sponsor, treasury, info: market.info() }),
      (err) => sendJson(res, { error: err.shortMessage ?? err.message }, 502),
    );
  }
  if (path === "/market/pool") {
    if (!market) return sendJson(res, { error: MARKET_OFF ?? "reading the contracts…" }, 503);
    return Promise.all([market.poolState(), market.poolHistory(), market.sponsorStatus()]).then(
      ([state, history, sponsor]) => sendJson(res, { state, history, sponsor, info: market.info() }),
      (err) => sendJson(res, { error: err.shortMessage ?? err.message }, 502),
    );
  }
  // ?side=buy|sell&amount=<USDC or PIPER in>, in whole units: what that swap would give.
  if (path === "/market/quote") {
    if (!market) return sendJson(res, { error: MARKET_OFF ?? "reading the contracts…" }, 503);
    const q = new URL(req.url, "http://x").searchParams;
    const side = q.get("side");
    let amountIn;
    try {
      if (side !== "buy" && side !== "sell") throw new Error();
      amountIn = parseUnits(q.get("amount") ?? "", side === "buy" ? 6 : 18);
      if (amountIn <= 0n) throw new Error();
    } catch {
      return sendJson(res, { error: "side must be buy or sell, and amount a positive number" }, 400);
    }
    return market.quoteDetails(side, amountIn).then(
      (quote) => sendJson(res, quote),
      (err) => sendJson(res, { error: err.shortMessage ?? err.message }, 502),
    );
  }
  if (path === "/manage/faucet" && req.method === "POST") return manageFaucet(req, res);
  if (path === "/arkiv/info") return sendJson(res, arkiv ? arkiv.info() : { enabled: false, reason: ARKIV_OFF });
  if (path === "/arkiv/entities") {
    if (!arkiv) return sendJson(res, { error: ARKIV_OFF }, 503);
    return arkiv.list().then(
      (list) => sendJson(res, list),
      (err) => sendJson(res, { error: `reading from Arkiv failed: ${describeError(err)}` }, 502),
    );
  }
  if (path === "/arkiv/lookup") {
    if (!arkiv) return sendJson(res, { error: ARKIV_OFF }, 503);
    return arkiv.lookup(new URL(req.url, "http://x").searchParams.get("q")).then(
      (found) => sendJson(res, found),
      (err) => sendJson(res, { error: `reading from Arkiv failed: ${describeError(err)}` }, 502),
    );
  }
  for (const [prefix, dir] of STATIC) {
    if (!path.startsWith(prefix)) continue;
    let file = resolve(dir, "." + path.slice(prefix.length - 1));
    if (file !== dir && !file.startsWith(dir + sep)) break;
    try {
      if (statSync(file).isDirectory()) file = join(file, "index.html");
      const { size } = statSync(file);
      res.writeHead(200, {
        "content-type": TYPES[extname(file)] ?? "application/octet-stream",
        "content-length": size,
        "cache-control": "no-cache",
      });
      return createReadStream(file).pipe(res);
    } catch {
      break;
    }
  }
  res.writeHead(404, { "content-type": "text/plain" });
  res.end("not found\n");
}

function sendJson(res, body, status = 200) {
  res.writeHead(status, { "content-type": TYPES[".json"], "cache-control": "no-cache" });
  res.end(JSON.stringify(body));
}

// The faucet: the treasury sends a phone PIPER (and test USDC), so it can ask
// before it has earned anything. Body: { peer, piper, usdc }.
async function manageFaucet(req, res) {
  const key = Buffer.from(String(req.headers["x-manage-key"] ?? ""));
  if (key.length !== MANAGE_KEY.length || !timingSafeEqual(key, Buffer.from(MANAGE_KEY))) {
    return sendJson(res, { error: "wrong management key: open the /manage link the tracker printed" }, 403);
  }
  if (!market) return sendJson(res, { error: MARKET_OFF ?? "reading the contracts…" }, 503);
  let body;
  try {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    body = JSON.parse(Buffer.concat(chunks).toString() || "{}");
  } catch {
    return sendJson(res, { error: "bad request" }, 400);
  }
  const peer = peers.get(body.peer);
  if (!peer?.wallet) return sendJson(res, { error: `phone ${body.peer} has no wallet linked` }, 404);
  const amount = (x) => (/^\d+(\.\d+)?$/.test(String(x ?? "0")) ? String(x ?? "0") : "0");
  try {
    const sent = await market.faucet(peer.wallet, { piper: amount(body.piper), usdc: amount(body.usdc) });
    log(`faucet: sent ${[body.piper > 0 && `${body.piper} PIPER`, body.usdc > 0 && `${body.usdc} USDC`].filter(Boolean).join(" and ")} to ${peer.id} (${short(peer.wallet)})`);
    await refreshWallet(peer.wallet);
    sendJson(res, sent);
  } catch (err) {
    sendJson(res, { error: err.shortMessage ?? err.message }, 502);
  }
}

// --- The swarm ---

// id -> { id, ws, block, ready, sessions: Set, served, lastSeen, joinedAt,
//         owed: Map session -> { at, n } frames sent to it and not yet answered,
//         rtt, pingAt, tokenMs, prefillMsPerToken, report, summary }
const peers = new Map();
// session id -> { asker, route: [peer ids], attempt, reroutes, context,
//                 startAt, firstAt, lastAt, tokens, hopMs, hopN, recorded }
const sessions = new Map();
const watchers = new Set(); // dashboard sockets
const chatOwners = new Map(); // Arkiv chat id -> id of the phone whose chat it is
const events = [];          // the last log lines, for the dashboard
let lanUrls = [];
let joined = 0;
let nextSession = 1;

// Throughput. `generated` counts answer tokens delivered to askers, `served`
// counts tokens run by any phone on any block (prompt tokens included).
// Samples are taken every second; rates are over the last minute.
const startedAt = Date.now();
const totals = { generated: 0, served: 0, answeringMs: 0, generatedWhileAnswering: 0 };
const swarmSamples = []; // { t, generated, served }
const finished = [];     // tokens per second of recent finished answers
const WINDOW_MS = 60000;

function rate(samples, key, now) {
  const recent = samples.filter((s) => s.t >= now - WINDOW_MS && s[key] != null);
  if (recent.length < 2) return null;
  const a = recent[0], b = recent.at(-1);
  return b.t > a.t ? (b[key] - a[key]) / ((b.t - a.t) / 1000) : null;
}

function sample(samples, s) {
  samples.push(s);
  while (samples.length && samples[0].t < s.t - WINDOW_MS - 2000) samples.shift();
}

function peerName(k) {
  return String.fromCharCode(65 + (k % 26)) + (k >= 26 ? Math.floor(k / 26) + 1 : "");
}

function send(peer, msg) {
  if (peer?.ws.readyState === 1) peer.ws.send(JSON.stringify(msg));
}

function log(line) {
  const time = new Date().toISOString().slice(11, 19);
  console.log(time, line);
  events.push(`${time} ${line}`);
  if (events.length > 40) events.shift();
  changed();
}

const ewma = (old, x) => (old == null ? x : 0.8 * old + 0.2 * x);
const secs = (ms) => `${(ms / 1000).toFixed(1)} s`;

const holdersOf = (b) => [...peers.values()].filter((p) => p.block === b);
const holderCounts = () => blocks.map((b) => holdersOf(b).length);
const range = (b) => `[${b.start}, ${b.end})`;

// Gives a joining phone its block (src/blocks.js). When it is the phone that
// splits the largest block, the split happens here and it gets a half.
function placeNewPhone(peer) {
  const place = placeJoin(blocks, holderCounts(), { minReplica: MIN_REPLICA, cost });
  if (place.split === undefined) peer.block = blocks[place.block];
  else split(blocks[place.split], peer);
}

// Cuts a block in two at its compute midpoint. Its first minReplica holders,
// earliest joined first, take the first half and the rest the second, with
// the joining phone. They already have the weights of both halves, so only
// the joining phone downloads anything. Every route passes through the old
// block, so every session gets a new route once the halves have ready
// holders.
function split(b, joining) {
  const m = splitPoint(b, cost);
  const halves = [{ id: nextBlockId++, start: b.start, end: m }, { id: nextBlockId++, start: m, end: b.end }];
  const holders = holdersOf(b).sort((x, y) => x.joinedAt - y.joinedAt);
  blocks.splice(b.index, 1, ...halves);
  blocks.forEach((x, i) => (x.index = i));
  holders.forEach((p, i) => setBlock(p, halves[i < MIN_REPLICA ? 0 : 1]));
  joining.block = halves[1];
  log(`block ${b.index + 1} ${range(b)} splits into ${range(halves[0])} and ${range(halves[1])}: ` +
    halves.map((h) => `${[...holdersOf(h), ...(h === joining.block ? [joining] : [])].map((p) => p.id).join(",")} on ${range(h)}`).join(", "));
  for (const id of [...sessions.keys()]) reroute(id, `block ${b.index + 1} split`);
  for (const p of holders) send(p, { type: "assign", block: p.block, blocks });
}

function setBlock(p, block) {
  p.block = block;
  p.ready = false;
}

// Moves a phone to another block. It drops its old block and loads the new
// one; answers it was serving get new routes.
function movePeer(p, block, why) {
  setBlock(p, block);
  log(`${p.id} moves to block ${block.index + 1} (layers ${block.start}–${block.end - 1}): ${why}`);
  for (const id of [...p.sessions]) if (sessions.has(id)) reroute(id, `${p.id} moved`);
  send(p, { type: "assign", block, blocks });
}

// After a phone leaves: refill a block nobody holds, then blocks below
// --min-replica, with phones from blocks that can spare one (src/blocks.js).
// Each move takes the donor block's phone with the fewest answers in
// progress, the newest on a tie.
function repair() {
  for (let move; (move = repairMove(holderCounts(), MIN_REPLICA)); ) {
    const donor = holdersOf(blocks[move.from]).sort((x, y) => activeSessions(x) - activeSessions(y) || y.joinedAt - x.joinedAt)[0];
    const to = blocks[move.to];
    const had = holdersOf(to).length;
    movePeer(donor, to, had ? `it had ${had} of ${MIN_REPLICA} phones` : "nobody held it");
  }
}

// Answers this phone is generating right now; idle conversations don't count.
function activeSessions(p) {
  let n = 0;
  for (const id of p.sessions) if (sessions.get(id)?.active) n++;
  return n;
}

// The ready holder of a block that should give a new answer its tokens
// soonest: its measured time per token (compute plus network), shared with
// the answers it is already generating. A phone not measured yet counts as
// the median of its block's measured holders. Earliest joined wins a tie.
function pickHolder(block) {
  const holders = holdersOf(block).filter((p) => p.ready);
  const measured = holders.map((p) => p.tokenMs).filter((ms) => ms != null).sort((a, b) => a - b);
  const typical = measured.length ? measured[Math.floor(measured.length / 2)] : 1;
  let best = null, bestCost = Infinity;
  for (const p of holders) {
    const cost = (p.tokenMs ?? typical) * (1 + activeSessions(p));
    if (cost < bestCost) {
      best = p;
      bestCost = cost;
    }
  }
  return best;
}

// A session is one conversation. Each answer is a turn; between turns the
// session stays open, idle, so every phone on the route keeps its KV cache
// and the next question only sends its new tokens.
function newTurn(s, now) {
  Object.assign(s, { active: true, startAt: now, firstAt: 0, lastAt: 0, tokens: 0, recorded: false,
    cached: s.context ?? 0, hopMs: s.route.map(() => 0), hopN: s.route.map(() => 0) });
}

// Logs the answer just finished and counts its speed.
function logAnswer(id, s, why) {
  if (s.tokens > 1) {
    finished.push((1000 * (s.tokens - 1)) / (s.lastAt - s.firstAt));
    if (finished.length > 50) finished.shift();
  }
  const name = s.turn > 1 ? `session ${id} turn ${s.turn}` : `session ${id}`;
  if (s.tokens) {
    const perToken = s.tokens > 1 ? `, then ${((s.lastAt - s.firstAt) / (s.tokens - 1)).toFixed(0)} ms per token` : "";
    const hops = s.route.map((pid, i) => `${pid} ${s.hopN[i] ? (s.hopMs[i] / s.hopN[i]).toFixed(0) : "?"} ms`).join(", ");
    const rerouted = s.reroutes ? ` · rerouted ${s.reroutes}×` : "";
    log(`${name} ${why ?? "done"}: ${s.tokens} tokens, first token ${secs(s.firstAt - s.startAt)}${perToken} · per hop ${hops}${rerouted}`);
  } else if (why) {
    log(`${name} ${why}`);
  }
}

function endSession(id, why = null) {
  const s = sessions.get(id);
  if (!s) return;
  sessions.delete(id);
  for (const pid of new Set(s.route)) {
    const p = peers.get(pid);
    if (!p) continue;
    p.sessions.delete(id);
    p.owed.delete(id);
    send(p, { type: "drop", session: id });
  }
  if (s.active) logAnswer(id, s, why);
  else if (why) log(`session ${id} ${why}`);
  settleQuery(id, s);
  changed();
}

// The session's route no longer works: a phone on it left or moved, or its
// blocks changed. Every phone on it drops the old attempt, and the session
// waits for a new route; the asker then replays the conversation under the
// new attempt, so the answer continues instead of failing. It fails only if
// some block has no phone at all, not even one loading. `left` counts
// towards MAX_REROUTES.
function reroute(id, why, { left = false } = {}) {
  const s = sessions.get(id);
  const fail = (reason) => {
    if (s.active || s.request != null) {
      send(peers.get(s.asker), { type: "error", session: id, requestId: s.request ?? undefined, message: `${why} in the middle of the answer, and ${reason}` });
    }
    endSession(id, `cut: ${why}, ${reason}`);
  };
  if (left && s.reroutes >= MAX_REROUTES) return fail(`it was already rerouted ${s.reroutes} times`);
  for (const pid of new Set(s.route)) {
    const p = peers.get(pid);
    if (!p) continue;
    p.sessions.delete(id);
    p.owed.delete(id);
    send(p, { type: "drop", session: id, attempt: s.attempt });
  }
  s.attempt++;
  if (left) s.reroutes++;
  s.route = [];
  s.waitingSince = Date.now();
  const empty = blocks.find((b) => !holdersOf(b).length);
  if (empty) return fail(`no phone holds block ${empty.index + 1}`);
  if (!connect(id)) log(`session ${id}: ${why}, waiting for phones to load`);
}

// Gives a waiting session its route, once every block has a ready holder.
// A new question gets its session now; an answer in progress or a kept
// conversation is told to replay under the new attempt.
function connect(id) {
  const s = sessions.get(id);
  const route = blocks.map(pickHolder);
  if (route.includes(null)) return false;
  s.route = route.map((p) => p.id);
  s.waitingSince = 0;
  s.hopMs = s.route.map(() => 0);
  s.hopN = s.route.map(() => 0);
  for (const p of route) p.sessions.add(id);
  const name = s.turn > 1 ? `session ${id} turn ${s.turn}` : `session ${id}`;
  if (s.request != null) {
    send(peers.get(s.asker), { type: "session", requestId: s.request, session: id, route: s.route, attempt: s.attempt, maxTokens: s.query?.maxTokens });
    s.request = null;
    log(`${name}: ${s.asker} asks via ${s.route.join(" → ")}${s.context ? `, replaying ${s.context} tokens` : ""}`);
  } else {
    send(peers.get(s.asker), { type: "reroute", session: id, attempt: s.attempt, route: s.route, reroutes: s.reroutes });
    log(`${name}: continuing via ${s.route.join(" → ")} (replaying ${s.context} tokens)`);
  }
  return true;
}

function connectWaiting() {
  for (const [id, s] of sessions) if (s.waitingSince) connect(id);
}

// Phones get a small summary, only when it changes; the dashboard gets
// everything. Sending every phone the full swarm on every token grows with
// the square of the number of phones.
function summary() {
  // silent: ready phones quiet for longer than the heartbeat timeout. They
  // are only still here because they owe a reply (the busy timeout); a
  // frozen tab mid-answer looks like this until it is dropped.
  const holders = blocks.map(() => ({ ready: 0, loading: 0, silent: 0 }));
  const now = Date.now();
  let phones = 0;
  for (const p of peers.values()) {
    if (!p.block) continue; // a client
    holders[p.block.index][p.ready ? "ready" : "loading"]++;
    if (p.ready && now - p.lastSeen > HEARTBEAT_TIMEOUT) holders[p.block.index].silent++;
    phones++;
  }
  const answering = [...sessions.values()].filter((s) => s.active).length;
  return JSON.stringify({ type: "swarm", blocks, holders, phones, sessions: answering, busyTimeout: BUSY_TIMEOUT });
}

function fullState() {
  const now = Date.now();
  return JSON.stringify({
    type: "state",
    now,
    publicUrl: opts["public-url"] ?? null,
    lanUrls,
    blocks,
    heartbeatTimeout: HEARTBEAT_TIMEOUT,
    busyTimeout: BUSY_TIMEOUT,
    throughput: {
      uptimeMs: now - startedAt,
      generated: totals.generated,
      served: totals.served,
      generatedPerSec: rate(swarmSamples, "generated", now),
      servedPerSec: rate(swarmSamples, "served", now),
      // Averaged only over seconds when at least one question was being answered.
      generatedPerSecWhileAnswering: totals.answeringMs ? totals.generatedWhileAnswering / (totals.answeringMs / 1000) : null,
      answeringMs: totals.answeringMs,
      perAnswer: finished.length ? finished.reduce((a, b) => a + b, 0) / finished.length : null,
      answers: finished.length,
    },
    clients: [...peers.values()].filter((p) => !p.block).map((p) => p.id),
    peers: [...peers.values()].filter((p) => p.block).map((p) => ({
      id: p.id, block: p.block.index, ready: p.ready, sessions: activeSessions(p), idleSessions: p.sessions.size - activeSessions(p),
      served: p.served, wallet: p.wallet, earned: p.wallet ? rewards.status(p.wallet) : null,
      busy: p.owed.size > 0, silentMs: now - p.lastSeen, joinedAt: p.joinedAt,
      rtt: p.rtt, tokenMs: p.tokenMs, prefillMsPerToken: p.prefillMsPerToken, report: p.report,
      servedPerSec: rate(p.samples, "served", now),
      // Share of wall time spent computing, from the compute time the phone reports.
      utilization: rate(p.samples, "computeMs", now) == null ? null : rate(p.samples, "computeMs", now) / 1000,
    })),
    sessionIdle: SESSION_IDLE,
    sessions: [...sessions.entries()].map(([id, s]) => ({
      id, asker: s.asker, route: s.route, attempt: s.attempt, reroutes: s.reroutes, context: s.context, tokens: s.tokens,
      active: s.active, turn: s.turn, waiting: !!s.waitingSince,
    })),
    minReplica: MIN_REPLICA,
    events,
    arkiv: arkiv ? arkiv.info() : { enabled: false, reason: ARKIV_OFF },
  });
}

let pending = null;
function changed() {
  pending ??= setTimeout(() => {
    pending = null;
    const msg = summary();
    for (const p of peers.values()) {
      if (p.summary === msg) continue;
      p.summary = msg;
      send(p, JSON.parse(msg));
    }
    if (watchers.size) {
      const state = fullState();
      for (const ws of watchers) if (ws.readyState === 1) ws.send(state);
    }
  }, 500);
}

function onControl(peer, msg) {
  if (msg.type === "ready") {
    if (!peer.block) return; // a client serves nothing
    if (msg.block !== undefined && msg.block !== peer.block.id) return; // loaded a block it has since been moved off
    peer.ready = true;
    log(`${peer.id} ready with block ${peer.block.index + 1}`);
    connectWaiting();
  } else if (msg.type === "ask") {
    return ask(peer, msg);
  } else if (msg.type === "turn") {
    // The asker has its answer and keeps the conversation for its next question.
    const s = sessions.get(msg.session);
    if (s?.asker !== peer.id || !s.active) return;
    logAnswer(msg.session, s);
    s.active = false;
    s.idleSince = Date.now();
    settleQuery(msg.session, s);
  } else if (msg.type === "end") {
    if (sessions.get(msg.session)?.asker === peer.id) endSession(msg.session);
  } else if (msg.type === "fail") {
    const s = sessions.get(msg.session);
    if (!s || (msg.attempt !== undefined && msg.attempt !== s.attempt)) return;
    peer.owed.delete(msg.session);
    send(peers.get(s.asker), { type: "error", session: msg.session, message: msg.message });
    endSession(msg.session, `failed: ${msg.message}`);
  } else if (msg.type === "stats") {
    peer.report = { ...msg.stats, at: Date.now() };
  } else if (msg.type === "record") {
    return record(peer, msg);
  } else if (msg.type === "wallet") {
    return bindWallet(peer, msg);
  } else if (msg.type === "withdraw") {
    return withdraw(peer, msg);
  } else if (msg.type === "quote" || msg.type === "swap" || msg.type === "topup") {
    return trade(peer, msg);
  }
  changed();
}

// A question: the next turn of a kept conversation, or a new session. When
// asking is paid, its payment is opened on-chain first, and the session
// reply carries the query: the answer may run maxTokens tokens.
async function ask(peer, msg) {
  let query = null;
  if (paidAsks() && peer.block) {
    if (!peer.wallet) return send(peer, { type: "error", requestId: msg.requestId, message: "asking costs PIPER: this phone's wallet isn't linked yet" });
    if (!msg.payment) return send(peer, { type: "error", requestId: msg.requestId, message: "asking costs PIPER: this question carries no payment" });
    const empty = blocks.find((b) => !holdersOf(b).length);
    if (empty) return send(peer, { type: "error", requestId: msg.requestId, message: `waiting for block ${empty.index + 1}: no phone holds it yet` });
    try {
      query = await market.openQuery(peer.wallet, msg.payment);
    } catch (err) {
      return send(peer, { type: "error", requestId: msg.requestId, message: `payment refused: ${err.shortMessage ?? err.message}` });
    }
    log(`${peer.id} pays up to ${fmtPiper(query.maxPayment)} PIPER for ${query.maxTokens} tokens: query ${short(query.id)}, tx ${short(query.hash)}`);
    send(peer, { type: "query", state: "opened", requestId: msg.requestId, id: query.id, maxTokens: query.maxTokens, maxPayment: query.maxPayment, hash: query.hash });
    refreshWallet(peer.wallet);
    if (!peers.has(peer.id)) return settleOpen(query, 0, `${peer.id} left`);
  }

  const now = Date.now();
  const old = sessions.get(msg.session);
  if (old?.asker === peer.id && !old.active) {
    // The next question of a conversation: same route, its KV caches still there.
    old.turn++;
    newTurn(old, now);
    old.query = query && { ...query, start: old.context, used: 0 };
    if (old.waitingSince) {
      old.request = msg.requestId; // its route is still being rebuilt; answered by connect()
      return changed();
    }
    send(peer, { type: "session", requestId: msg.requestId, session: msg.session, route: old.route, attempt: old.attempt, maxTokens: query?.maxTokens });
    log(`session ${msg.session} turn ${old.turn}: ${peer.id} asks again via ${old.route.join(" → ")}, ${old.context} tokens cached`);
    return changed();
  }
  const empty = blocks.find((b) => !holdersOf(b).length);
  if (empty) {
    if (query) settleOpen(query, 0, `no phone holds block ${empty.index + 1}`);
    return send(peer, { type: "error", requestId: msg.requestId, message: `waiting for block ${empty.index + 1}: no phone holds it yet` });
  }
  // Every block has a phone; if some are still loading, the question waits for them.
  const id = nextSession++;
  const s = { asker: peer.id, route: [], attempt: 0, reroutes: 0, context: 0, turn: 1, idleSince: 0, request: msg.requestId, waitingSince: now };
  newTurn(s, now);
  s.query = query && { ...query, start: 0, used: 0 };
  sessions.set(id, s);
  if (!connect(id)) log(`session ${id}: ${peer.id} asks, waiting for phones to load`);
  changed();
}

const paidAsks = () => !!market && !opts["free-asks"];
const fmtPiper = (units) => (Number(units) / 1e18).toFixed(4).replace(/\.?0+$/, "");

// The turn's answer is over (finished, cut, or the session ended): charge the
// asker for the tokens the swarm ran and refund the rest, once.
function settleQuery(id, s) {
  const q = s.query;
  if (!q) return;
  s.query = null;
  settleOpen(q, q.used, `session ${id}`, peers.get(s.asker), id);
}

function settleOpen(q, used, what, asker = null, session = undefined) {
  market.settleQuery(q.id, used).then(
    (r) => {
      log(`${what}: query ${short(q.id)} settled, ${used} tokens for ${fmtPiper(r.cost)} PIPER, ${fmtPiper(r.refund)} refunded, tx ${short(r.hash)}`);
      if (asker && peers.has(asker.id)) send(asker, { type: "query", state: "settled", session, id: q.id, tokens: used, cost: r.cost, refund: r.refund, hash: r.hash });
      if (asker?.wallet) refreshWallet(asker.wallet);
    },
    (err) => log(`${what}: settling query ${short(q.id)} failed: ${err.shortMessage ?? err.message}`),
  );
}

// The asker's answer finished: save the conversation and this answer's
// metrics to Arkiv. The metrics are the tracker's own measurements; only a
// session this phone asked, whose answer produced tokens, is saved, once per
// answer.
function record(peer, msg) {
  const s = sessions.get(msg.session);
  const reply = (body) => send(peer, { type: "recorded", session: msg.session, chatId: msg.chatId, ...body });
  if (!s || s.asker !== peer.id || s.recorded || !s.tokens) return;
  s.recorded = true;
  if (!arkiv) return reply({ skipped: ARKIV_OFF });
  const messages = cleanMessages(msg.messages);
  const chatId = typeof msg.chatId === "string" && /^[A-Za-z0-9-]{8,64}$/.test(msg.chatId) ? msg.chatId : null;
  if (!chatId || !messages) return reply({ error: "bad record message" });
  if ((chatOwners.get(chatId) ?? peer.id) !== peer.id) return reply({ error: "that chat belongs to another phone" });
  chatOwners.set(chatId, peer.id);

  const now = Date.now();
  const num = (x) => (typeof x === "number" && Number.isFinite(x) ? Math.round(x) : null);
  const metrics = {
    turn: messages.filter((m) => m.role === "assistant").length,
    session: msg.session,
    at: new Date(now).toISOString(),
    asker: peer.id,
    route: [...s.route],
    reroutes: s.reroutes,
    finish: msg.finish === "length" ? "length" : "stop",
    promptTokens: Math.max(0, s.context - s.tokens + 1),
    cachedTokens: s.cached ?? 0,
    tokens: s.tokens,
    firstTokenMs: s.firstAt - s.startAt,
    msPerToken: s.tokens > 1 ? num((s.lastAt - s.firstAt) / (s.tokens - 1)) : null,
    tokensPerSec: s.tokens > 1 ? Number(((1000 * (s.tokens - 1)) / (s.lastAt - s.firstAt)).toFixed(2)) : null,
    hopMs: s.route.map((_, i) => (s.hopN[i] ? num(s.hopMs[i] / s.hopN[i]) : null)),
    askerFirstTokenMs: num(msg.asker?.firstTokenMs),
    askerMsPerToken: num(msg.asker?.msPerToken),
    phones: peers.size,
  };
  arkiv.save({ chatId, messages, metrics }).then(
    (result) => {
      log(`session ${msg.session} ${result.op === "create" ? "saved to" : "updated on"} Arkiv: entity ${short(result.entityKey)}, turn ${result.turns}, tx ${short(result.txHash)}`);
      reply({ ...result });
    },
    (err) => {
      const message = describeError(err);
      log(`session ${msg.session}: saving to Arkiv failed: ${message}`);
      reply({ error: message });
    },
  );
}

const short = (hex) => `${hex.slice(0, 8)}…${hex.slice(-4)}`;

// --- Rewards ---

// A phone earns from its first token served; until its wallet is known the
// parameter-ops wait on the connection, then go to the wallet.
function earn(peer, ops) {
  if (peer.wallet) rewards.credit(peer.wallet, ops);
  else peer.unearned += ops;
}

// Trading on the pool, for a phone's wallet: "quote" prices a swap, "swap"
// submits one the phone signed, "topup" mints it test USDC. The sponsor pays the gas.
async function trade(peer, msg) {
  const reply = (body) => send(peer, { type: "walletReply", requestId: msg.requestId, ...body });
  if (!market) return reply({ error: MARKET_OFF ?? "reading the contracts…" });
  if (!peer.wallet) return reply({ error: "this phone has no wallet yet" });
  try {
    if (msg.type === "quote") return reply(await market.quoteDetails(msg.side, BigInt(msg.amountIn)));
    if (msg.type === "topup") {
      const hash = await market.usdcFaucet(peer.wallet);
      log(`${peer.id} topped up 100 test USDC: tx ${short(hash)}`);
      reply({ hash });
    } else {
      const r = await market.swap(peer.wallet, msg);
      const [inSym, outSym] = msg.side === "buy" ? ["USDC", "PIPER"] : ["PIPER", "USDC"];
      log(`${peer.id} swapped ${inSym} for ${outSym} on the pool: tx ${short(r.hash)}`);
      reply(r);
    }
  } catch (err) {
    return reply({ error: err.shortMessage ?? err.message });
  }
  await refreshWallet(peer.wallet);
}

// Rereads a wallet's PIPER and USDC, and tells its phones.
const usdcBalances = new Map(); // address -> USDC base units, as last read
async function refreshWallet(address) {
  await rewards.refresh(address);
  if (market) {
    try {
      usdcBalances.set(address, (await market.balances(address)).usdc);
    } catch {}
  }
  for (const p of peers.values()) if (p.wallet === address) pushWallet(p);
}

// The phone proves which wallet it holds (src/wallet-auth.js); from then on
// it earns into that wallet.
async function bindWallet(peer, msg) {
  let address;
  try {
    address = await verifyWallet(msg, { peerId: peer.id, nonce: peer.walletNonce });
  } catch (err) {
    return send(peer, { type: "wallet", error: `wallet not linked: ${err.message}` });
  }
  if (!peers.has(peer.id)) return;
  const changedWallet = peer.wallet !== address;
  peer.wallet = address;
  if (peer.unearned) rewards.credit(peer.wallet, peer.unearned);
  peer.unearned = 0;
  if (changedWallet) log(`${peer.id} earns into ${msg.kind === "privy" ? "Privy wallet" : "browser wallet"} ${short(peer.wallet)}`);
  peer.walletSent = null;
  await refreshWallet(peer.wallet);
  changed();
}

async function withdraw(peer, msg) {
  const reply = (body) => send(peer, { type: "withdrawn", requestId: msg.requestId, ...body });
  if (!peer.wallet) return reply({ error: "this phone has no wallet yet" });
  try {
    reply({ hash: await rewards.withdraw(peer.wallet, msg) });
  } catch (err) {
    reply({ error: err.shortMessage ?? err.message });
  }
  for (const p of peers.values()) if (p.wallet === peer.wallet) pushWallet(p);
}

// Sends a phone its wallet's numbers when they change.
function pushWallet(peer) {
  if (!peer.wallet) return;
  const msg = JSON.stringify({ type: "wallet", ...rewards.status(peer.wallet), usdc: usdcBalances.get(peer.wallet) ?? null });
  if (msg === peer.walletSent) return;
  peer.walletSent = msg;
  if (peer.ws.readyState === 1) peer.ws.send(msg);
}

async function payoutRound() {
  const paid = new Set(await rewards.payout());
  for (const p of peers.values()) if (paid.has(p.wallet)) pushWallet(p);
}

// [{ role, content }] with known roles and string contents, or null.
function cleanMessages(messages) {
  if (!Array.isArray(messages) || !messages.length || messages.length > 500) return null;
  const roles = new Set(["system", "user", "assistant"]);
  if (!messages.every((m) => roles.has(m?.role) && typeof m.content === "string")) return null;
  return messages.map(({ role, content }) => ({ role, content }));
}

// Forward a frame to route[hop], or back to the asker after the last block.
// Only the phone that should be sending this hop may send it. On the way,
// time how long each phone took to answer the frame it was sent.
function onFrame(peer, data) {
  const h = readHeader(data);
  const s = sessions.get(h.session);
  if (!s || h.attempt !== s.attempt || !s.route.length) return; // session ended or rerouted; a late frame
  const expectedFrom = h.hop === 0 ? s.asker : s.route[h.hop - 1];
  const expectedKind = h.hop === 0 ? KIND.TOKENS : h.hop === s.route.length ? KIND.NEXT : KIND.HIDDEN;
  if (peer.id !== expectedFrom || h.kind !== expectedKind || h.hop > s.route.length) {
    log(`dropped a bad frame from ${peer.id} for session ${h.session} hop ${h.hop}`);
    return;
  }
  const now = Date.now();
  if (h.hop === 0) {
    // A paid turn pays for every position past where it started; a replay
    // after a reroute runs positions already paid for.
    const q = s.query;
    if (q) {
      const used = Math.max(q.used, h.pos + h.n - q.start);
      if (used > q.maxTokens) {
        send(peer, { type: "error", session: h.session, message: `the token limit this question paid for (${q.maxTokens}) is used up` });
        s.active = false;
        s.idleSince = now;
        logAnswer(h.session, s, "stopped at its token limit");
        settleQuery(h.session, s);
        return changed();
      }
      q.used = used;
    }
    s.context = h.pos + h.n;
  } else {
    const owed = peer.owed.get(h.session);
    peer.owed.delete(h.session);
    if (owed) {
      const ms = now - owed.at;
      if (owed.n === 1) {
        peer.tokenMs = ewma(peer.tokenMs, ms);
        s.hopMs[h.hop - 1] += ms;
        s.hopN[h.hop - 1]++;
      } else {
        peer.prefillMsPerToken = ewma(peer.prefillMsPerToken, ms / owed.n);
      }
      earn(peer, owed.n * params(peer.block));
    }
  }
  const to = peers.get(h.hop < s.route.length ? s.route[h.hop] : s.asker);
  if (!to) return;
  to.ws.send(data, { binary: true });
  if (h.hop < s.route.length) {
    to.owed.set(h.session, { at: now, n: h.n });
    to.served += h.n;
    totals.served += h.n;
  } else {
    s.tokens++;
    totals.generated++;
    s.firstAt ||= now;
    s.lastAt = now;
  }
  changed();
}

function onLeave(peer, why = "left") {
  if (!peers.has(peer.id)) return;
  peers.delete(peer.id);
  log(`${peer.id} ${why} (${peer.block ? `block ${peer.block.index + 1}` : "client"})`);
  for (const [id, s] of [...sessions]) if (s.asker === peer.id) endSession(id, `ended: asker ${peer.id} ${why}`);
  // Refill its block first, so the answers it was serving can wait for the
  // phone moving in instead of failing.
  repair();
  for (const [id, s] of [...sessions]) if (s.route.includes(peer.id)) reroute(id, `phone ${peer.id} ${why}`, { left: true });
  changed();
}

// Heartbeat: a ping every second. A phone that sends nothing, not even a
// pong, for the timeout is treated as gone. A locked phone or a frozen tab
// keeps its connection open, so a close event alone would never come. A
// phone that owes a reply gets the longer busy timeout: a long prefill can
// keep it quiet without it being gone.
let lastTick = { t: Date.now(), generated: 0 };
setInterval(() => {
  const now = Date.now();
  if ([...sessions.values()].some((s) => s.active)) {
    totals.answeringMs += now - lastTick.t;
    totals.generatedWhileAnswering += totals.generated - lastTick.generated;
  }
  lastTick = { t: now, generated: totals.generated };
  sample(swarmSamples, { t: now, generated: totals.generated, served: totals.served });
  for (const peer of peers.values()) sample(peer.samples, { t: now, served: peer.served, computeMs: peer.report?.computeMs ?? null });
  for (const [id, s] of [...sessions]) {
    if (!s.active && now - s.idleSince > SESSION_IDLE) endSession(id, `expired after ${secs(now - s.idleSince)} idle`);
    else if (s.waitingSince && now - s.waitingSince > ROUTE_WAIT) {
      if (s.active || s.request != null) {
        send(peers.get(s.asker), { type: "error", session: id, requestId: s.request ?? undefined, message: `no route: the swarm's phones took more than ${secs(ROUTE_WAIT)} to load` });
      }
      endSession(id, `no route after ${secs(ROUTE_WAIT)}`);
    }
  }
  for (const peer of [...peers.values()]) {
    const limit = peer.owed.size ? BUSY_TIMEOUT : HEARTBEAT_TIMEOUT;
    if (now - peer.lastSeen > limit) {
      onLeave(peer, "stopped responding");
      peer.ws.terminate();
    } else if (peer.ws.readyState === 1) {
      peer.pingAt = now;
      peer.ws.ping();
    }
  }
  for (const peer of peers.values()) pushWallet(peer);
  // Pings and silences move even when nothing else does. Phones only hear
  // it when their summary changes (a holder going quiet, say).
  changed();
}, 1000).unref();

rewards.init().then(
  () => setInterval(payoutRound, Number(opts["payout-every"])).unref(),
  (err) => log(`payouts are off: reading the token failed: ${err.shortMessage ?? err.message}`),
);
pendingMarket?.init().then(
  async () => {
    await pendingMarket.setPrice(PRICE_PER_TOKEN).then(
      (hash) => hash && log(`market: set the price to ${opts["price-margin"]}× the phones' reward: tx ${hash}`),
      (err) => log(`setting the market's price failed: ${err.shortMessage ?? err.message}`),
    );
    market = pendingMarket;
    const i = market.info();
    log(`market: answers cost ${i.tokenPrice} PIPER a token${opts["free-asks"] ? " (asking is free: --free-asks)" : ""}; gas sponsor ${short(i.sponsor)}`);
    for (const p of peers.values()) if (p.wallet) refreshWallet(p.wallet);
    // Deposits' cuts wait in the hook until collected.
    setInterval(() => market.collectFees().catch((err) => log(`collecting the hook's fees failed: ${err.shortMessage ?? err.message}`)),
      Number(opts["payout-every"])).unref();
  },
  (err) => log(`the market is off: reading the contracts failed: ${err.shortMessage ?? err.message}`),
);
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    rewards.flush();
    process.exit(0);
  });
}

const tls = opts["tls-cert"] ? { cert: readFileSync(opts["tls-cert"]), key: readFileSync(opts["tls-key"]) } : null;
const server = tls ? createTlsServer(tls, serveStatic) : createServer(serveStatic);
const wss = new WebSocketServer({ server, path: "/ws" });

wss.on("connection", (ws) => {
  let peer = null;
  ws.on("pong", () => {
    if (!peer) return;
    peer.lastSeen = Date.now();
    if (peer.pingAt) peer.rtt = ewma(peer.rtt, peer.lastSeen - peer.pingAt);
    peer.pingAt = null;
  });
  ws.on("message", (data, isBinary) => {
    if (peer) peer.lastSeen = Date.now();
    if (isBinary) return peer && onFrame(peer, data);
    const msg = JSON.parse(data.toString());
    if (msg.type === "hello" && !peer) {
      peer = {
        id: peerName(joined++), ws, block: null, ready: false, sessions: new Set(), served: 0, lastSeen: Date.now(), joinedAt: Date.now(),
        owed: new Map(), rtt: null, pingAt: null, tokenMs: null, prefillMsPerToken: null, report: null, summary: null, samples: [],
        wallet: null, walletNonce: newNonce(), walletSent: null, unearned: 0,
      };
      // A client (swarm/api.js) asks like a phone but holds no block, so it
      // is never placed, routed to, split or moved: holdersOf() skips it.
      if (msg.role !== "client") placeNewPhone(peer);
      peers.set(peer.id, peer);
      const { block } = peer;
      send(peer, { type: "welcome", id: peer.id, block, blocks, weightsVersion, walletChallenge: walletChallenge(peer.id, peer.walletNonce) });
      log(block ? `${peer.id} joined, holds block ${block.index + 1} (layers ${block.start}–${block.end - 1})` : `${peer.id} joined as a client`);
    } else if (msg.type === "watch" && !peer) {
      watchers.add(ws);
      ws.send(fullState());
    } else if (peer) {
      onControl(peer, msg);
    }
  });
  ws.on("close", () => {
    watchers.delete(ws);
    if (peer) onLeave(peer);
  });
});

server.listen(Number(opts.port), opts.host, () => {
  const { port } = server.address();
  const scheme = tls ? "https" : "http";
  console.log(`Tracker listening on ${scheme}://localhost:${port}`);
  for (const addrs of Object.values(networkInterfaces())) {
    for (const a of addrs ?? []) {
      if (a.family === "IPv4" && !a.internal) lanUrls.push(`${scheme}://${a.address}:${port}`);
    }
  }
  for (const url of lanUrls) console.log(`  on the LAN: ${url}`);
  if (opts["public-url"]) console.log(`  for phones: ${opts["public-url"]}`);
  console.log(`  dashboard: ${scheme}://localhost:${port}/dashboard`);
  console.log(`  management: ${scheme}://localhost:${port}/manage#key=${MANAGE_KEY}`);
  console.log(`  blocks: ${blocks.map(range).join(" ")}, at least ${MIN_REPLICA} phone${MIN_REPLICA > 1 ? "s" : ""} each before splitting`);
  console.log(arkiv ? `  arkiv: saving conversations as ${arkiv.address} on Rabdi, see ${scheme}://localhost:${port}/arkiv` : `  ${ARKIV_OFF}`);
  console.log(`  wallets: ${PRIVY_APP_ID ? `Privy app ${PRIVY_APP_ID}` : "kept in each browser (set PRIVY_APP_ID for Privy guest wallets)"}`);
  const terms = `${opts.reward} PIPER per ${Number(opts["reward-params"]).toExponential()} parameter-ops (${REWARD_PER_TOKEN.toFixed(3)} PIPER per token through the whole model)`;
  console.log(treasuryKey && deployment
    ? `  rewards: ${terms}, paid from the treasury every ${secs(Number(opts["payout-every"]))}, PIPER ${deployment.piper}`
    : `  rewards: ${terms}, counted in ${opts.ledger}; payouts off: ${PAYOUTS_OFF}`);
  if (MARKET_OFF) console.log(`  market: off (${MARKET_OFF}); asking is free`);
});
