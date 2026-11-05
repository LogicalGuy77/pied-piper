"""Reference stage engine in NumPy. A stage runs a contiguous range of layers.

Every engine we build later (JS, WASM, phone) implements this same contract:

    stage = Stage(weights_dir, start, end)       # serves layers [start, end)
    out = stage.forward(session_id, x, pos)
    stage.drop(session_id)

    x    int token ids, shape [n]          if stage.has_embedding (start == 0)
         float32 hidden state h, [n, d]    otherwise
    pos  position of x[0] in the session. Must equal the number of tokens this
         stage has already seen for that session.
    out  float32 logits, [n, vocab]        if stage.has_output (end == num_layers)
         float32 hidden state h, [n, d]    otherwise

Each stage keeps its own KV cache per session, for its own layers only. The
math follows Hugging Face's Llama implementation, including its RoPE
convention (rotate_half pairs dimension i with i + head_dim/2).
"""

import json
from pathlib import Path

import numpy as np


def load_manifest(weights_dir):
    return json.loads((Path(weights_dir) / "manifest.json").read_text())


def read_file(weights_dir, entry):
    """Load one exported .bin file and return {tensor name: float32 array}.

    int8 tensors are dequantized here (q * scale per row, in float32), so the
    rest of the engine only ever sees float32.
    """
    raw = np.fromfile(Path(weights_dir) / entry["file"], dtype=np.uint8)
    if raw.nbytes != entry["bytes"]:
        raise ValueError(f"{entry['file']}: expected {entry['bytes']} bytes, found {raw.nbytes}")
    tensors = {}
    for t in entry["tensors"]:
        count = int(np.prod(t["shape"]))
        if t.get("dtype", "float32") == "int8":
            q = raw[t["offset"]:t["offset"] + count].view(np.int8).reshape(t["shape"])
            rows = t["shape"][0]
            scale = raw[t["scale_offset"]:t["scale_offset"] + rows * 4].view("<f4")
            tensors[t["name"]] = q.astype(np.float32) * scale[:, None]
        else:
            tensors[t["name"]] = raw[t["offset"]:t["offset"] + count * 4].view("<f4").reshape(t["shape"])
    return tensors


def rms_norm(x, weight, eps):
    return x * (1.0 / np.sqrt(np.mean(x * x, axis=-1, keepdims=True) + eps)) * weight


def silu(x):
    with np.errstate(over="ignore"):  # exp overflows to inf for very negative x; x / inf = 0 is correct
        return x / (1.0 + np.exp(-x))


def softmax(x):
    e = np.exp(x - x.max(axis=-1, keepdims=True))
    return e / e.sum(axis=-1, keepdims=True)


def rotate_half(x):
    half = x.shape[-1] // 2
    return np.concatenate([-x[..., half:], x[..., :half]], axis=-1)


