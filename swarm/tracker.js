// The laptop's tracker. Serves the phone page, the dashboard and the weights
// over HTTP and runs the swarm over a WebSocket at /ws: assigns blocks, picks
// routes, reroutes answers when a phone leaves, and in v1 relays every frame
// between phones.
//
//   node swarm/tracker.js [--port 8080] [--host 0.0.0.0] [--weights DIR] [--blocks 0,8,22,30]
//                         [--tls-cert FILE --tls-key FILE] [--public-url URL]
//                         [--heartbeat-timeout 5000] [--busy-timeout 20000]
//
// With a certificate it serves HTTPS and WSS, which phones on the LAN need:
// browsers only allow Wake Lock and similar APIs on https:// pages.
// --public-url is the address phones should open (a tunnel, say); the
// dashboard shows it as a QR code.
//
// With ARKIV_PRIVATE_KEY in swarm/.env, every finished conversation and its
// metrics are saved to Arkiv's Rabdi testnet (src/arkiv.js), and /arkiv shows
// what is there.

import { createHash } from "node:crypto";
import { createReadStream, readdirSync, readFileSync, statSync } from "node:fs";
import { createServer } from "node:http";
import { createServer as createTlsServer } from "node:https";
import { networkInterfaces } from "node:os";
import { basename, dirname, extname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import qrcode from "qrcode-generator";
import { WebSocketServer } from "ws";
import { createArkivStore, describeError } from "./src/arkiv.js";
import { KIND, readHeader } from "./src/protocol.js";

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
    blocks: { type: "string", default: "0,8,22,30" },
    "tls-cert": { type: "string" },
    "tls-key": { type: "string" },
    "public-url": { type: "string" },
    "heartbeat-timeout": { type: "string", default: "5000" },
    "busy-timeout": { type: "string", default: "20000" },
  },
});

