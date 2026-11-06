// Byte-level BPE tokenizers (SmolLM2, MiniCPM5, Qwen, Llama 3 ...), read from
// tokenizer.json. Runs in Node and in the browser. Checked against Hugging
// Face's ids by swarm/test/check.js.
//
//   const tok = new Tokenizer(JSON.parse(text), manifest.chat)
//   tok.encode("Hello")            // [19556]
//   tok.chat([{ role: "user", content: "Hi" }])  // prompt ids, ready to generate
//   tok.decode(ids)                // text
//   const d = tok.streamDecoder(); d.push(id)    // text to show for each new token
//
// manifest.chat is how the model's chat template lays out ChatML (written by
// reference/export.py); without it, SmolLM2's layout is assumed.

// The GPT-2 pre-tokenizer: contractions, words, numbers, punctuation, spaces.
// ByteLevel runs it when use_regex is on; the newer tokenizers spell out
// their own patterns in tokenizer.json instead.
const GPT2_PIECES = "'s|'t|'re|'ve|'m|'ll|'d| ?\\p{L}+| ?\\p{N}+| ?[^\\s\\p{L}\\p{N}]+|\\s+(?!\\S)|\\s+";

// A tokenizer.json pattern (Rust regex syntax) as a JS RegExp. The one thing
// JS lacks that these patterns use is the inline (?i:...) group, so that is
// unrolled: each letter in it becomes a [xX] class.
function jsRegex(pattern) {
  const unrolled = pattern.replace(/\(\?i:((?:\\.|[^()\\])*)\)/g, (_, body) =>
    "(?:" + body.replace(/\\.|[a-zA-Z]/g, (c) => (c.length === 1 ? `[${c.toLowerCase()}${c.toUpperCase()}]` : c)) + ")");
  return new RegExp(unrolled, "gu");
}

// The pre-tokenizer as a list of regexes to split by, in order. Each split is
// "isolated": the matches and the text between them all become pieces.
function splitters(json) {
  const p = json.pre_tokenizer;
  const steps = p?.type === "Sequence" ? p.pretokenizers : p ? [p] : [];
  const out = [];
  let byteLevel = false;
  for (const s of steps) {
    if (s.type === "ByteLevel") {
      if (s.use_regex !== false) out.push(new RegExp(GPT2_PIECES, "gu"));
      byteLevel = true;
    } else if (s.type === "Split" && s.behavior === "Isolated" && s.pattern?.Regex !== undefined && !s.invert) {
      out.push(jsRegex(s.pattern.Regex));
    } else if (s.type === "Digits") {
      out.push(s.individual_digits ? /\p{N}/gu : /\p{N}+/gu);
    } else {
      throw new Error(`unsupported pre-tokenizer ${JSON.stringify(s)}`);
    }
  }
  if (!byteLevel) throw new Error("only byte-level BPE tokenizers are supported");
  return out;
}

function splitIsolated(text, re) {
  const pieces = [];
  let last = 0;
  for (const m of text.matchAll(re)) {
    if (m.index > last) pieces.push(text.slice(last, m.index));
    if (m[0]) pieces.push(m[0]);
    last = m.index + m[0].length;
  }
  if (last < text.length) pieces.push(text.slice(last));
  return pieces;
}

// GPT-2's map from each of the 256 bytes to a printable character, so BPE can
// work on strings. Printable bytes map to themselves, the rest to 256 + k.
function byteChars() {
  const chars = new Array(256);
  let extra = 0;
  for (let b = 0; b < 256; b++) {
    const printable = (b >= 33 && b <= 126) || (b >= 161 && b <= 172) || (b >= 174 && b <= 255);
    chars[b] = String.fromCharCode(printable ? b : 256 + extra++);
  }
  return chars;
}

const BYTE_CHAR = byteChars();
const CHAR_BYTE = new Map(BYTE_CHAR.map((c, b) => [c, b]));
const utf8 = new TextEncoder();

// SmolLM2's chat layout, for manifests written before chat profiles existed.
const SMOLLM2_CHAT = {
  format: "chatml",
  bos: "",
  system: "You are a helpful AI assistant named SmolLM, trained by Hugging Face",
  assistant_prefix: "",
  assistant_history_prefix: "",
};

export class Tokenizer {
  constructor(json, chat = SMOLLM2_CHAT) {
    const model = json.model;
    if (model.type !== "BPE" || json.normalizer) {
      throw new Error("only byte-level BPE tokenizers without a normalizer are supported");
    }
    if (chat.format !== "chatml") throw new Error(`unsupported chat format ${JSON.stringify(chat.format)}`);
    this.chatProfile = chat;
    this.splitters = splitters(json);
    this.vocab = new Map(Object.entries(model.vocab));
    this.tokens = [];
    for (const [token, id] of this.vocab) this.tokens[id] = token;
    this.ranks = new Map();
    model.merges.forEach((m, rank) => this.ranks.set(Array.isArray(m) ? m.join(" ") : m, rank));

    // Added tokens are matched whole, before BPE. The special ones among
    // them (<|im_end|> and friends) are what decoding can skip.
    this.added = new Map(json.added_tokens.map((t) => [t.content, t.id]));
    this.special = new Map(json.added_tokens.filter((t) => t.special).map((t) => [t.content, t.id]));
    for (const [content, id] of this.added) this.tokens[id] = content;
    const escaped = [...this.added.keys()].map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
    this.addedPattern = new RegExp(`(${escaped.join("|")})`);
    this.cache = new Map();
  }

