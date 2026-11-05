# Step 3.5: Mock phones as containers

Each phone is a Docker container running headless Chromium with the real
swarm page. The tracker is another container, serving HTTPS. That gives us
real network hops between separate IPs, and lets us break things on purpose:
Wi-Fi delay and loss, a phone freezing, a phone dying, slow phones.

What it can't show: phone browsers killing tabs, Wake Lock, ARM speed,
heat throttling and a crowded real Wi-Fi. That's step 4, on real phones.

## Run

Needs Docker with Compose, plus the outputs of steps 1–3: the int8 export
and `testvectors-int8/` (the tracker serves int8 by default), and
`npm install` in `swarm/`. The results below were measured on float32.

```sh
cd docker && npm install
npm test                      # builds, starts 6 phones, runs 17 checks, stops: about 5 min
PHONES=9 npm test             # more phones (a multiple of 3)
WIFI="delay 20ms 10ms loss 3%" npm test   # a worse network
KEEP=1 npm test               # leave the swarm running afterwards
```

The first run pulls the Playwright image (about 2 GB). The test makes a
self-signed certificate in `docker/certs/` (not committed).

While it runs, or with `KEEP=1`, open `https://localhost:8443` on the host and
accept the certificate warning to join as one more phone and watch the swarm.

## Scenarios and results on this laptop

6 phones, 1 CPU and 1 GB each. Wi-Fi emulation is `netem delay 8ms 4ms loss 1%`
on every phone's link and on the tracker's, which measured 16 ms average ping.

| Scenario | Result |
|---|---|
| 6 containers join | 2 per block, all serving 3.6 s after start; every phone has its own IP |
| HTTPS on a LAN name (`https://tracker:8443`) | The page is a secure context, which Wake Lock in step 4 needs |
| One answer over the network | Hugging Face's text. First token 5.1 s, then 165 ms per token |
| **With Wi-Fi delay and loss** | Still exactly right. First token 5.3 s, then **236 ms per token** |
| Two phones ask at once | Both right, on disjoint routes |
| **A phone freezes** (`docker pause`, like a locked screen) | The answer is rerouted to another holder of B's block after 20 s (B froze owing a reply, so it got the busy timeout) and finishes; when B wakes up, its page says it was dropped |
| A phone dies (`docker kill`) | Rerouted after 0.3 s; the answer finishes and the swarm keeps answering correctly |
| A phone reloads its page | Serving again 1.0 s later, its 198 MB block read from the browser's cache |
| All phones at 0.5 CPU | Still right, nobody dropped for being slow. First token 10.3 s, then 306 ms per token |
| Health | Each phone uses about 540 MB (Chromium plus its block); no OOM, no page errors, no bad frames |

## What we learned

- **Wi-Fi costs about 70 ms per token** (165 → 236 ms), from 8 one-way trips
  per token through the laptop: asker → tracker → block 1 → tracker → … →
  asker. Direct phone-to-phone links (WebRTC, after the MVP) would halve that.
- **A frozen phone never closes its connection.** Without the heartbeat added
  in this step, the asker would have waited forever. Now it's dropped after
  5 s of silence (`--heartbeat-timeout`).
- **Long chats get slow to start.** Each question re-sends the whole
  conversation, at about 0.13 s per prompt token on a laptop. An early run of
  this test asked everything in one chat, and the first token grew from 5 s
  to 120 s. The page now has a **New chat** button. Keeping each phone's KV
  cache between turns would fix it properly.
- Memory: about 540 MB per phone in Chromium, more than the 300 MB budget
  for the 226 MB block. Worth measuring on real phones; int8 weights (step 4)
  cut the block to a quarter.

## Files

| File | Role |
|---|---|
| `compose.yml` | `tracker` (HTTPS on 8443, repo mounted read-only) and `phone` (scaled to N) |
| `tracker/Dockerfile` | Node 22 plus `tc` for network emulation |
| `phone/Dockerfile` | Playwright's Chromium image plus `tc` and `ping`, running a browser server |
| `test.mjs` | Starts everything, drives each phone's page, runs the scenarios |
