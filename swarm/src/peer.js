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
  // onEvent(event) gets { type: "swarm" | "progress" | "served" | "reroute" | "recorded" | "closed", ... }.
  // tap(frame) sees every binary frame this phone sends (tests).
  constructor({ server, readFile = null, onEvent = () => {}, tap = null }) {
    this.server = server.replace(/\/$/, "");
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
      ws.onopen = () => this.send({ type: "hello" });
      ws.onerror = () => reject(new Error(`cannot reach the tracker at ${this.server}`));
      ws.onclose = () => this.closed("Disconnected from the tracker. Reload the page to rejoin.");
      ws.onmessage = (e) => {
        if (typeof e.data !== "string") return this.onFrame(e.data);
        const msg = JSON.parse(e.data);
        if (msg.type === "welcome") {
          this.id = msg.id;
          this.block = msg.block;
          this.weightsVersion = msg.weightsVersion;
          resolve(msg);
        } else {
          this.onControl(msg);
        }
      };
    });
  }

  async load() {
    const manifest = JSON.parse(new TextDecoder().decode(await this.readFile("manifest.json")));
    const { start, end } = this.block;
    const L = manifest.config.num_layers;
    const files = manifest.layers.slice(start, end);
    if (start === 0 || end === L) files.push(manifest.embed);
    if (end === L) files.push(manifest.final_norm);
    const total = files.reduce((sum, f) => sum + f.bytes, 0);
    let loaded = 0;
    const readFile = async (name) => {
      const bytes = await this.readFile(name);
      loaded += bytes.byteLength;
      this.onEvent({ type: "progress", loaded, total });
      return bytes;
    };
    this.stage = await Stage.load({ manifest, start, end, readFile });
    this.send({ type: "ready" });
    return this.stage;
  }

  async loadTokenizer() {
    const json = JSON.parse(new TextDecoder().decode(await this.readFile("tokenizer/tokenizer.json")));
    this.tokenizer = new Tokenizer(json);
    return this.tokenizer;
  }

  // Generates greedily through the swarm. Yields { token, session, route,
  // reroutes, ms } per new token, where ms is the round trip for that token.
  //
  // record: { chatId, messages } saves the conversation to Arkiv when the
  // answer finishes: messages is the chat up to this question, and the
  // tracker adds the answer's metrics and writes it (it holds the wallet).
  // Needs loadTokenizer(), to turn the answer back into text.
  async *ask(promptIds, { maxNew = 256, stopIds = [2], record = null } = {}) {
    const { session, route } = await this.request({ type: "ask" });
    const q = { attempt: 0, route, reroutes: 0, history: Array.from(promptIds), fed: 0, waiting: null, error: null };
    this.asking.set(session, q);
    const stop = new Set(stopIds);
    const answer = [];
    const timing = { firstMs: 0, restMs: 0 };
    try {
      for (let i = 0; i < maxNew; i++) {
        const t0 = performance.now();
        const token = await new Promise((resolve, reject) => {
          if (q.error) return reject(q.error);
          q.waiting = { resolve, reject };
          this.feed(session, q);
        });
        const ms = performance.now() - t0;
        if (i === 0) timing.firstMs = ms;
        else timing.restMs += ms;
        const finish = stop.has(token) ? "stop" : i === maxNew - 1 ? "length" : null;
        if (!stop.has(token)) answer.push(token);
        // The answer is complete: save it now, before the session ends.
        if (finish && record) this.record(session, record, answer, finish, timing);
        yield { token, session, route: q.route, reroutes: q.reroutes, ms };
        if (finish === "stop") break;
        q.history.push(token);
      }
    } finally {
      this.asking.delete(session);
      if (this.ws.readyState === WebSocket.OPEN) this.send({ type: "end", session });
    }
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
      q.reroutes++;
      q.fed = 0;
      this.onEvent({ type: "reroute", session: msg.session, route: msg.route });
      if (q.waiting) this.feed(msg.session, q);
    } else if (msg.type === "drop") {
      this.drop(msg.session, msg.attempt);
    } else if (msg.type === "swarm" || msg.type === "recorded") {
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
    try {
      if (!this.stage) throw new Error("block is still loading");
      if ((f.kind === KIND.TOKENS) !== this.stage.hasEmbedding) {
        throw new Error(`block ${this.block.index + 1} got the wrong kind of frame`);
      }
      const t0 = performance.now();
      const out = await this.stage.forwardAsync(key, f.payload, f.pos, { lastOnly: true }, this.pause);
      const ms = performance.now() - t0;
      // Dropped while computing: the stage re-recorded the session at the end; forget it again.
      if (this.isDropped(f)) return this.stage.drop(key);
      this.served += f.n;
      this.computeMs += ms;
      if (f.n === 1) {
        this.decodeMs += ms;
        this.decoded++;
      }
      const next = { hop: f.hop + 1, attempt: f.attempt, session: f.session };
      if (this.stage.hasOutput) {
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

async function fetchBytes(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  return res.arrayBuffer();
}
