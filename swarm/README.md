# Step 3: Swarm in browser tabs

The laptop runs a tracker. Each browser tab is a phone: it gets a block from
the tracker, downloads only that block's weights, serves it for everyone, and
can ask questions itself. Every hop goes through the tracker over WebSocket
(star topology).

## Run

Needs Node 22+ and the outputs of step 1 (`weights/` and `testvectors/`):

```sh
.venv/bin/python reference/tokenizer_vectors.py   # once: tokenizer ids for the checks
cd swarm && npm install
npm run check          # 45 checks on SmolLM2-135M, under a minute
npm run check:big      # the same on MiniCPM5-2B int8 (needs its export and test vectors, see the top-level README)
npm run start:small    # SmolLM2-135M, 3 blocks: tracker on http://localhost:8080
npm start              # MiniCPM5-2B int8, 6 blocks (315–472 MB per phone)
npm run start:3phones  # MiniCPM5-2B int8, 3 blocks (650–950 MB per phone)
```

The tracker itself is `node tracker.js [--weights DIR] [--min-blocks 3]
[--min-replica 2] ...`; the npm scripts only pick the weights and the cut,
and pass any other flag through (`npm start -- --port 8443 ...`).

Then open `http://localhost:8080` in as many tabs as there are blocks. The
first tabs get one block each; with `--min-replica 1`, the next tab splits
the largest block. Ask a question in any tab. The answer to "Explain in
two sentences why the sky is blue." should start with the same text as
`reference/chat.py`.

On the laptop, `/dashboard` is the demo screen: a QR code for joining, every
phone under its block, the questions in flight and the tracker's log.
`/manage` shows throughput and utilization for the swarm, each block and
each phone.

### Real phones

Phones need an `https://` page. Two ways that work:

- **Cloudflare quick tunnel**, any network, a real certificate:
  ```sh
  cloudflared tunnel --url https://localhost:8443 --no-tls-verify   # prints https://….trycloudflare.com
  npm start -- --port 8443 --tls-cert ../certs/lan.crt --tls-key ../certs/lan.key \
    --public-url https://….trycloudflare.com                        # or start:small, start:3phones
  ```
  The laptop needs a fast uplink: each phone downloads its block through it
  once (200 MB for the small model, 300–950 MB for the big one). Over venue
  Wi-Fi (0.6 MB/s) 200 MB took half an hour; over Ethernet, 20 seconds. The
  address changes every time cloudflared restarts.
- **Same network**, faster: a self-signed certificate for the laptop's IP
  (`openssl req -x509 … -addext "subjectAltName=IP:<laptop IP>"`), accepted
  once on each phone. Phone hotspots and venue Wi-Fi often block devices
  from reaching each other; the laptop's own hotspot works. Under WSL, the
  port also needs forwarding from Windows
  (`netsh interface portproxy add v4tov4 listenport=8443 connectaddress=<WSL IP> connectport=8443`).

## What the checks prove

The checks start the real tracker and run up to nine phones in one Node process.
The phones fetch weights over HTTP and talk only through the tracker's
WebSocket, the same path a tab uses.

