// The tab's page: status, swarm summary and chat. The phone itself runs in worker.js.

const $ = (id) => document.getElementById(id);
const worker = new Worker(new URL("./worker.js", import.meta.url), { type: "module" });
const MAX_NEW = 256;

let me = null;
let myBlock = null;
let blocks = [];
let tokenizerReady = false;
let busy = false;
let swarm = null;   // latest summary from the tracker
let myRoute = null; // route of the question this phone is asking
const messages = []; // the conversation so far, re-sent in full on each question
let answerEl = null;

const mb = (bytes) => `${(bytes / 1e6).toFixed(1)} MB`;
const blockLabel = (b) => {
  const parts = b.start === 0 ? ["embedding"] : [];
  parts.push(`layers ${b.start}–${b.end - 1}`);
  if (b.end === blocks.at(-1)?.end) parts.push("output");
  return parts.join(" + ");
};

function setInputEnabled() {
  const on = tokenizerReady && !busy;
  $("input").disabled = !on;
  $("send").disabled = !on;
  $("new").disabled = busy || messages.length === 0;
}

function addMessage(role, text) {
  const el = document.createElement("div");
  el.className = `msg ${role}`;
  el.textContent = text;
  $("chat").append(el);
  $("chat").scrollTop = $("chat").scrollHeight;
  return el;
}

function renderSwarm() {
  if (!swarm) return;
  $("blocks").replaceChildren(...swarm.blocks.map((b) => {
    const { ready, loading } = swarm.holders[b.index];
    const el = document.createElement("div");
    el.className = "block";
    el.dataset.b = b.index % 3;
    const count = `${ready} ready${loading ? ` · ${loading} loading` : ""}`;
    const warn = ready === 0 ? "no phone yet" : ready === 1 ? "only one phone" : "";
    el.innerHTML = `<div class="name">Block ${b.index + 1}${b.index === myBlock ? " · you" : ""}</div>`
      + `<div class="muted" style="font-size:12px">${blockLabel(b)}</div>`
      + `<div class="count">${count}</div>${warn ? `<div class="warn">${warn}</div>` : ""}`;
    return el;
  }));
  $("routes").textContent = myRoute
    ? `${me} asks via ${myRoute.join(" → ")}`
    : `${swarm.phones} phones · ${swarm.sessions} question${swarm.sessions === 1 ? "" : "s"} in flight`;
}

worker.onmessage = ({ data: e }) => {
  if (e.type === "welcome") {
    me = e.id;
    myBlock = e.block.index;
    blocks = e.blocks;
    $("title").textContent = `Phone ${e.id} · Block ${e.block.index + 1}`;
    $("status").textContent = `Holds ${blockLabel(e.block)}. Loading its weights…`;
    renderSwarm();
  } else if (e.type === "tokenizer") {
    tokenizerReady = true;
    setInputEnabled();
  } else if (e.type === "progress") {
    $("progress").style.width = `${(100 * e.loaded) / e.total}%`;
    $("status").textContent = `Loading block weights: ${mb(e.loaded)} of ${mb(e.total)}`;
  } else if (e.type === "loaded") {
    const cached = e.fromCache >= e.weightBytes ? ", from this phone's cache" : "";
    $("status").textContent = `Serving ${e.describe} (${mb(e.weightBytes)}${cached}). You can ask too.`;
  } else if (e.type === "swarm") {
    swarm = e;
    renderSwarm();
  } else if (e.type === "served") {
    $("mine").textContent = `You've served ${e.served} tokens for the swarm, ${(e.computeMs / e.served).toFixed(0)} ms per token on average.`;
  } else if (e.type === "reroute") {
    myRoute = e.route;
    renderSwarm();
  } else if (e.type === "token") {
    answerEl.textContent += e.text;
    if (e.route) {
      answerEl.dataset.route = e.route.join(" → ");
      myRoute = e.route;
      renderSwarm();
    }
    $("chat").scrollTop = $("chat").scrollHeight;
  } else if (e.type === "done") {
    messages.push({ role: "assistant", content: answerEl.textContent });
    const stats = document.createElement("div");
    stats.className = "stats";
    const rerouted = e.reroutes ? ` · rerouted ${e.reroutes}× when a phone left` : "";
    stats.textContent = `route ${answerEl.dataset.route} · ${e.tokens} tokens · first token ${(e.firstMs / 1000).toFixed(1)} s · then ${e.msPerToken.toFixed(0)} ms per token${rerouted}`;
    answerEl.append(stats);
    finishAsk();
  } else if (e.type === "error") {
    messages.pop(); // the question didn't get an answer; don't keep it in the conversation
    answerEl.classList.add("error");
    answerEl.textContent += (answerEl.textContent ? "\n" : "") + e.message;
    finishAsk();
  } else if (e.type === "fatal" || e.type === "closed") {
    $("status").textContent = e.message ?? e.reason;
    $("status").style.color = "var(--bad)";
  }
};

function finishAsk() {
  busy = false;
  myRoute = null;
  renderSwarm();
  setInputEnabled();
}

$("form").addEventListener("submit", (ev) => {
  ev.preventDefault();
  const text = $("input").value.trim();
  if (!text || busy) return;
  $("input").value = "";
  messages.push({ role: "user", content: text });
  addMessage("user", text);
  answerEl = addMessage("assistant", "");
  busy = true;
  setInputEnabled();
  worker.postMessage({ type: "ask", messages, maxNew: MAX_NEW });
});

// Each question re-sends the whole conversation, so long chats get slow to
// start. A new chat starts from an empty one.
$("new").addEventListener("click", () => {
  messages.length = 0;
  $("chat").replaceChildren();
  setInputEnabled();
});

$("input").addEventListener("keydown", (ev) => {
  if (ev.key === "Enter" && !ev.shiftKey) {
    ev.preventDefault();
    $("form").requestSubmit();
  }
});

// --- Staying awake ---
// A phone whose screen turns off stops answering and is dropped. The lock
// is released whenever the page is hidden, so take it again on return.

let wakeLock = null;
async function keepAwake() {
  if (document.visibilityState !== "visible" || (wakeLock && !wakeLock.released)) return;
  if (!("wakeLock" in navigator)) {
    $("awake").textContent = "Keep this page open and the screen on: this browser can't keep it awake.";
    return;
  }
  try {
    wakeLock = await navigator.wakeLock.request("screen");
    $("awake").textContent = "The screen stays on while this page is open. Switching apps takes this phone out of the swarm.";
    wakeLock.addEventListener("release", report);
  } catch {
    $("awake").textContent = "Keep this page open and the screen on. Tap anywhere to let the page keep it awake.";
  }
  report();
}
document.addEventListener("visibilitychange", () => {
  keepAwake();
  report();
});
document.addEventListener("pointerdown", keepAwake); // some browsers only grant the lock after a tap

// --- Reporting to the tracker: only what it can't measure itself ---

let battery = null;
navigator.getBattery?.().then((b) => (battery = b)).catch(() => {});
function report() {
  worker.postMessage({
    type: "stats",
    stats: {
      hidden: document.visibilityState !== "visible",
      wakeLock: !!wakeLock && !wakeLock.released,
      battery: battery ? Math.round(battery.level * 100) : null,
      charging: battery?.charging ?? null,
      cores: navigator.hardwareConcurrency ?? null,
      memoryGB: navigator.deviceMemory ?? null,
      device: navigator.userAgentData?.platform || /Android|iPhone|iPad|Macintosh|Windows|Linux/.exec(navigator.userAgent)?.[0] || null,
    },
  });
}
setInterval(report, 2000);

keepAwake();
worker.postMessage({ type: "start", server: location.origin });