const boundaries = opts.blocks.split(",").map(Number);
const blocks = boundaries.slice(0, -1).map((start, index) => ({ index, start, end: boundaries[index + 1] }));
const HEARTBEAT_TIMEOUT = Number(opts["heartbeat-timeout"]);
const BUSY_TIMEOUT = Number(opts["busy-timeout"]);
const MAX_REROUTES = 5; // per session

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
  if (path === "/arkiv/info") return sendJson(res, arkiv ? arkiv.info() : { enabled: false, reason: ARKIV_OFF });
  if (path === "/arkiv/entities") {
    if (!arkiv) return sendJson(res, { error: ARKIV_OFF }, 503);
    return arkiv.list().then(
      (list) => sendJson(res, list),
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

// The block with the fewest holders, lowest block first on a tie.
function assignBlock() {
  const holders = blocks.map(() => 0);
  for (const p of peers.values()) holders[p.block.index]++;
  return blocks[holders.indexOf(Math.min(...holders))];
}

// The least-busy ready holder of a block, earliest joined first on a tie.
function pickHolder(blockIndex) {
  let best = null;
  for (const p of peers.values()) {
    if (p.block.index !== blockIndex || !p.ready) continue;
    if (!best || p.sessions.size < best.sessions.size) best = p;
  }
  return best;
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
  if (s.tokens > 1) {
    finished.push((1000 * (s.tokens - 1)) / (s.lastAt - s.firstAt));
    if (finished.length > 50) finished.shift();
  }
  if (s.tokens) {
    const perToken = s.tokens > 1 ? `, then ${((s.lastAt - s.firstAt) / (s.tokens - 1)).toFixed(0)} ms per token` : "";
    const hops = s.route.map((pid, i) => `${pid} ${s.hopN[i] ? (s.hopMs[i] / s.hopN[i]).toFixed(0) : "?"} ms`).join(", ");
    const rerouted = s.reroutes ? ` · rerouted ${s.reroutes}×` : "";
    log(`session ${id} ${why ?? "done"}: ${s.tokens} tokens, first token ${secs(s.firstAt - s.startAt)}${perToken} · per hop ${hops}${rerouted}`);
  } else if (why) {
    log(`session ${id} ${why}`);
  }
  changed();
}

// A phone on the route left: swap in another holder of its block. Every phone
// on the route drops the old attempt, and the asker replays the conversation
// under the new one, so the answer continues instead of failing.
function reroute(id, leaver, why) {
  const s = sessions.get(id);
  const hop = s.route.indexOf(leaver.id);
  const replacement = pickHolder(leaver.block.index);
  if (!replacement || s.reroutes >= MAX_REROUTES) {
    const reason = replacement ? `it was already rerouted ${s.reroutes} times` : `no other phone has block ${leaver.block.index + 1} ready`;
    send(peers.get(s.asker), { type: "error", session: id, message: `phone ${leaver.id} ${why} in the middle of the answer, and ${reason}` });
    return endSession(id, `cut: ${leaver.id} ${why}, ${reason}`);
  }
  for (const pid of s.route) {
    const p = peers.get(pid);
    if (!p) continue;
    p.owed.delete(id);
    send(p, { type: "drop", session: id, attempt: s.attempt });
  }
  s.attempt++;
  s.reroutes++;
  s.route[hop] = replacement.id;
  s.hopMs = s.route.map(() => 0);
  s.hopN = s.route.map(() => 0);
  replacement.sessions.add(id);
  send(peers.get(s.asker), { type: "reroute", session: id, attempt: s.attempt, route: s.route });
  log(`session ${id}: ${leaver.id} ${why}, continuing via ${s.route.join(" → ")} (replaying ${s.context} tokens)`);
}

// Phones get a small summary, only when it changes; the dashboard gets
// everything. Sending every phone the full swarm on every token grows with
// the square of the number of phones.
function summary() {
  const holders = blocks.map(() => ({ ready: 0, loading: 0 }));
  for (const p of peers.values()) holders[p.block.index][p.ready ? "ready" : "loading"]++;
  return JSON.stringify({ type: "swarm", blocks, holders, phones: peers.size, sessions: sessions.size });
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
    peers: [...peers.values()].map((p) => ({
      id: p.id, block: p.block.index, ready: p.ready, sessions: p.sessions.size, served: p.served,
      busy: p.owed.size > 0, silentMs: now - p.lastSeen, joinedAt: p.joinedAt,
      rtt: p.rtt, tokenMs: p.tokenMs, prefillMsPerToken: p.prefillMsPerToken, report: p.report,
      servedPerSec: rate(p.samples, "served", now),
      // Share of wall time spent computing, from the compute time the phone reports.
      utilization: rate(p.samples, "computeMs", now) == null ? null : rate(p.samples, "computeMs", now) / 1000,
    })),
    sessions: [...sessions.entries()].map(([id, s]) => ({
      id, asker: s.asker, route: s.route, attempt: s.attempt, reroutes: s.reroutes, context: s.context, tokens: s.tokens,
    })),
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
    peer.ready = true;
    log(`${peer.id} ready with block ${peer.block.index + 1}`);
  } else if (msg.type === "ask") {
    const route = blocks.map((b) => pickHolder(b.index));
    const missing = route.indexOf(null);
    if (missing >= 0) {
      return send(peer, { type: "error", requestId: msg.requestId, message: `waiting for block ${missing + 1}: no phone has it ready yet` });
    }
    const id = nextSession++;
    const now = Date.now();
    sessions.set(id, {
      asker: peer.id, route: route.map((p) => p.id), attempt: 0, reroutes: 0, context: 0,
      startAt: now, firstAt: 0, lastAt: 0, tokens: 0, hopMs: route.map(() => 0), hopN: route.map(() => 0),
    });
    for (const p of route) p.sessions.add(id);
    send(peer, { type: "session", requestId: msg.requestId, session: id, route: route.map((p) => p.id) });
    log(`session ${id}: ${peer.id} asks via ${route.map((p) => p.id).join(" → ")}`);
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
  }
  changed();
}

// The asker's answer finished: save the conversation and this answer's
// metrics to Arkiv. The metrics are the tracker's own measurements; only a
// session this phone asked, that produced tokens, is saved, once.
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
  if (!s || h.attempt !== s.attempt) return; // session ended or rerouted; a late frame
  const expectedFrom = h.hop === 0 ? s.asker : s.route[h.hop - 1];
  const expectedKind = h.hop === 0 ? KIND.TOKENS : h.hop === s.route.length ? KIND.NEXT : KIND.HIDDEN;
  if (peer.id !== expectedFrom || h.kind !== expectedKind || h.hop > s.route.length) {
    log(`dropped a bad frame from ${peer.id} for session ${h.session} hop ${h.hop}`);
    return;
  }
  const now = Date.now();
  if (h.hop === 0) {
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
  log(`${peer.id} ${why} (block ${peer.block.index + 1})`);
  for (const [id, s] of [...sessions]) {
    if (s.asker === peer.id) endSession(id, `ended: asker ${peer.id} ${why}`);
    else if (s.route.includes(peer.id)) reroute(id, peer, why);
  }
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
  if (sessions.size) {
    totals.answeringMs += now - lastTick.t;
    totals.generatedWhileAnswering += totals.generated - lastTick.generated;
  }
  lastTick = { t: now, generated: totals.generated };
  sample(swarmSamples, { t: now, generated: totals.generated, served: totals.served });
  for (const peer of peers.values()) sample(peer.samples, { t: now, served: peer.served, computeMs: peer.report?.computeMs ?? null });
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
  if (watchers.size) changed(); // pings and silences move even when nothing else does
}, 1000).unref();

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
      const block = assignBlock();
      peer = {
        id: peerName(joined++), ws, block, ready: false, sessions: new Set(), served: 0, lastSeen: Date.now(), joinedAt: Date.now(),
        owed: new Map(), rtt: null, pingAt: null, tokenMs: null, prefillMsPerToken: null, report: null, summary: null, samples: [],
      };
      peers.set(peer.id, peer);
      send(peer, { type: "welcome", id: peer.id, block, blocks, weightsVersion });
      log(`${peer.id} joined, holds block ${block.index + 1} (layers ${block.start}–${block.end - 1})`);
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
  console.log(`  management: ${scheme}://localhost:${port}/manage`);
  console.log(`  blocks: ${blocks.map((b) => `[${b.start}, ${b.end})`).join(" ")}`);
  console.log(arkiv ? `  arkiv: saving conversations as ${arkiv.address} on Rabdi, see ${scheme}://localhost:${port}/arkiv` : `  ${ARKIV_OFF}`);
});