| Check | Result on this laptop |
|---|---|
| Tokenizer gives Hugging Face's ids on 25 tricky strings and 3 chats, and decodes back | yes, including emoji, Hindi, Chinese, code and special tokens |
| Frames survive encode/decode bit for bit | yes, 2,320 bytes per hop per new token |
| Where phones go, by the rules alone (`src/blocks.js`) | first cut 0, 8, 23, 30; a path at 3 phones, 2 per block at 6, the 7th on block 2, the 8th splits it into 8–14 and 15–22; with `min-replica` 1 the 4th splits; 6 repair cases |
| Asking before every block has a holder | clear "waiting for block 2" error |
| Six phones split two per block | A,D · B,E · C,F |
| **Greedy answer through the swarm equals Hugging Face's** | 40 of 40 |
| Every h sent between phones is bit-identical to step 2's in-process run | 80 of 80 frames |
| Two askers at once get disjoint routes and their solo answers | A → B → C and D → E → F |
| **Speed-aware routing**: B made 150 ms slower per frame | measured at 109 ms per token against E's 21; the next three questions all go through E, two of them at once |
| **A follow-up question** in the same conversation | same session, 15 tokens sent instead of 59, answer equals a fresh run on the whole conversation |
| A phone on the conversation's route leaves between questions | the next question replays the conversation (81 tokens) through another phone and is still right |
| New chat | the session ends and every phone frees its KV cache |
| **A phone leaving mid-answer** | rerouted to A → E → C; all 30 tokens still equal Hugging Face's |
| The last holder of a block leaving mid-answer | a phone from block 1 moves in, loads block 2, and the answer is still right |
| Sessions end | every phone has freed every KV cache |
| A phone silent for 12 s while it owes a reply | kept, and its answer is right |
| The same phone silent while idle | dropped after the 8 s heartbeat timeout |
| **Rebalancing live**, from one phone per block | 3 more fill every block to 2; the 7th joins block 2; the 8th splits it in the middle of a 30-token answer: D,J take 8–14, L and the new M take 15–22, the route grows to four hops, and all 30 tokens still equal Hugging Face's |
| A block falling below `min-replica` while another has a spare | the spare moves there, and the next answer is right |
| What phones get | a 312-byte summary for four blocks, only when it changes |
| What the dashboard gets | every phone's ping and time per token, throughput, a log line per answer, a QR code |

Planted bugs that the checks catch: routing that ignores load, the tracker
forgetting to tell phones to drop a session, and a tokenizer without the
contraction rule (`'s`, `'ll`, …).

A headless Chromium run also passed: four tabs joined, and the asking tab got
the reference answer through A → B → C.

## How it fits together

| File | Role |
|---|---|
| `tracker.js` | HTTP for the pages, code, weights and `/qr.svg`; WebSocket at `/ws` for the swarm and the dashboards |
| `src/protocol.js` | Binary frame format |
| `src/peer.js` | One phone: join, load its block, serve frames, ask. Same code in Node and in the browser |
| `src/blocks.js` | Where phones go: the first cut, joins, splits and repairs, as pure functions |
| `src/tokenizer.js` | Byte-level BPE and the chat template, no dependencies |
| `src/arkiv.js` | Saves conversations and metrics to Arkiv (tracker only) |
| `src/rewards.js`, `src/wallet-auth.js` | Earnings ledger, payouts and withdrawals; linking a phone to its wallet (tracker only) |
| `chain/` | The PIPER USDC (pUSDC) token contract and its deploy script |
| `wallet/` | The phone's wallet card (React, Privy), built to `web/dist/` |
| `web/` | The phone: `index.html` and `app.js` for the UI, `worker.js` runs it in a Web Worker and caches its weights |
| `web/dashboard.*`, `web/manage.*` | The laptop's demo screen and management view |
| `web/arkiv.*` | The database peek, on the phone page and at `/arkiv` |
| `test/check.js`, `test/wallet-check.js` | The checks |

**Joining.** A tab says hello. The tracker gives it a block, and the tab
downloads that block's weights from `/weights/`. When loaded, it tells the
tracker it is ready. Only ready phones get routed to.

**Rebalancing.** At start the tracker cuts the layers into `--min-blocks`
blocks of balanced memory (0, 8, 23, 30 for 3). A joining phone goes to a
block nobody holds, else to a block below `--min-replica` phones, else to the
block with the most compute (the output layer counts as 8 layers). The phone
that brings that block to 2 × `min-replica` splits it at its compute
midpoint: its `min-replica` earliest phones take the first half, the rest and
the new phone the second. A phone that leaves is replaced from inside the
swarm: a block nobody holds takes a phone from the block with the most, and a
block below `min-replica` takes one from a block above it. Split blocks stay
split.

