# Plan: Phone Swarm Inference

## The idea

Every phone on our Wi-Fi lends compute and can use it, like a torrent. No
single phone can hold the model, so we cut it into blocks of layers. Each
phone holds one block, and every question travels through one holder of each
block. A laptop coordinates.

We want to show, at a hackathon, a room full of phones answering questions
together that none of them could answer alone, with the answer exactly equal
to the real model's.

## Constraints

- **Phones are browser tabs.** No app install. Joining is scanning a QR code.
- **Memory budget: 300 MB per phone.** That is what we think one browser tab
  can safely use before the browser kills it.
- **Phones leave.** Screens lock, batteries die, people walk away. A question
  must survive a phone leaving mid-answer.
- **Wi-Fi is slow and lossy.** Every hop costs time, so we want few hops and
  small messages.
- **Exact answers.** Splitting the model across phones must not change a
  single token. If it does, we can't tell a bug from a rounding difference.

## Model

SmolLM2-135M-Instruct. Small enough to run on a phone CPU, big enough that it
doesn't fit in one tab, and it's a real chat model.

| | |
|---|---|
| Layers | 30 |
| Hidden size | 576 |
| Attention | 9 query heads, 3 KV heads, head size 64 |
| MLP | 576 → 1536 → 576 |
| Vocabulary | 49,152 |
| One layer | 14.2 MB (float32) |
| Embedding table | 113.2 MB, reused as the output layer |
| Whole model | 538 MB (float32) |

## The split

Three blocks. Fewer blocks means fewer hops; three is the fewest that fits the
budget. The embedding table is needed at both ends (embedding lookup in
block 1, output layer in block 3), so those blocks get fewer layers.

| Block | Holds | Weights |
|---|---|---|
| 1 | embedding + layers 0–7 | 226.5 MB |
| 2 | layers 8–21 | 198.2 MB |
| 3 | layers 22–29 + final norm + output | 226.5 MB |

Each phone also keeps a KV cache per active session: 2 × 3 heads × 64 × 4
bytes = 1.5 KB per token per layer. A 1,000-token chat on block 2 is about
21 MB. That leaves room under 300 MB for a few sessions at once.

Between blocks, only h moves: 576 float32 numbers per token, about 2.3 KB.
Weights and KV caches never leave their phone.

Float32 first, because it's easiest to check against Hugging Face. Int8 later
cuts weights to a quarter.

## Architecture

**Tracker (laptop).** Serves the page, the code and the weights. Keeps the
block map: which phone holds which block and whether it's ready. Assigns each
new phone the block with the fewest holders. Picks routes. Relays every hop
over WebSocket in v1 (star topology). Watches heartbeats. Later, keeps
credits.

**Phone (browser tab).** Two jobs at once:

- *Serving:* load its block in a Web Worker, run frames for anyone who asks,
  keep a KV cache per session.
- *Asking:* a chat box and a tokenizer (about 2 MB). Asking needs no model
  download. Questions leave as token ids and answers come back as token ids.

**Route.** When a phone asks, the tracker picks the least-busy ready holder
of each block. The route stays fixed for the whole answer, because each phone
on it holds that session's KV cache.

**One token.** The first pass sends the whole prompt as one prefill. After
that, only the new token travels:

```
asker → block 1 (embed + layers 0–7) → block 2 (8–21) → block 3 (22–29 + output) → asker
```

Phones don't need to know the route. A phone runs its block and sends the
result with `hop + 1`; the tracker forwards it to the next holder.

## Wire format

Control messages are small JSON (`hello`, `welcome`, `ready`, `ask`,
`session`, `end`, `drop`, `error`, ...).

Data messages are binary: a fixed little-endian header, then raw bytes.

| Field | Meaning |
|---|---|
| kind | TOKENS, HIDDEN, or NEXT |
| hop | index of the receiver in the route |
| attempt | bumped on reroute, so stale frames can be ignored |
| session | from the tracker |
| pos | position of the first token |
| n | number of tokens |
| payload | int32 token ids, or float32 h (n × 576) |

Our own thin protocol, no libp2p. On one Wi-Fi with a tracker, libp2p's
discovery and NAT traversal buy nothing. Everything goes behind one transport
interface so we can swap in WebRTC later.

## When a phone leaves

The tracker pings every phone each second and drops one that goes silent.
We can't rely on the socket closing: a locked phone may keep it open and just
stop answering.

If a phone on a route leaves mid-answer, the tracker picks another holder of
the same block and tells the asker. The asker replays the conversation so far
as one prefill through the new route, so the new phones rebuild their KV
caches, and the answer continues where it was. This needs at least two
holders per block.

Open question: a phone doing a long prefill may also look silent. The serving
loop must keep answering pings while it computes, or the tracker needs a
longer timeout for phones that owe a reply.

## Credits

One credit pays for running one layer on one token. A generated token costs
the asker 38 credits, paid to the phones that did the work:

**block 1: 8 + block 2: 14 + block 3: 16 = 38 credits per token**

