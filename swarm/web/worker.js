// Runs this tab's phone in a Web Worker: the WebSocket, the block's weights,
// the stage engine and the tokenizer all live here, so the chat stays
// responsive while the tab computes for others.

import { Peer } from "../src/peer.js";

const post = (msg) => self.postMessage(msg);
const CACHE_PREFIX = "swarm-weights-";
let peer = null;
let cache = null;
let fromCache = 0; // bytes read from the cache instead of the network

// Weights are kept in the Cache API between visits, under the tracker's
// weights version; caches from older versions are deleted. The Cache API
// only exists on https:// pages and localhost.
async function openCache(version) {
  if (!self.caches || !version) return null;
  try {
    for (const name of await caches.keys()) {
      if (name.startsWith(CACHE_PREFIX) && name !== CACHE_PREFIX + version) await caches.delete(name);
    }
    return await caches.open(CACHE_PREFIX + version);
  } catch {
    return null;
  }
}

async function readFile(name) {
  const url = `${peer.server}/weights/${name}`;
  const hit = await cache?.match(url);
  if (hit) {
    const bytes = await hit.arrayBuffer();
    fromCache += bytes.byteLength;
    return bytes;
  }
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  if (!cache) return res.arrayBuffer();
  // Stream to the cache, then read it back: one copy in memory, not two.
  try {
    await cache.put(url, res);
    return await (await cache.match(url)).arrayBuffer();
  } catch {
    return fetchBytes(url); // storage full: download again, uncached
  }
}

async function fetchBytes(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  return res.arrayBuffer();
}

async function start(server) {
  peer = new Peer({ server, readFile, onEvent: post });
  try {
    const welcome = await peer.connect();
    cache = await openCache(peer.weightsVersion);
    post({ type: "welcome", id: peer.id, block: peer.block, blocks: welcome.blocks, cached: !!cache });
    await peer.loadTokenizer();
    post({ type: "tokenizer" });
    await peer.load();
    post({ type: "loaded", describe: peer.stage.describe(), weightBytes: peer.stage.weightBytes, fromCache, kernels: peer.stage.kernels });
  } catch (err) {
    post({ type: "fatal", message: err.message });
  }
}

// The conversation's token ids as the swarm has seen them: every prompt, and
// every answer exactly as generated (not re-tokenized from its text), so
// each new question extends what the route's KV caches already hold.
let conversation = null;

// messages is the same conversation as text, up to this question, for Arkiv.
async function ask(text, messages, maxNew, chatId) {
  const tok = peer.tokenizer;
  const turn = `<|im_start|>user\n${text}<|im_end|>\n<|im_start|>assistant\n`;
  const ids = conversation ? [...conversation, ...tok.encode(`\n${turn}`)] : tok.chat([{ role: "user", content: text }]);
  const decoder = tok.streamDecoder();
  const answer = [];
  let firstMs = 0, restMs = 0, reroutes = 0, cached = 0;
  try {
    const record = chatId ? { chatId, messages } : null;
    for await (const step of peer.ask(ids, { maxNew, stopIds: [tok.eosId], keep: true, record })) {
      answer.push(step.token);
      reroutes = step.reroutes;
      cached = step.cached;
      if (answer.length === 1) firstMs = step.ms;
      else restMs += step.ms;
      post({ type: "token", text: decoder.push(step.token), route: step.route, session: step.session });
    }
    post({ type: "token", text: decoder.flush() });
    conversation = [...ids, ...answer];
    if (answer.at(-1) !== tok.eosId) conversation.push(tok.eosId);
    const tokens = answer.length;
    post({ type: "done", tokens, firstMs, msPerToken: tokens > 1 ? restMs / (tokens - 1) : 0, reroutes, cached, prompt: ids.length });
  } catch (err) {
    post({ type: "error", message: err.message }); // the conversation stays as it was before this question
  }
}

function newChat() {
  conversation = null;
  peer?.endChat();
}

self.onmessage = ({ data }) => {
  if (data.type === "start") start(data.server);
  else if (data.type === "ask") ask(data.text, data.messages, data.maxNew, data.chatId);
  else if (data.type === "new-chat") newChat();
  else if (data.type === "stats") peer?.report(data.stats);
};