A moved phone gets `assign`, drops its old block and loads the new one, from
its weight cache when it has those layers, as after a split. Answers through
it are rerouted under a new attempt and wait until every block has a ready
phone, then replay. A split reroutes every session, since every route went
through the old block. Rebalancing reroutes don't count towards the limit of
5 per answer, and a session waiting more than 60 s for its phones fails.

**Asking.** The asker asks the tracker for a session. For each block the
tracker picks the ready holder that should deliver tokens soonest: its
measured time per token (compute plus network, from the frames it has
answered) times one plus the answers it is already generating. A phone not
measured yet counts as its block's median. So a slow phone is passed over,
and a fast one takes a second answer before a slow one takes its first. The
route stays fixed for the whole conversation because each phone on it keeps
the session's KV cache. Then, for every token:

```
asker ──TOKENS hop 0──▶ tracker ──▶ block 1 ──HIDDEN hop 1──▶ tracker ──▶ block 2
      ──HIDDEN hop 2──▶ tracker ──▶ block 3 ──NEXT hop 3──▶ tracker ──▶ asker
```

The first pass sends the whole prompt; after that only the one new token. A
phone never needs to know the route: it runs its block and sends the result
with `hop + 1`, and the tracker forwards it to `route[hop]`, or to the asker
after the last block. The tracker only forwards a frame from the phone that
should be sending that hop.

**Serving.** Frames for a phone wait in a queue and run one at a time. The
phone pauses after every layer (`Stage.forwardAsync`), so it keeps reading
its socket while it computes. On real phones, three questions arriving at
once used to hold the phone long enough that Chrome stopped reading the
socket, missed the tracker's pings, and the phone was dropped.

**Heartbeat.** The tracker pings every phone each second. A phone that sends
nothing for 5 s, not even a pong, is dropped (`--heartbeat-timeout`). A
locked phone keeps its connection open, so waiting for a close event alone
would hang the asker forever. A phone that owes a reply gets 20 s instead
(`--busy-timeout`): a long prefill is not a phone gone. The cost is that a
phone freezing mid-computation takes up to 20 s to drop. It is visible
before that: once a ready phone has been quiet past the heartbeat timeout,
its block turns red on the dashboard ("not answering for N s: dropped at
20 s unless it replies") and on every phone page, and the phones' summary
counts it as not answering.

**Staying awake.** The page holds a screen wake lock while it is visible and
takes it again when the phone comes back to it. A phone that switches apps
is still frozen by the browser and dropped.

**Weight cache.** The worker keeps the block's weights in the Cache API,
under a version the tracker computes from the weight files' sizes and
dates. A reload or a rejoin reads them from disk: 1 s instead of a download.
It needs an `https://` page; Chrome allows it with an accepted self-signed
certificate too.

**Rerouting.** If a phone on the route leaves mid-answer, the tracker picks
another ready holder of its block, bumps the session's attempt and sends the
asker `reroute`. Every phone on the route drops the old attempt's KV cache;
the asker replays the prompt and every token so far as one prefill under the
new attempt, and keeps waiting for the same next token. Frames from the old
attempt are ignored, by the tracker and by the phones. If no other phone has
the block ready, or the session was rerouted 5 times, the asker gets an error.

**Measuring.** The tracker times each phone's pong (ping), and each frame
from forwarding it to a phone until the phone's answer comes back (hop time:
compute plus network). Phones report only what the tracker can't see:
compute time, battery, whether the page is in the background, wake lock and
the device. Every finished answer gets a log line with its speed per hop:

```
session 1 done: 40 tokens, first token 5.0 s, then 165 ms per token · per hop A 35 ms, B 61 ms, C 69 ms
```

**What goes where.** Phones get a small summary (holders per block, phones,
questions in flight), only when it changes. The dashboards send `watch` and
get the full state every second. Sending every phone the full phone list on
every token, as before, grows with the square of the number of phones.