  // The token that ends an assistant turn.
  get eosId() {
    return this.added.get("<|im_end|>");
  }

  // Every token that ends an answer: <|im_end|>, and the model's own end
  // tokens if the manifest lists them.
  get stopIds() {
    return [...new Set([this.eosId, ...(this.chatProfile.stop_ids ?? [])])];
  }

  encode(text) {
    const ids = [];
    // Split out added tokens first; they are never broken up by BPE.
    for (const part of text.split(this.addedPattern)) {
      if (part === "") continue;
      if (this.added.has(part)) {
        ids.push(this.added.get(part));
        continue;
      }
      let pieces = [part];
      for (const re of this.splitters) pieces = pieces.flatMap((p) => splitIsolated(p, re));
      for (const piece of pieces) {
        let chars = "";
        for (const b of utf8.encode(piece)) chars += BYTE_CHAR[b];
        for (const id of this.bpe(chars)) ids.push(id);
      }
    }
    return ids;
  }

  // Merge the lowest-ranked adjacent pair until no pair has a merge rule.
  bpe(word) {
    const hit = this.cache.get(word);
    if (hit) return hit;
    let parts = [...word];
    while (parts.length > 1) {
      let best = Infinity, pair = null;
      for (let i = 0; i + 1 < parts.length; i++) {
        const rank = this.ranks.get(parts[i] + " " + parts[i + 1]);
        if (rank !== undefined && rank < best) {
          best = rank;
          pair = [parts[i], parts[i + 1]];
        }
      }
      if (!pair) break;
      const merged = [];
      for (let i = 0; i < parts.length; i++) {
        if (i + 1 < parts.length && parts[i] === pair[0] && parts[i + 1] === pair[1]) {
          merged.push(pair[0] + pair[1]);
          i++;
        } else {
          merged.push(parts[i]);
        }
      }
      parts = merged;
    }
    const ids = parts.map((p) => {
      const id = this.vocab.get(p);
      if (id === undefined) throw new Error(`no token for ${JSON.stringify(p)}`);
      return id;
    });
    if (this.cache.size < 50000) this.cache.set(word, ids);
    return ids;
  }

  // The bytes one token stands for.
  bytes(id) {
    const token = this.tokens[id];
    if (token === undefined) throw new Error(`token id ${id} is not in the vocabulary`);
    if (this.added.has(token)) return utf8.encode(token);
    return Uint8Array.from(token, (c) => CHAR_BYTE.get(c));
  }

  decode(ids, { skipSpecial = false } = {}) {
    const d = this.streamDecoder({ skipSpecial });
    return ids.map((id) => d.push(id)).join("") + d.flush();
  }

  // Decodes one token at a time. A character split across tokens (emoji,
  // most non-Latin scripts) is held back until its last byte arrives.
  streamDecoder({ skipSpecial = true } = {}) {
    const text = new TextDecoder("utf-8");
    return {
      push: (id) => (skipSpecial && this.special.has(this.tokens[id]) ? "" : text.decode(this.bytes(id), { stream: true })),
      flush: () => text.decode(),
    };
  }

  // The chat template's text for a conversation, ending with the assistant
  // turn opened, exactly as Hugging Face's apply_chat_template renders it
  // (with thinking off, for hybrid models).
  chatText(messages) {
    const { bos, system, assistant_prefix: prefix, assistant_history_prefix: historyPrefix } = this.chatProfile;
    let out = bos;
    let first = 0;
    if (messages[0]?.role === "system") {
      out += this.turn("system", messages[0].content);
      first = 1;
    } else if (system != null) {
      out += this.turn("system", system);
    }
    for (const m of messages.slice(first)) {
      out += m.role === "assistant" ? `<|im_start|>assistant\n${historyPrefix}${m.content}<|im_end|>\n` : this.turn(m.role, m.content);
    }
    return out + "<|im_start|>assistant\n" + prefix;
  }

  turn(role, content) {
    return `<|im_start|>${role}\n${content}<|im_end|>\n`;
  }

  // The text that adds one more question to a conversation whose last token
  // is the assistant's <|im_end|>: the user turn and the opened assistant turn.
  turnText(question) {
    return "\n" + this.turn("user", question) + "<|im_start|>assistant\n" + this.chatProfile.assistant_prefix;
  }

  chat(messages) {
    return this.encode(this.chatText(messages));
  }
}
