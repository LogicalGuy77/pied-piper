// SmolLM2's tokenizer: GPT-2 style byte-level BPE, read from tokenizer.json.
// Runs in Node and in the browser. Checked against Hugging Face's ids by
// swarm/test/check.js.
//
//   const tok = new Tokenizer(JSON.parse(text))
//   tok.encode("Hello")            // [19556]
//   tok.chat([{ role: "user", content: "Hi" }])  // prompt ids, ready to generate
//   tok.decode(ids)                // text
//   const d = tok.streamDecoder(); d.push(id)    // text to show for each new token

// The GPT-2 pre-tokenizer: contractions, words, numbers, punctuation, spaces.
const PIECES = /'s|'t|'re|'ve|'m|'ll|'d| ?\p{L}+| ?\p{N}+| ?[^\s\p{L}\p{N}]+|\s+(?!\S)|\s+/gu;

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

const DEFAULT_SYSTEM = "You are a helpful AI assistant named SmolLM, trained by Hugging Face";

export class Tokenizer {
  constructor(json) {
    const model = json.model;
    if (model.type !== "BPE" || json.pre_tokenizer?.type !== "ByteLevel" || json.normalizer) {
      throw new Error("only byte-level BPE tokenizers without a normalizer are supported");
    }
    this.vocab = new Map(Object.entries(model.vocab));
    this.tokens = [];
    for (const [token, id] of this.vocab) this.tokens[id] = token;
    this.ranks = new Map();
    model.merges.forEach((m, rank) => this.ranks.set(Array.isArray(m) ? m.join(" ") : m, rank));

    this.special = new Map(json.added_tokens.map((t) => [t.content, t.id]));
    for (const [content, id] of this.special) this.tokens[id] = content;
    const escaped = [...this.special.keys()].map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
    this.specialPattern = new RegExp(`(${escaped.join("|")})`);
    this.cache = new Map();
  }

  get eosId() {
    return this.special.get("<|im_end|>");
  }

  encode(text) {
    const ids = [];
    // Split out special tokens first; they are never broken up by BPE.
    for (const part of text.split(this.specialPattern)) {
      if (part === "") continue;
      if (this.special.has(part)) {
        ids.push(this.special.get(part));
        continue;
      }
      for (const [piece] of part.matchAll(PIECES)) {
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
    if (this.special.has(token)) return utf8.encode(token);
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

  // SmolLM2's chat template, ending with the assistant turn opened.
  chatText(messages) {
    let out = "";
    if (messages[0]?.role !== "system") out += `<|im_start|>system\n${DEFAULT_SYSTEM}<|im_end|>\n`;
    for (const m of messages) out += `<|im_start|>${m.role}\n${m.content}<|im_end|>\n`;
    return out + "<|im_start|>assistant\n";
  }

  chat(messages) {
    return this.encode(this.chatText(messages));
  }
}