**HTTPS.** `--tls-cert FILE --tls-key FILE` serves HTTPS and WSS, which phones
on the LAN need. [docker/](../docker/README.md) uses it with a self-signed
certificate. `--public-url` is the address the dashboard's QR code shows.

**Conversations.** A session is a whole conversation, not one answer. When
an answer ends (`<|im_end|>` or the token limit), the page's asker sends
`turn` instead of `end`: the session goes idle and every phone on its route
keeps its KV cache. The worker builds the next question by appending to the
conversation's token ids, with each answer exactly as generated rather than
re-tokenized from its text, so the new prompt starts with everything the
route has already seen. `peer.ask` checks that, asks the tracker to continue
the session, and sends only the new tokens: a follow-up costs its own length,
not the conversation's. In the browser, "And of Germany?" after "What is the
capital of France?" sent 15 of its 59 prompt tokens.

If a phone on the route leaves while the conversation is idle, the tracker
reroutes it as usual, and the next question replays the whole conversation
through the new route. If the tracker has ended the session meanwhile, the
asker starts a new one and replays it too.

**Ending.** New chat sends `end`, and the tracker tells every phone on the
route to drop the session's KV cache. So does a conversation idle for 10
minutes (`--session-idle`). Askers that don't keep the conversation (the
checks, mostly) end the session after each answer.

## Open database on Arkiv

