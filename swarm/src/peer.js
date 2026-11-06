// One phone in the swarm. Runs unchanged in Node (tests) and in a browser
// Web Worker (swarm/web/worker.js).
//
//   const peer = new Peer({ server: "http://localhost:8080" })
//   await peer.connect()   // the tracker assigns a block: peer.id, peer.block
//   await peer.load()      // downloads that block's weights, starts serving it
//   for await (const step of peer.ask(promptIds)) step.token
//
// Serving: a frame for this phone arrives, the stage runs on it, and the
// result goes back to the tracker with hop + 1. The phone never needs to know
// the route; the tracker forwards each frame to route[hop]. Frames wait in a
// queue and run one at a time, pausing between layers so the socket keeps
// being read and heartbeats keep being answered while the phone computes.
//
// Rerouting: if a phone on an asker's route leaves, the tracker swaps in
// another holder of that block and bumps the session's attempt. The asker
// replays every token so far under the new attempt, so each phone on the new
// route rebuilds its KV cache, and the answer continues where it was.

import { argmax } from "../../engine/src/pipeline.js";
import { Stage } from "../../engine/src/stage.js";
import { KIND, decodeFrame, encodeFrame } from "./protocol.js";
import { Tokenizer } from "./tokenizer.js";

export class Peer {
  // readFile(name) -> bytes of one file under the tracker's /weights/.
  // onEvent(event) gets { type: "swarm" | "progress" | "loaded" | "assign" | "served" | "reroute" | "recorded" | "wallet" | "withdrawn" | "fatal" | "closed", ... }.
  // tap(frame) sees every binary frame this phone sends (tests).
  // role "client" joins without a block: it asks the swarm but serves nothing (swarm/api.js).
  constructor({ server, readFile = null, onEvent = () => {}, tap = null, role = "phone" }) {
    this.server = server.replace(/\/$/, "");
    this.role = role;
    this.readFile = readFile ?? ((name) => fetchBytes(`${this.server}/weights/${name}`));
    this.onEvent = onEvent;
    this.tap = tap;
    this.ws = null;
    this.id = null;
    this.block = null;
    this.weightsVersion = null;
    this.stage = null;
    this.tokenizer = null;
    this.served = 0;      // tokens this phone has run its block on
    this.computeMs = 0;
    this.decodeMs = 0;    // the same, for frames of one generated token only
    this.decoded = 0;
    this.requests = new Map(); // request id -> { resolve, reject }
    this.asking = new Map();   // session -> state of a question this phone asked
    this.chat = null;          // the kept conversation, between its turns
    this.loads = 0;            // block loads started; only the latest one counts
    this.loading = null;
    this.nextRequest = 1;
    this.queue = [];           // frames waiting to be served, oldest first
    this.working = false;
    this.ended = new Set();    // sessions the tracker has ended
    this.dropped = new Set();  // "session.attempt" keys the tracker has dropped
    this.pause = makePause();
  }