Block 3 earns 16 because the output layer costs about as much as 8 layers.
New phones start with a small balance so they can ask right away. The tracker
keeps balances in v1; on-chain later (the ETHGlobal piece).

## Build order

Each step has to pass its checks before the next one starts. Every later
step is checked against the one before it, so a wrong answer always points at
the newest code.

### 1. Python reference

A from-scratch NumPy version of the model that runs as a chain of stages,
each serving a range of layers. This is the ground truth for everything after.

- Export Hugging Face weights to raw float32 files: one per layer, one for the
  embedding, one for the final norm, plus a manifest with shapes, offsets and
  hashes. This is the format phones will download.
- `Stage(weights, start, end).forward(session_id, x, pos)`.
- A simulated pipeline that passes h between stages as raw bytes.

Checks:

- Exported tensors equal Hugging Face's, bit for bit.
- h after every layer matches Hugging Face.
- Greedy tokens equal Hugging Face's `generate()`.
- Logits match at every decode step (catches RoPE position bugs that prompt
  checks miss).
- Every split, down to one layer per stage, gives bit-identical logits to the
  unsplit model.
- Prompt in one pass equals one token at a time.
- Interleaved sessions equal each session run alone.
- Write test vectors (h at every layer, logits, expected tokens) for step 2.

### 2. JS engine in Node

Port the stage to plain JavaScript with no dependencies, so the same file
runs in Node and in a browser Web Worker. Keep the math in one kernels file
so it can be swapped for WASM later.

Checks: match step 1's test vectors within a small tolerance, greedy tokens
through the 3-block split equal Hugging Face's, and every split is
bit-identical. Plant known bugs (wrong KV head mapping, wrong RoPE pairing, a
KV cache that forgets) and confirm the checks catch them.

### 3. Swarm in browser tabs

The tracker, routes, sessions, wire format, a browser tokenizer and the
phone page, with several tabs on one laptop standing in for phones.

Checks:

- The browser tokenizer gives Hugging Face's ids on tricky strings (emoji,
  non-Latin scripts, code, special tokens) and the chat template.
- Frames survive encode/decode bit for bit.
- Six phones split two per block.
- The answer through the swarm equals Hugging Face's, token for token.
- Every h on the wire is bit-identical to step 2's in-process run.
- Two askers at once get disjoint routes and correct answers.
- A phone leaving mid-answer: rerouted, answer still correct.
- The last holder of a block leaving: a clear error, not a hang.
- Sessions end and every phone frees its KV caches.

### 3.5. Mock phones as containers

Before real phones, make the network real. Each phone is a Docker container
running headless Chromium with the real page; the tracker is another
container serving HTTPS. Use `tc netem` to add Wi-Fi delay and loss.

Scenarios: phones join and split evenly, one answer over a lossy network,
two askers at once, a phone freezing (`docker pause`, like a locked screen),
a phone dying (`docker kill`), a page reload, all phones on half a CPU.
Measure per-phone memory against the 300 MB budget.

### 4. Real phones

- HTTPS, because phones need a secure context: a Cloudflare tunnel, or a
  self-signed certificate on the LAN.
- Screen wake lock while the page is visible.
- Cache the block's weights in the browser so a reload doesn't redownload.
- Keep phones reachable while they compute: yield between layers so the
  socket and heartbeat keep working.
- Faster kernels: WASM SIMD, then int8 weights.

### 5. Credits, recovery, dashboard

- Credit balances on the tracker.
- Rerouting when a phone leaves (built in step 3, hardened here).
- Rebalancing: move phones to a block that has lost its holders.
- A dashboard on the laptop for the demo: QR code to join, every phone under
  its block, questions in flight, the tracker's log. A management view for
  throughput and utilization per block and per phone.

## After the MVP

- Phones send h to each other directly over WebRTC data channels, with the
  tracker doing signaling. That halves the trips per token.
- Revisit libp2p only if the swarm goes over the internet without a tracker.
- Catch bad results by re-running a random step on a second phone and
  comparing hashes. Needs WASM kernels that give identical results on every
  phone.
- Credits on-chain.
- Torrent-style weight sharing: a new phone downloads its block from phones
  that already have it, instead of from the laptop.

## Risks

| Risk | What we'll do |
|---|---|
| A tab uses much more memory than its weights | Measure in step 3.5 and on real phones; int8 if needed |
| Phone browsers freeze background tabs | Wake lock; treat it as a phone leaving and reroute |
| Venue Wi-Fi blocks devices from reaching each other | Tunnel through the laptop, or use the laptop's hotspot |
| Phones download 200 MB each through the laptop's uplink | Cache in the browser; later, share blocks between phones |
| Plain JS is too slow on phones | WASM SIMD and int8 in step 4 |
| Long chats get slow to start, because every question replays the whole conversation | A New chat button first; keep KV caches across turns later |
| Different browsers round `exp`/`sin`/`cos` differently | Fine for correctness; WASM kernels before hash-based verification |
