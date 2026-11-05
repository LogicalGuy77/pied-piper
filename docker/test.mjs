// Step 3.5: the swarm with phones as Docker containers.
//
// Starts a tracker container (HTTPS) and N phone containers, each running
// headless Chromium with the real swarm page, then runs the scenarios that
// one laptop can't show: real network hops, Wi-Fi delay and loss, a phone
// freezing (docker pause), a phone dying (docker kill), and slow phones.
//
//   cd docker && npm install && npm test
//   PHONES=9 WIFI="delay 8ms 4ms loss 1%" KEEP=1 npm test
//
// Needs weights/, testvectors/ and swarm/node_modules from steps 1-3.

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const HERE = join(ROOT, "docker");
const PHONES = Number(process.env.PHONES ?? 6);
const WIFI = process.env.WIFI ?? "delay 8ms 4ms loss 1%"; // netem per link: delay, jitter, loss
const SLOW_CPUS = process.env.SLOW_CPUS ?? "0.5";
const URL_IN_SWARM = "https://tracker:8443/";
const index = JSON.parse(readFileSync(join(ROOT, "testvectors", "index.json"), "utf8"));

const results = [];
function check(name, ok, detail = "") {
  results.push(ok);
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`);
}
const sh = (cmd, args, opts = {}) => execFileSync(cmd, args, { encoding: "utf8", ...opts }).trim();
const compose = (...args) => sh("docker", ["compose", "-f", join(HERE, "compose.yml"), ...args]);
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const secs = (ms) => `${(ms / 1000).toFixed(1)} s`;

// --- Bring the swarm up ---

for (const need of ["weights/smollm2-135m-instruct/manifest.json", "testvectors/index.json", "swarm/node_modules/ws"]) {
  if (!existsSync(join(ROOT, need))) throw new Error(`missing ${need}: run steps 1-3 first (see README.md)`);
}
const certs = join(HERE, "certs");
if (!existsSync(join(certs, "tracker.crt"))) {
  mkdirSync(certs, { recursive: true });
  sh("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "30", "-subj", "/CN=tracker",
    "-addext", "subjectAltName=DNS:tracker,DNS:localhost",
    "-keyout", join(certs, "tracker.key"), "-out", join(certs, "tracker.crt")], { stdio: "pipe" });
  sh("chmod", ["644", join(certs, "tracker.key")]); // read by the tracker container's user
}

console.log(`Starting a tracker and ${PHONES} phone containers…`);
compose("up", "-d", "--build", "--scale", `phone=${PHONES}`, "--force-recreate");

const phones = []; // { container, page, id, block }
const errors = [];
const browsers = [];
try {
  const t0 = Date.now();
  for (let i = 1; i <= PHONES; i++) {
    const container = `phone-swarm-phone-${i}`;
    const port = compose("port", "--index", String(i), "phone", "3000").split(":").at(-1);
    let browser = null;
    for (let tries = 0; !browser; tries++) {
      try {
        browser = await chromium.connect(`ws://127.0.0.1:${port}/`, { timeout: 5000 });
      } catch (err) {
        if (tries > 30) throw err;
        await wait(1000);
      }
    }
    browsers.push(browser);
    // A self-signed certificate: a real phone would show a warning to accept once.
    const page = await (await browser.newContext({ ignoreHTTPSErrors: true })).newPage();
    page.on("pageerror", (e) => errors.push(`${container}: ${e.message}`));
    page.on("console", (m) => m.type() === "error" && errors.push(`${container}: ${m.text()}`));
    await page.goto(URL_IN_SWARM);
    phones.push({ container, page });
  }
  for (const p of phones) {
    await p.page.waitForFunction(() => document.getElementById("status").textContent.startsWith("Serving"), null, { timeout: 300000 });
    const title = await p.page.textContent("#title");
    [, p.id, p.block] = title.match(/Phone (\S+) · Block (\d)/);
    p.block = Number(p.block);
  }
  const byId = Object.fromEntries(phones.map((p) => [p.id, p]));
  const alive = new Set(phones.map((p) => p.id));

  // --- Helpers that drive one phone's page ---

  const nAnswers = (p) => p.page.evaluate(() => document.querySelectorAll(".msg.assistant").length);
  // Every question starts a new chat, so each scenario sends a prompt of the
  // same size and timings stay comparable.
  async function startAsk(p, text) {
    await p.page.waitForFunction(() => !document.getElementById("input").disabled, null, { timeout: 120000 });
    if (await p.page.isEnabled("#new")) await p.page.click("#new");
    const n = await nAnswers(p);
    await p.page.fill("#input", text);
    await p.page.press("#input", "Enter");
    return n + 1;
  }
  async function finish(p, n) {
    await p.page.waitForFunction((n) => {
      const el = document.querySelectorAll(".msg.assistant")[n - 1];
      return el && (el.querySelector(".stats") || el.classList.contains("error"));
    }, n, { timeout: 300000 });
    return p.page.evaluate((n) => {
      const el = document.querySelectorAll(".msg.assistant")[n - 1];
      const stats = el.querySelector(".stats")?.textContent ?? "";
      return {
        text: el.firstChild?.textContent ?? "",
        error: el.classList.contains("error"),
        stats,
        route: stats.match(/route (.+?) ·/)?.[1]?.split(" → ") ?? [],
        firstMs: Number(stats.match(/first token ([\d.]+) s/)?.[1] ?? NaN) * 1000,
        msPerToken: Number(stats.match(/then (\d+) ms per token/)?.[1] ?? NaN),
      };
    }, n);
  }
  const ask = async (p, text) => finish(p, await startAsk(p, text));
  async function routeInFlight(p) {
    const line = await p.page.waitForFunction((me) => {
      const m = document.getElementById("routes").textContent.match(new RegExp(`${me} asks via (\\S+) → (\\S+) → (\\S+)`));
      return m && m.slice(1);
    }, p.id, { timeout: 60000 });
    return line.jsonValue();
  }
  const waitForText = (p, n, chars) => p.page.waitForFunction(([n, chars]) => {
    const el = document.querySelectorAll(".msg.assistant")[n - 1];
    return (el?.firstChild?.textContent ?? "").length >= chars;
  }, [n, chars], { timeout: 120000 });
  const speed = (a) => `first token ${secs(a.firstMs)}, then ${a.msPerToken} ms per token, route ${a.route.join(" → ")}`;
  const holders = (block) => phones.filter((p) => p.block === block && alive.has(p.id));
  function netem(container, spec) {
    sh("docker", ["exec", container, "tc", "qdisc", "replace", "dev", "eth0", "root", "netem", ...spec.split(" ")]);
  }

  console.log("1. The swarm comes up");
  const perBlock = [1, 2, 3].map((b) => holders(b).map((p) => p.id).join(","));
  check(`${PHONES} containers join, ${PHONES / 3} per block`, perBlock.every((s) => s.split(",").length === PHONES / 3),
    `${perBlock.map((s, i) => `block ${i + 1}: ${s}`).join("  ")}; all serving after ${secs(Date.now() - t0)}`);
  const secure = await phones[0].page.evaluate(() => ({ secure: isSecureContext, host: location.host }));
  check("the page is a secure context over HTTPS on a LAN name", secure.secure && secure.host === "tracker:8443", JSON.stringify(secure));
  const ips = new Set(phones.map((p) => sh("docker", ["inspect", "-f", "{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}", p.container])));
  check("every phone has its own IP", ips.size === PHONES, [...ips].join(" "));

  const asker = holders(1)[1]; // a block 1 phone, so the phones we break below are never the asker

  console.log("2. One answer over the network");
  const base = await ask(asker, index.prompt);
  check("the answer starts with Hugging Face's greedy text", !base.error && base.text.startsWith(index.greedy_text), speed(base));

  console.log(`3. Wi-Fi: every link gets netem "${WIFI}"`);
  for (const p of phones) netem(p.container, WIFI);
  netem("phone-swarm-tracker-1", WIFI);
  const ping = sh("docker", ["exec", phones[0].container, "bash", "-c", "ping -c 20 -i 0.2 -q tracker | tail -1"]).split(" = ")[1];
  const wifi = await ask(asker, index.prompt);
  check("the answer is still exactly right", !wifi.error && wifi.text.startsWith(index.greedy_text),
    `${speed(wifi)}; was ${base.msPerToken} ms; ping min/avg/max/mdev ${ping}`);

  console.log("4. Two phones ask at once");
  const other = holders(3)[0];
  const [qa, qb] = await Promise.all([ask(asker, index.prompt), ask(other, "What is the capital of France?")]);
  check("both answers are right", qa.text.startsWith(index.greedy_text) && qb.text.startsWith("The capital of France is Paris."),
    JSON.stringify(qb.text.slice(0, 40)));
  check("on different phones", qa.route.every((id) => !qb.route.includes(id)), `${qa.route.join(" → ")}  and  ${qb.route.join(" → ")}`);

  // Waits until the asker's route no longer has the victim: the tracker has rerouted.
  const rerouted = (p, victim) => p.page.waitForFunction(([me, v]) => {
    const m = document.getElementById("routes").textContent.match(new RegExp(`${me} asks via (.+)`));
    return m && !m[1].split(" → ").includes(v);
  }, [p.id, victim.id], { timeout: 60000 });

  console.log("5. A phone freezes (docker pause, like a locked screen)");
  {
    const n = await startAsk(asker, "Write a long story about a robot who learns to paint.");
    const route = await routeInFlight(asker);
    await waitForText(asker, n, 30);
    const victim = byId[route[1]];
    const t = Date.now();
    sh("docker", ["pause", victim.container]);
    await rerouted(asker, victim);
    const noticed = Date.now() - t;
    const cut = await finish(asker, n);
    alive.delete(victim.id);
    check("the answer continues on another holder of its block", !cut.error && /rerouted 1×/.test(cut.stats) && !cut.route.includes(victim.id),
      `${victim.id} paused, rerouted after ${secs(noticed)} to ${cut.route.join(" → ")}, ${cut.text.length} characters`);
    const again = await ask(asker, "What is the capital of France?");
    check("the next question avoids the frozen phone and is right", !again.error && !again.route.includes(victim.id) && again.text.startsWith("The capital of France is Paris."),
      speed(again));
    sh("docker", ["unpause", victim.container]);
    const status = await victim.page.waitForFunction(() => {
      const s = document.getElementById("status").textContent;
      return s.startsWith("Disconnected") && s;
    }, null, { timeout: 30000 }).then((h) => h.jsonValue()).catch(() => "still connected");
    check("when it wakes up, it knows it was dropped", status.startsWith("Disconnected"), status);
  }

  console.log("6. A phone dies (docker kill)");
  {
    const n = await startAsk(asker, "Write a long story about a dragon who is afraid of fire.");
    const route = await routeInFlight(asker);
    await waitForText(asker, n, 30);
    const victim = byId[route[2]];
    const t = Date.now();
    sh("docker", ["kill", victim.container]);
    await rerouted(asker, victim);
    const noticed = Date.now() - t;
    const cut = await finish(asker, n);
    alive.delete(victim.id);
    check("the answer continues on another holder of its block", !cut.error && /rerouted 1×/.test(cut.stats) && !cut.route.includes(victim.id),
      `${victim.id} killed, rerouted after ${secs(noticed)} to ${cut.route.join(" → ")}`);
    const again = await ask(asker, index.prompt);
    check("the swarm keeps answering correctly without it", !again.error && !again.route.includes(victim.id) && again.text.startsWith(index.greedy_text),
      speed(again));
  }

  console.log("7. A phone reloads its page: weights from its cache");
  {
    // The only holder left of block 2, so it gets block 2 again when it rejoins.
    const p = holders(2)[0];
    const t = Date.now();
    await p.page.reload();
    const status = await p.page.waitForFunction(() => {
      const s = document.getElementById("status").textContent;
      return s.startsWith("Serving") && s;
    }, null, { timeout: 300000 }).then((h) => h.jsonValue());
    alive.delete(p.id);
    [, p.id, p.block] = (await p.page.textContent("#title")).match(/Phone (\S+) · Block (\d)/);
    p.block = Number(p.block);
    byId[p.id] = p;
    alive.add(p.id);
    check("it rejoins with its block read from the browser's cache", p.block === 2 && status.includes("from this phone's cache"),
      `serving again as ${p.id} after ${secs(Date.now() - t)}: ${JSON.stringify(status)}`);
  }

  console.log(`8. Slow phones: every phone limited to ${SLOW_CPUS} CPU`);
  {
    for (const p of phones) if (alive.has(p.id)) sh("docker", ["update", "--cpus", SLOW_CPUS, p.container]);
    const slow = await ask(asker, index.prompt);
    check("still right, and no phone dropped for being slow", !slow.error && slow.text.startsWith(index.greedy_text),
      `${speed(slow)}; at 1 CPU it was ${wifi.msPerToken} ms`);
  }

  console.log("9. Health");
  {
    const live = phones.filter((p) => alive.has(p.id));
    const oom = live.filter((p) => sh("docker", ["inspect", "-f", "{{.State.OOMKilled}}", p.container]) === "true");
    const mem = sh("docker", ["stats", "--no-stream", "--format", "{{.Name}} {{.MemUsage}}", ...live.map((p) => p.container)])
      .split("\n").map((l) => l.replace("phone-swarm-phone-", "#").split(" / ")[0]).join(", ");
    check(`no phone ran out of memory (${process.env.PHONE_MEMORY ?? "1g"} each)`, oom.length === 0, mem);
    const log = compose("logs", "--no-color", "tracker");
    check("the tracker dropped no bad frames", !/bad frame/.test(log));
    const unexpected = errors.filter((e) => !/Disconnected from the tracker/.test(e));
    check("no page errors in any phone", unexpected.length === 0, unexpected.slice(0, 3).join(" | "));
  }
} finally {
  for (const b of browsers) await b.close().catch(() => {});
  if (process.env.KEEP) console.log("\nKEEP is set: containers left running. Stop them with: docker compose -f docker/compose.yml down");
  else compose("down", "--timeout", "1");
}

const passed = results.filter(Boolean).length;
console.log(`\n${passed}/${results.length} container checks passed`);
process.exit(passed === results.length ? 0 : 1);