Every finished answer is saved to [Arkiv](https://docs.arkiv.network/)'s
Rabdi testnet, where anyone can read it. To turn it on, put a testnet
private key in `swarm/.env` (see `.env.example`), fund its address with tGLM
at the [faucet](https://hub.arkiv.network/faucet), and restart the tracker:

```sh
ARKIV_PRIVATE_KEY=…     # the saver wallet (64 hex digits, 0x optional): pays for and owns every entity
ARKIV_ACCESS_KEY=       # optional, lifts the public RPC's rate limit
```

Without a key the swarm runs as before and answers say "Arkiv is off".

**What is saved.** One chat is one entity under the schema
`pied-piper.conversation.v1`: the messages so far, and one metrics entry per
answer (prompt and answer tokens, how many prompt tokens the route had
cached, first token time, ms per token, tokens per
second, the route, time per hop, reroutes, how it finished). The first answer
of a chat creates the entity; each later answer patches it and pushes its
expiry a day out, in one transaction. An entity expires a day after its last
write. New chat starts a new entity.

**How.** When `Peer.ask` sees the stop token (or the token limit), it sends
`record` with the chat to the tracker, before the session goes idle. The tracker
adds its own measurements of the session and writes the entity
(`src/arkiv.js`); the private key never leaves the laptop. The asker gets
`recorded` back, with the entity and transaction links, shown under the
answer. Only the asker of a session can record it, once per answer that
produced tokens.

**Peeking.** "Peek at the database" on the phone page, and `/arkiv` on the
laptop, list the tracker's latest add and update transactions with explorer
links, and the conversations read back from Arkiv itself, so an update shows
up as a new block height, one more turn and a "just updated" mark.

## Earnings in PIPER USDC

Every phone gets a wallet without signing up, and earns PIPER USDC (pUSDC),
an ERC-20 on Unichain Sepolia meant to track USDC one to one, for the compute
it lends. It has USDC's 6 decimals.

The token itself doesn't hold the peg: a pUSDC is worth a dollar only while
it can be turned into one. Today nothing backs it; see "Not yet".

**Setup, once.**

1. Build the wallet card: `cd swarm && npm run build` (to `web/dist/`).
2. Create an app at [dashboard.privy.io](https://dashboard.privy.io). Turn on
   guest accounts, email and SMS login, and add the phone page's origin (your
   tunnel's `https://` URL; quick-tunnel URLs change on every restart) to the
   allowed domains. Put its ID in `swarm/.env` as `PRIVY_APP_ID`. Without it,
   each browser keeps its own key in localStorage instead.
3. Put a Unichain Sepolia key with a little ETH in `swarm/.env` as
   `TREASURY_PRIVATE_KEY`, then deploy: `node swarm/chain/deploy.js`. It mints
   the supply (a million by default, `--supply`) to the treasury and writes
   the address to `chain/deployment.json`, where the tracker finds it.

Without the treasury key, earnings are still counted, and paid once it is set.

**Wallets.** With Privy, the first visit creates a guest account and its
embedded wallet, with no questions asked; it stays on that device for 30
days, and "Sign in with email or phone" makes it permanent with the same
wallet. The page signs the tracker's per-connection challenge with it
without a prompt (`src/wallet-auth.js`), so the tracker knows where the
phone's earnings go and nobody can claim another phone's.

**Earning.** A phone earns `--reward` pUSDC (0.000001, a millionth of a
dollar) per layer-token: each token it runs through its block, times the
block's layer-equivalents (`costModel` in `src/blocks.js`, so the block with
the output projection counts it). A 256-token answer from SmolLM2 is about
10,000 layer-tokens, so about a cent, shared by the phones on its route.
Fractions of pUSDC's smallest unit carry over to the next credit, so nothing
is lost to rounding. What a phone earns before its wallet is linked is kept
and added when it links. The ledger is `swarm/data/rewards.json`
(`--ledger`), in pUSDC's base units.

**Payouts.** Every `--payout-every` ms (a minute), the treasury pays every
wallet with at least `--payout-min` (0.01) pending in one `transferMany`
transaction (`src/rewards.js`). The transaction is written to the ledger
before it is waited on; a round left unsettled by a crash is settled from its
receipt on restart, so nothing is paid twice.

**Withdrawing.** The phone's wallet holds pUSDC but no ETH. It signs an
ERC-3009 `TransferWithAuthorization` naming the destination and amount
(Privy shows what is being signed), and the tracker submits it and pays the
gas. The signature binds the recipient, so the tracker can't redirect it, and
each one works once. pUSDC also has EIP-2612 `permit`, for the Uniswap pool
later.

`node test/wallet-check.js [RPC]` checks all of this; with an RPC whose chain
id is 1301 (a local Hardhat node with `chainId: 1301`), it deploys, pays out,
withdraws and runs a tracker with three phones.

## Wire format

Control messages are small JSON: `hello`, `welcome`, `assign`, `ready`, `ask`,
`session`, `turn`, `reroute`, `end`, `drop`, `fail`, `error`, `stats`, `swarm`,
`record`/`recorded` for Arkiv, and
`watch`/`state` for the dashboards.

Data messages are binary, a 16-byte little-endian header and a raw payload:

| Bytes | Field | |
|---|---|---|
| 0 | kind | 1 TOKENS, 2 HIDDEN, 3 NEXT |
| 1 | hop | index of the receiver in the route |
| 2–3 | attempt | bumped on each reroute; older attempts are ignored |
| 4–7 | session | from the tracker |
| 8–11 | pos | position of the first token |
| 12–15 | n | number of tokens |
| 16– | payload | int32 token ids, or float32 h (n × 576) |

## Speed

On this laptop, with the WASM SIMD kernels: about 0.4 s for the first token
of a 40-token prompt, then about 32 ms per token (4.8 s and 165 ms with the
plain JS kernels). That is step 2's compute plus a few ms of relay over
localhost. Three tabs of one browser: 54 ms per token. Phones on Wi-Fi are
slower; each phone's page says which kernels it runs.

## Not yet

- Merging split blocks back when phones leave, and moving phones by measured
  speed rather than layer counts. A split pauses answers for a moment while
  the split block's phones reload.
- Attention, RoPE and SiLU in WASM too; credits (step 5).
- Direct phone-to-phone WebRTC (after the MVP).
- Backing pUSDC with USDC, so the peg holds: today it is minted up front and
  nothing redeems it, and the Uniswap pool isn't built.
- A cap on KV cache memory per phone. Idle conversations hold theirs until
  New chat or 10 minutes idle; many long conversations on one phone could
  exceed its memory first.