class Stage:
    def __init__(self, weights_dir, start, end):
        manifest = load_manifest(weights_dir)
        c = manifest["config"]
        n_layers = c["num_layers"]
        if not 0 <= start < end <= n_layers:
            raise ValueError(f"layer range [{start}, {end}) is outside 0..{n_layers}")

        self.start, self.end = start, end
        self.has_embedding = start == 0
        self.has_output = end == n_layers
        self.d = c["hidden_size"]
        self.n_heads = c["num_heads"]
        self.n_kv_heads = c["num_kv_heads"]
        self.head_dim = c["head_dim"]
        self.eps = c["rms_norm_eps"]

        self.layers = [read_file(weights_dir, manifest["layers"][i]) for i in range(start, end)]
        tied = manifest["lm_head"] is None
        if self.has_embedding or (self.has_output and tied):
            self.embed = read_file(weights_dir, manifest["embed"])["embed_tokens"]
        if self.has_output:
            self.final_norm = read_file(weights_dir, manifest["final_norm"])["norm"]
            self.lm_head = self.embed if tied else read_file(weights_dir, manifest["lm_head"])["lm_head"]

        half = np.arange(0, self.head_dim, 2, dtype=np.float32) / self.head_dim
        self.inv_freq = (1.0 / (np.float32(c["rope_theta"]) ** half)).astype(np.float32)

        self._kv = {}    # session id -> per layer [K, V], each [tokens, n_kv_heads, head_dim]
        self._seen = {}  # session id -> tokens processed so far

    @property
    def sessions(self):
        return list(self._seen)

    @property
    def weight_bytes(self):
        arrays = [a for layer in self.layers for a in layer.values()]
        for name in ("embed", "final_norm", "lm_head"):
            a = getattr(self, name, None)
            if a is not None and not any(a is b for b in arrays):
                arrays.append(a)
        return sum(a.nbytes for a in arrays)

    def describe(self):
        parts = ["embedding"] if self.has_embedding else []
        last = self.end - 1
        parts.append(f"layers {self.start}–{last}" if last > self.start else f"layer {self.start}")
        if self.has_output:
            parts.append("output")
        return " + ".join(parts)

    def drop(self, session_id):
        self._kv.pop(session_id, None)
        self._seen.pop(session_id, None)

    def forward(self, session_id, x, pos, trace=None):
        """Run this stage's layers on n new tokens of one session.

        If `trace` is a list, the hidden state after the embedding (first stage
        only) and after every layer is appended to it. Used for test vectors.
        """
        seen = self._seen.get(session_id, 0)
        if pos != seen:
            raise ValueError(f"session {session_id!r}: this stage has seen {seen} tokens, got pos {pos}")

        if self.has_embedding:
            h = self.embed[np.asarray(x, dtype=np.int64)]
            if trace is not None:
                trace.append(h)
        else:
            h = np.asarray(x, dtype=np.float32)
        if h.ndim != 2 or h.shape[1] != self.d:
            raise ValueError(f"expected input of shape [n, {self.d}], got {list(h.shape)}")

        n = h.shape[0]
        cos, sin = self._rope(pos, n)
        cache = self._kv.setdefault(session_id, [[None, None] for _ in self.layers])
        for weights, kv in zip(self.layers, cache):
            h = self._layer(weights, kv, h, cos, sin, pos)
            if trace is not None:
                trace.append(h)
        self._seen[session_id] = pos + n

        if not self.has_output:
            return h
        return rms_norm(h, self.final_norm, self.eps) @ self.lm_head.T

    def _rope(self, pos, n):
        positions = np.arange(pos, pos + n, dtype=np.float32)
        freqs = np.outer(positions, self.inv_freq)             # [n, head_dim/2]
        angles = np.concatenate([freqs, freqs], axis=-1)       # [n, head_dim]
        return np.cos(angles)[:, None, :], np.sin(angles)[:, None, :]  # broadcast over heads

    def _layer(self, w, kv, h, cos, sin, pos):
        n = h.shape[0]
        H, KVH, hd = self.n_heads, self.n_kv_heads, self.head_dim

        # Attention
        x = rms_norm(h, w["input_layernorm"], self.eps)
        q = (x @ w["q_proj"].T).reshape(n, H, hd)
        k = (x @ w["k_proj"].T).reshape(n, KVH, hd)
        v = (x @ w["v_proj"].T).reshape(n, KVH, hd)
        q = q * cos + rotate_half(q) * sin
        k = k * cos + rotate_half(k) * sin

        kv[0] = k if kv[0] is None else np.concatenate([kv[0], k])
        kv[1] = v if kv[1] is None else np.concatenate([kv[1], v])
        K, V = kv
        total = K.shape[0]

        # Query i sits at absolute position pos + i and may only see keys at or before it.
        future = np.arange(total)[None, :] > (pos + np.arange(n))[:, None]  # [n, total]
        scale = 1.0 / np.sqrt(hd)
        group = H // KVH  # query heads per KV head
        out = np.empty((n, H, hd), dtype=np.float32)
        for head in range(H):
            kvh = head // group
            scores = (q[:, head, :] @ K[:, kvh, :].T) * scale  # [n, total]
            scores[future] = -np.inf
            out[:, head, :] = softmax(scores) @ V[:, kvh, :]
        h = h + out.reshape(n, H * hd) @ w["o_proj"].T

        # MLP
        x = rms_norm(h, w["post_attention_layernorm"], self.eps)
        h = h + (silu(x @ w["gate_proj"].T) * (x @ w["up_proj"].T)) @ w["down_proj"].T
        return h
