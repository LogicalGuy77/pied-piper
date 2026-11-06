// An OpenAI-compatible endpoint in front of the swarm, so any harness or SDK
// can use the phones: POST /v1/chat/completions (streaming or not) and
// GET /v1/models. Joins the tracker as a client: it asks like a phone but
// serves no block.
//
//   node api.js [--tracker http://localhost:8080] [--port 8000] [--model smollm2-135m-instruct]
//
// Decoding is greedy, as everywhere in the swarm: temperature, top_p, stop,
// n and tools are accepted and ignored. Every answer equals Hugging Face's.

import { createServer } from "node:http";
import { parseArgs } from "node:util";
import { Peer } from "./src/peer.js";

const { values: opts } = parseArgs({
  options: {
    tracker: { type: "string", default: "http://localhost:8080" },
    port: { type: "string", default: "8000" },
    model: { type: "string", default: "smollm2-135m-instruct" },
  },
});
const MODEL = opts.model;
const MAX_NEW = 512;

const peer = new Peer({
  server: opts.tracker,
  role: "client",
  onEvent: (e) => {
    if (e.type === "closed") {
      console.error(`${e.reason} Start the tracker, then this again.`);
      process.exit(1);
    }
  },
});
await peer.connect();
const tok = await peer.loadTokenizer();
const EOS = tok.eosId;

// Harnesses resend the whole conversation every turn. The phones on the
// route keep the KV cache between turns (peer.ask with keep), so when a
// request extends the previous conversation only its new turns are sent,
// built the way the phone page builds them (web/worker.js): the previous
// ids, which end with <|im_end|>, then the new turns.
let last = null; // { messages, ids }: the previous conversation, answer included

function promptIds(messages) {
  const n = last?.messages.length ?? 0;
  const extended = n > 0 && messages.length > n
    && last.messages.every((m, i) => m.role === messages[i].role && m.content === messages[i].content);
  if (!extended) return tok.chat(messages);
  const turns = messages.slice(n).map((m) => `<|im_start|>${m.role}\n${m.content}<|im_end|>\n`).join("");
  return [...last.ids, ...tok.encode(`\n${turns}<|im_start|>assistant\n`)];
}

// OpenAI messages -> the roles the chat template knows, with string content.
// developer becomes system; tool results, which this model can't produce
// anyway, are shown as user text.
function normalize(messages) {
  if (!Array.isArray(messages) || !messages.length) throw new Error("messages must be a non-empty array");
  return messages.map((m) => ({
    role: m.role === "developer" || m.role === "system" ? "system" : m.role === "assistant" ? "assistant" : "user",
    content: typeof m.content === "string" ? m.content : (m.content ?? []).map((p) => p?.text ?? "").join(""),
  }));
}

const readBody = (req) => new Promise((resolve, reject) => {
  let data = "";
  req.on("data", (c) => (data += c));
  req.on("end", () => resolve(data));
  req.on("error", reject);
});

function sendJson(res, status, body) {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}
const errorBody = (message, type = "invalid_request_error") => ({ error: { message, type, param: null, code: null } });
const time = () => new Date().toISOString().slice(11, 19);

async function chatCompletion(req, res) {
  let body, messages;
  try {
    body = JSON.parse(await readBody(req));
    messages = normalize(body.messages);
  } catch (err) {
    return sendJson(res, 400, errorBody(err.message));
  }
  const maxNew = Math.min(body.max_completion_tokens ?? body.max_tokens ?? MAX_NEW, MAX_NEW);
  const id = `chatcmpl-${crypto.randomUUID()}`;
  const created = Math.floor(Date.now() / 1000);
  const chunk = (delta, finish_reason = null, extra = {}) =>
    res.write(`data: ${JSON.stringify({ id, object: "chat.completion.chunk", created, model: MODEL,
      choices: delta ? [{ index: 0, delta, finish_reason }] : [], ...extra })}\n\n`);
  let gone = false; // the harness hung up mid-answer
  res.on("close", () => { if (!res.writableFinished) gone = true; });
  if (body.stream) {
    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
    chunk({ role: "assistant", content: "" });
  }

  const ids = promptIds(messages);
  const decoder = tok.streamDecoder();
  const answer = [];
  let text = "", finish = "length", cached = 0, route = null, firstMs = 0;
  const t0 = performance.now();
  try {
    for await (const step of peer.ask(ids, { maxNew, stopIds: [EOS], keep: true })) {
      if (gone) break; // stop asking the swarm; the next ask ends the kept session
      ({ cached, route } = step);
      if (!answer.length) firstMs = step.ms;
      if (step.token === EOS) {
        finish = "stop";
        break;
      }
      answer.push(step.token);
      const piece = decoder.push(step.token);
      text += piece;
      if (body.stream && piece) chunk({ content: piece });
    }
    text += decoder.flush();
  } catch (err) {
    last = null;
    console.log(`${time()} failed: ${err.message}`);
    if (!res.headersSent) return sendJson(res, 503, errorBody(err.message, "server_error"));
    res.write(`data: ${JSON.stringify(errorBody(err.message, "server_error"))}\n\n`);
    return res.end();
  }
  last = gone ? null : { messages: [...messages, { role: "assistant", content: text }], ids: [...ids, ...answer, EOS] };
  const perToken = answer.length > 1 ? `${((performance.now() - t0 - firstMs) / (answer.length - 1)).toFixed(0)} ms per token` : "";
  console.log(`${time()} ${answer.length} tokens via ${route?.join(" → ") ?? "?"} · prompt ${ids.length} tokens, ${cached} cached`
    + ` · first token ${(firstMs / 1000).toFixed(1)} s${perToken ? `, then ${perToken}` : ""} · ${gone ? "client hung up" : finish}`);
  if (gone) return;
  const usage = {
    prompt_tokens: ids.length, completion_tokens: answer.length, total_tokens: ids.length + answer.length,
    prompt_tokens_details: { cached_tokens: cached },
  };
  if (body.stream) {
    chunk({}, finish);
    if (body.stream_options?.include_usage) chunk(null, null, { usage });
    res.write("data: [DONE]\n\n");
    return res.end();
  }
  sendJson(res, 200, {
    id, object: "chat.completion", created, model: MODEL,
    choices: [{ index: 0, message: { role: "assistant", content: text }, finish_reason: finish }], usage,
  });
}

createServer((req, res) => {
  const path = new URL(req.url, "http://x").pathname;
  if (req.method === "GET" && path === "/v1/models") {
    return sendJson(res, 200, { object: "list", data: [{ id: MODEL, object: "model", created: 0, owned_by: "swarm" }] });
  }
  if (req.method === "POST" && path === "/v1/chat/completions") return chatCompletion(req, res);
  sendJson(res, 404, errorBody(`no route ${req.method} ${path}`));
}).listen(Number(opts.port), () => {
  console.log(`OpenAI-compatible API at http://localhost:${opts.port}/v1 · model ${MODEL} · joined ${opts.tracker} as client ${peer.id}`);
});
