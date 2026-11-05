"""Simulated swarm: a chain of stages in one process.

Between stages the hidden state is turned into raw little-endian float32
bytes and back, which is exactly the payload a WebSocket frame will carry
between phones in step 3.
"""

import time

import numpy as np

from stage import Stage


class Pipeline:
    def __init__(self, weights_dir, boundaries):
        """boundaries like [0, 8, 22, 30] give stages [0, 8), [8, 22), [22, 30)."""
        self.boundaries = list(boundaries)
        self.stages = [Stage(weights_dir, a, b) for a, b in zip(boundaries, boundaries[1:])]
        if not self.stages[0].has_embedding or not self.stages[-1].has_output:
            raise ValueError(f"boundaries {boundaries} must start at 0 and end at the last layer")
        self.seconds = [0.0] * len(self.stages)  # compute time spent in each stage
        self.wire_bytes = 0                      # bytes sent between stages

    def forward(self, session_id, token_ids, pos):
        x = token_ids
        for i, stage in enumerate(self.stages):
            t0 = time.perf_counter()
            out = stage.forward(session_id, x, pos)
            self.seconds[i] += time.perf_counter() - t0
            if stage.has_output:
                return out
            wire = out.astype("<f4").tobytes()
            self.wire_bytes += len(wire)
            x = np.frombuffer(wire, dtype="<f4").reshape(-1, stage.d)

    def drop(self, session_id):
        for stage in self.stages:
            stage.drop(session_id)


def generate_stream(pipe, session_id, prompt_ids, max_new_tokens, stop_ids=(), prefill="batch"):
    """Greedy decoding. Yields (token_id, logits) for each new token.

    prefill="batch" sends the whole prompt through in one pass.
    prefill="one_by_one" feeds the prompt one token at a time.
    """
    if prefill == "batch":
        logits = pipe.forward(session_id, prompt_ids, 0)
    elif prefill == "one_by_one":
        for i, token in enumerate(prompt_ids):
            logits = pipe.forward(session_id, [token], i)
    else:
        raise ValueError(f"unknown prefill mode {prefill!r}")

    pos = len(prompt_ids)
    for i in range(max_new_tokens):
        token = int(np.argmax(logits[-1]))
        yield token, logits[-1]
        if token in stop_ids or i == max_new_tokens - 1:
            return
        logits = pipe.forward(session_id, [token], pos)
        pos += 1


def generate(pipe, session_id, prompt_ids, max_new_tokens, stop_ids=(), prefill="batch"):
    """Greedy decoding. Returns (token ids, logits row for each token)."""
    steps = list(generate_stream(pipe, session_id, prompt_ids, max_new_tokens, stop_ids, prefill))
    return [t for t, _ in steps], [row for _, row in steps]