  connect() {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(this.server.replace(/^http/, "ws") + "/ws");
      ws.binaryType = "arraybuffer";
      this.ws = ws;
      ws.onopen = () => this.send({ type: "hello", role: this.role });
      ws.onerror = () => reject(new Error(`cannot reach the tracker at ${this.server}`));
      ws.onclose = () => this.closed("Disconnected from the tracker. Reload the page to rejoin.");
      ws.onmessage = (e) => {
        if (typeof e.data !== "string") return this.onFrame(e.data);
        const msg = JSON.parse(e.data);
        if (msg.type === "welcome") {
          this.id = msg.id;
          this.block = msg.block;
          this.weightsVersion = msg.weightsVersion;
          this.walletChallenge = msg.walletChallenge; // what the page signs to link its wallet
          resolve(msg);
        } else {
          this.onControl(msg);
        }
      };
    });
  }

  // Loads this phone's block and tells the tracker it is ready. If the tracker
  // moves the phone meanwhile, the load in progress is dropped and this
  // resolves with the new block's stage.
  load() {
    const generation = ++this.loads;
    this.loading = this.loadBlock(generation);
    return this.loading;
  }

  async loadBlock(generation) {
    const block = this.block;
    const manifest = JSON.parse(new TextDecoder().decode(await this.readFile("manifest.json")));
    const { start, end } = block;
    const L = manifest.config.num_layers;
    const files = manifest.layers.slice(start, end);
    if (start === 0 || (end === L && !manifest.lm_head)) files.push(manifest.embed);
    if (end === L) files.push(manifest.final_norm, ...(manifest.lm_head ? [manifest.lm_head] : []));
    const total = files.reduce((sum, f) => sum + f.bytes, 0);
    let loaded = 0;
    const readFile = async (name) => {
      const bytes = await this.readFile(name);
      loaded += bytes.byteLength;
      this.onEvent({ type: "progress", loaded, total });
      return bytes;
    };
    const stage = await Stage.load({ manifest, start, end, readFile });
    if (generation !== this.loads) return this.loading;
    this.stage = stage;
    this.send({ type: "ready", block: block.id });
    this.onEvent({ type: "loaded", describe: stage.describe(), weightBytes: stage.weightBytes, kernels: stage.kernels });
    return stage;
  }

  // The tracker moved this phone to another block (a split, or a block that
  // lost its phones). The old block's sessions have all been rerouted, so
  // drop it before loading the new one: never both in memory at once.
  reassign(block) {
    this.block = block;
    this.stage = null;
    this.onEvent({ type: "assign", block });
    this.load().catch((err) => this.onEvent({ type: "fatal", message: err.message }));
  }

  // The tokenizer, with the model's chat layout from the manifest.
  async loadTokenizer() {
    const text = async (name) => new TextDecoder().decode(await this.readFile(name));
    const [json, manifest] = await Promise.all([text("tokenizer/tokenizer.json"), text("manifest.json")]);
    this.tokenizer = new Tokenizer(JSON.parse(json), JSON.parse(manifest).chat ?? undefined);
    return this.tokenizer;
  }

  // Generates greedily through the swarm. Yields { token, session, route,
  // reroutes, cached, ms } per new token, where ms is the round trip for that
  // token and cached is how many tokens of promptIds the route already had.
  //
  // With keep, the session stays open after the answer, and every phone on
  // the route keeps its KV cache. If the next ask's promptIds start with
  // everything sent so far (the previous prompt and answer), only the rest is
  // sent. Anything else ends the kept session and starts a new one.
  //
  // record: { chatId, messages } saves the conversation to Arkiv when the
  // answer finishes: messages is the chat up to this question, and the
  // tracker adds the answer's metrics and writes it (it holds the wallet).
  // Needs loadTokenizer(), to turn the answer back into text.
  //
  // payment: the signed PIPER payment for this question, when asking is paid
  // (src/market.js). The tracker opens it on-chain and answers with the
  // token limit it pays for: the prompt's new tokens and the answer together.
  // The answer stops there (finish "limit") if the stop token hasn't come.
  async *ask(promptIds, { maxNew = 256, stopIds = [2], keep = false, record = null, payment = null } = {}) {
    const ids = Array.from(promptIds);
    const prev = this.chat;
    this.chat = null;
    const cached = prev && !prev.error && ids.length > prev.fed && startsWith(ids, prev.history, prev.fed) ? prev : null;
    if (prev && !cached) this.endSession(prev.session);
    const paidFrom = cached?.fed ?? 0; // where the tracker starts charging this turn
    let reply;
    try {
      reply = await this.request({ type: "ask", session: cached?.session, ...(payment && { payment }) });
    } catch (err) {
      if (cached) this.endSession(cached.session);
      throw err;
    }
    const { session, route, attempt } = reply;
    // Generating n tokens runs the new prompt tokens, then n - 1 answer tokens fed back.
    let limit = Infinity;
    if (reply.maxTokens != null) {
      limit = reply.maxTokens - (ids.length - paidFrom) + 1;
      if (limit < 1) {
        this.endSession(session);
        throw new Error(`what you'd pay covers ${reply.maxTokens} tokens, and the question is ${ids.length - paidFrom}: raise the most you'd pay`);
      }
    }
    const steps = Math.min(maxNew, limit);
    let q;
    if (cached && session === cached.session) {
      if (attempt !== cached.attempt) cached.fed = 0; // rerouted while idle: the new route has seen nothing
      q = Object.assign(cached, { route, attempt, history: ids });
    } else {
      if (cached) this.asking.delete(cached.session); // the tracker had ended it: start over
      q = { session, attempt, route, reroutes: 0, history: ids, fed: 0, waiting: null, error: null };
      this.asking.set(session, q);
    }
    const already = q.fed;
    const stop = new Set(stopIds);
    const answer = [];
    const timing = { firstMs: 0, restMs: 0 };
    try {
      for (let i = 0; i < steps; i++) {
        const t0 = performance.now();
        const token = await new Promise((resolve, reject) => {
          if (q.error) return reject(q.error);
          q.waiting = { resolve, reject };
          this.feed(session, q);
        });
        const ms = performance.now() - t0;
        if (i === 0) timing.firstMs = ms;
        else timing.restMs += ms;
        const finish = stop.has(token) ? "stop" : i === steps - 1 ? (steps < maxNew ? "limit" : "length") : null;
        if (!stop.has(token)) answer.push(token);
        // The answer is complete: save it now, before the session ends or goes idle.
        if (finish && record) this.record(session, record, answer, finish === "stop" ? "stop" : "length", timing);
        yield { token, session, route: q.route, reroutes: q.reroutes, cached: already, ms, finish };
        if (finish === "stop") break;
        q.history.push(token);
      }
    } finally {
      q.waiting = null;
      if (keep && !q.error && this.ws.readyState === WebSocket.OPEN) {
        this.chat = q;
        this.send({ type: "turn", session });
      } else {
        this.endSession(session);
      }
    }
  }

  // Ends the kept conversation, so the route frees its KV caches.
  endChat() {
    if (this.chat) this.endSession(this.chat.session);
    this.chat = null;
  }

  endSession(session) {
    this.asking.delete(session);
    if (this.ws?.readyState === WebSocket.OPEN) this.send({ type: "end", session });
  }

  // Sends the tokens the route hasn't seen yet: the whole history after a
  // reroute, otherwise only the newest token.
  feed(session, q) {
    const ids = Int32Array.from(q.history.slice(q.fed));
    this.sendFrame({ kind: KIND.TOKENS, hop: 0, attempt: q.attempt, session, pos: q.fed, n: ids.length }, ids);
    q.fed = q.history.length;
  }

  // Asks the tracker to save the finished conversation to Arkiv. The tracker
  // answers with a "recorded" event: the entity, and the transaction's link.
  record(session, { chatId, messages }, answer, finish, { firstMs, restMs }) {
    if (!this.tokenizer || this.ws?.readyState !== WebSocket.OPEN) return;
    const content = this.tokenizer.decode(answer, { skipSpecial: true });
    this.send({
      type: "record",
      session,
      chatId,
      finish,
      messages: [...messages, { role: "assistant", content }],
      asker: { firstTokenMs: firstMs, msPerToken: answer.length > 1 ? restMs / (answer.length - 1) : null },
    });
  }

  // What the phone reports to the tracker: anything the tracker can't measure itself.
  report(stats) {
    if (this.ws?.readyState !== WebSocket.OPEN) return;
    this.send({
      type: "stats",
      stats: {
        ...stats,
        served: this.served,
        computeMs: this.computeMs,
        avgComputeMs: this.served ? this.computeMs / this.served : null,
        decodeMsPerToken: this.decoded ? this.decodeMs / this.decoded : null,
        queued: this.queue.length,
      },
    });
  }

  // Wallet messages from the page to the tracker: "wallet" links the wallet
  // this phone earns into, "withdraw" sends its tokens out (src/wallet-auth.js,
  // src/rewards.js); "quote", "swap" and "topup" trade on the pool
  // (src/market.js). The answers arrive as "wallet", "withdrawn" and
  // "walletReply" events.
  sendWallet(msg) {
    if (this.ws?.readyState !== WebSocket.OPEN) return false;
    if (!["wallet", "withdraw", "quote", "swap", "topup"].includes(msg.type)) return false;
    this.send(msg);
    return true;
  }

  close() {
    this.ws?.close();
  }

  // --- internals ---

  send(msg) {
    this.ws.send(JSON.stringify(msg));
  }

  sendFrame(header, payload) {
    const buf = encodeFrame(header, payload);
    this.tap?.(buf);
    this.ws.send(buf);
  }

  request(msg) {
    const requestId = this.nextRequest++;
    return new Promise((resolve, reject) => {
      this.requests.set(requestId, { resolve, reject });
      this.send({ ...msg, requestId });
    });
  }

  onControl(msg) {
    if (msg.type === "session") {
      this.requests.get(msg.requestId)?.resolve(msg);
      this.requests.delete(msg.requestId);
    } else if (msg.type === "error") {
      const err = new Error(msg.message);
      if (msg.requestId !== undefined) {
        this.requests.get(msg.requestId)?.reject(err);
        this.requests.delete(msg.requestId);
      } else {
        const q = this.asking.get(msg.session);
        if (!q) return;
        q.error = err;
        q.waiting?.reject(err);
        q.waiting = null;
      }
    } else if (msg.type === "reroute") {
      const q = this.asking.get(msg.session);
      if (!q) return;
      q.attempt = msg.attempt;
      q.route = msg.route;
      q.reroutes = msg.reroutes ?? q.reroutes + 1;
      q.fed = 0;
      this.onEvent({ type: "reroute", session: msg.session, route: msg.route });
      if (q.waiting) this.feed(msg.session, q);
    } else if (msg.type === "drop") {
      this.drop(msg.session, msg.attempt);
    } else if (msg.type === "assign") {
      this.reassign(msg.block);
    } else if (["swarm", "recorded", "wallet", "withdrawn", "walletReply", "query"].includes(msg.type)) {
      this.onEvent(msg);
    }
  }

  // Without an attempt, the session is over; with one, only that attempt is.
  drop(session, attempt) {
    if (attempt === undefined) {
      this.ended.add(session);
      for (const key of this.stage?.sessions ?? []) if (key.startsWith(`${session}.`)) this.stage.drop(key);
    } else {
      const key = `${session}.${attempt}`;
      this.dropped.add(key);
      this.stage?.drop(key);
    }
  }

  isDropped(f) {
    return this.ended.has(f.session) || this.dropped.has(`${f.session}.${f.attempt}`);
  }

  onFrame(buf) {
    const f = decodeFrame(buf);
    if (f.kind === KIND.NEXT) {
      const q = this.asking.get(f.session);
      if (!q || f.attempt !== q.attempt || !q.waiting) return;
      q.waiting.resolve(f.payload[0]);
      q.waiting = null;
      return;
    }
    this.queue.push(f);
    if (!this.working) this.work();
  }

  async work() {
    this.working = true;
    while (this.queue.length) {
      const f = this.queue.shift();
      if (!this.isDropped(f)) await this.serve(f);
    }
    this.working = false;
  }

  async serve(f) {
    const key = `${f.session}.${f.attempt}`;
    const stage = this.stage; // the tracker may move this phone to another block while it computes
    try {
      if (!stage) throw new Error("block is still loading");
      if ((f.kind === KIND.TOKENS) !== stage.hasEmbedding) {
        throw new Error(`block ${this.block.index + 1} got the wrong kind of frame`);
      }
      const t0 = performance.now();
      const out = await stage.forwardAsync(key, f.payload, f.pos, { lastOnly: true }, this.pause);
      const ms = performance.now() - t0;
      // Dropped while computing: the stage re-recorded the session at the end; forget it again.
      if (this.isDropped(f)) return stage.drop(key);
      this.served += f.n;
      this.computeMs += ms;
      if (f.n === 1) {
        this.decodeMs += ms;
        this.decoded++;
      }
      const next = { hop: f.hop + 1, attempt: f.attempt, session: f.session };
      if (stage.hasOutput) {
        this.sendFrame({ ...next, kind: KIND.NEXT, pos: f.pos + f.n, n: 1 }, Int32Array.of(argmax(out)));
      } else {
        this.sendFrame({ ...next, kind: KIND.HIDDEN, pos: f.pos, n: f.n }, out);
      }
      this.onEvent({ type: "served", session: f.session, n: f.n, ms, served: this.served, computeMs: this.computeMs });
    } catch (err) {
      if (this.ws.readyState === WebSocket.OPEN) {
        this.send({ type: "fail", session: f.session, attempt: f.attempt, message: `${this.id}: ${err.message}` });
      }
    }
  }

  closed(reason) {
    const err = new Error(reason);
    for (const p of this.requests.values()) p.reject(err);
    for (const q of this.asking.values()) {
      q.error = err;
      q.waiting?.reject(err);
      q.waiting = null;
    }
    this.requests.clear();
    this.queue.length = 0;
    this.onEvent({ type: "closed", reason });
  }
}

// Lets the event loop run between layers. Nested setTimeout is clamped to
// 4 ms, too slow to call 30 times per token; setImmediate and a
// MessageChannel are not.
function makePause() {
  if (typeof setImmediate === "function") return () => new Promise((resolve) => setImmediate(resolve));
  const channel = new MessageChannel();
  const waiting = [];
  channel.port1.onmessage = () => waiting.shift()?.();
  return () => new Promise((resolve) => {
    waiting.push(resolve);
    channel.port2.postMessage(0);
  });
}

function startsWith(ids, prefix, n) {
  for (let i = 0; i < n; i++) if (ids[i] !== prefix[i]) return false;
  return true;
}

async function fetchBytes(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  return res.arrayBuffer();
}
