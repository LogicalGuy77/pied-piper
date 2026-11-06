// A peek at the open database: the conversations the tracker has saved to
// Arkiv's Rabdi testnet. "Latest writes" is the tracker's list of the
// transactions it sent; "On chain" is read back from Arkiv itself, so it shows
// the database really changed. Used by the phone page and by /arkiv.
//
//   const panel = mountArkivPanel(element, { chatId, query })
//   panel.recorded(event)   // a "recorded" event: refresh now, highlight that entity
//   panel.setChat(chatId)   // the page started a new chat
//   panel.lookup(text)      // with query: true, show one conversation by tx hash, entity key or chat id
//   panel.stop() / panel.start()

const POLL_MS = 5000;

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const short = (hex) => (hex ? `${hex.slice(0, 8)}…${hex.slice(-4)}` : "");
const time = (ms) => new Date(ms).toLocaleTimeString();
const ext = (href, text) => `<a href="${esc(href)}" target="_blank" rel="noopener">${esc(text)}</a>`;
const ago = (ms) => {
  const s = Math.max(0, Math.round((Date.now() - ms) / 1000));
  return s < 60 ? `${s} s ago` : s < 3600 ? `${Math.round(s / 60)} min ago` : `${(s / 3600).toFixed(1)} h ago`;
};
const left = (sec) => (sec <= 0 ? "expiring" : sec < 3600 ? `${Math.round(sec / 60)} min left` : `${(sec / 3600).toFixed(1)} h left`);

const STYLE = `
.ak { display: grid; gap: 12px; font-size: 14px; }
.ak .meta { font-size: 12px; color: var(--muted); }
.ak h3 { font-size: 12px; text-transform: uppercase; letter-spacing: .04em; color: var(--muted); margin: 0 0 6px; }
.ak .row { display: flex; flex-wrap: wrap; gap: 4px 10px; align-items: baseline; font: 12px ui-monospace, monospace; padding: 4px 0; border-top: 1px solid var(--line); }
.ak .op { font-weight: 700; padding: 0 6px; border-radius: 4px; background: var(--line); }
.ak .op.create { background: var(--b1); color: var(--b1s); }
.ak .op.update { background: var(--b2); color: var(--b2s); }
.ak .ent { border: 1px solid var(--line); border-radius: 10px; padding: 8px 10px; margin-top: 6px; transition: background .6s; }
.ak .ent.mine { border-color: var(--accent); }
.ak .ent.flash { background: var(--b1); }
.ak .ent summary { cursor: pointer; display: flex; flex-wrap: wrap; gap: 4px 12px; align-items: baseline; font-size: 13px; }
.ak .badge { font-size: 11px; font-weight: 700; color: var(--accent); }
.ak .msgs { display: grid; gap: 4px; margin: 8px 0; }
.ak .m { white-space: pre-wrap; overflow-wrap: anywhere; font-size: 13px; padding: 4px 8px; border-radius: 6px; background: var(--bg); }
.ak .m b { color: var(--muted); font-weight: 600; }
.ak table { border-collapse: collapse; font: 12px ui-monospace, monospace; width: 100%; }
.ak th, .ak td { text-align: right; padding: 2px 6px; border-top: 1px solid var(--line); }
.ak th:first-child, .ak td:first-child, .ak td.l { text-align: left; }
.ak .err { color: var(--bad); font-size: 13px; }
.ak .scroll { overflow-x: auto; }
.ak form { display: flex; gap: 8px; }
.ak form input { flex: 1; min-width: 0; font: 13px ui-monospace, monospace; padding: 8px 12px; border: 1px solid var(--line); border-radius: 999px; background: var(--bg); color: inherit; }
.ak .found { border: 1px solid var(--accent); border-radius: 12px; padding: 10px 12px; margin-top: 8px; display: grid; gap: 6px; }
.ak .m.later, .ak tr.later { opacity: .45; }
.ak .cut { font-size: 11px; font-weight: 700; color: var(--muted); text-transform: uppercase; letter-spacing: .04em; padding: 2px 0; }
.ak button.q { font: inherit; background: none; border: 0; padding: 0; color: var(--accent); cursor: pointer; text-decoration: underline dotted; }
`;

// One conversation: its messages and per-answer metrics. savedAtTx: the
// answers a looked-up transaction saved; later ones are dimmed.
function entityHtml(e, { open = false, badges = "", savedAtTx = null } = {}) {
  const updated = e.updatedAtBlock !== e.createdAtBlock;
  let answers = 0, cutShown = false;
  const msgs = e.messages.map((m) => {
    const later = savedAtTx != null && answers >= savedAtTx;
    if (m.role === "assistant") answers++;
    const cut = later && !cutShown ? `<div class="cut">Added after this transaction</div>` : "";
    if (later) cutShown = true;
    return `${cut}<div class="m${later ? " later" : ""}"><b>${esc(m.role)}:</b> ${esc(m.content)}</div>`;
  }).join("");
  return `<details class="ent" data-key="${esc(e.key)}"${open ? " open" : ""}>
    <summary><b>chat ${esc(e.chatId.slice(0, 8))}</b>${badges}
      <span>${e.turns} turn${e.turns === 1 ? "" : "s"} · ${e.tokens} tokens · ${esc(e.model)}</span>
      <span class="meta">${updated ? `updated at block ${e.updatedAtBlock.toLocaleString()}` : `added at block ${e.createdAtBlock.toLocaleString()}`} · ${ago(e.updatedMs)} · ${left(e.expiresInSec)}</span>
      <span class="meta">entity <button class="q" data-q="${esc(e.key)}">${esc(short(e.key))}</button> (${ext(e.url, "explorer")})</span></summary>
    <div class="meta">chat id <code>${esc(e.chatId)}</code>${e.owner && e.mine === false ? ` · written by ${esc(short(e.owner))}, not this tracker` : ""}</div>
    <div class="msgs">${msgs}</div>
    <div class="scroll"><table><tr><th>turn</th><th>at</th><th>prompt</th><th>tokens</th><th>first token</th><th>ms/token</th><th>tok/s</th><th>route</th><th>per hop ms</th><th>finish</th></tr>
    ${e.metrics.map((m) => `<tr${savedAtTx != null && m.turn > savedAtTx ? ` class="later"` : ""}><td>${m.turn}</td><td class="l">${esc(m.at ? new Date(m.at).toLocaleTimeString() : "")}</td><td>${m.promptTokens ?? ""}</td><td>${m.tokens}</td>`
      + `<td>${m.firstTokenMs != null ? (m.firstTokenMs / 1000).toFixed(1) + " s" : ""}</td><td>${m.msPerToken ?? ""}</td><td>${m.tokensPerSec ?? ""}</td>`
      + `<td class="l">${esc((m.route ?? []).join(" → "))}${m.reroutes ? ` (${m.reroutes}× rerouted)` : ""}</td><td class="l">${esc((m.hopMs ?? []).join(" · "))}</td><td class="l">${esc(m.finish)}</td></tr>`).join("")}
    </table></div></details>`;
}

const OPS = { EntityCreated: "added the conversation", EntityPatched: "updated it", ExpiryExtended: "kept it a day longer" };

export function mountArkivPanel(root, { chatId = null, query = false } = {}) {
  if (!document.getElementById("ak-style")) {
    const style = document.createElement("style");
    style.id = "ak-style";
    style.textContent = STYLE;
    document.head.append(style);
  }
  root.innerHTML = `<div class="ak"><div class="meta" data-k="info">Loading…</div>
    ${query ? `<div><h3>Look up a conversation</h3>
      <form data-k="form"><input data-k="q" placeholder="transaction hash, entity key or chat id" autocomplete="off" spellcheck="false"><button class="quiet">Look up</button></form>
      <div data-k="found"></div></div>` : ""}
    <div><div class="head"><h3>Latest writes (sent by the tracker)</h3><button class="quiet" data-k="refresh">Refresh</button></div><div data-k="writes"></div></div>
    <div><h3>On chain (read back from Arkiv)</h3><div class="meta" data-k="read"></div><div data-k="entities"></div></div></div>`;
  const $ = (k) => root.querySelector(`[data-k="${k}"]`);
  const hash = (h, text = short(h)) => (query ? `<button class="q" data-q="${esc(h)}">${esc(text)}</button>` : esc(text));

  let timer = null;
  let loading = false;
  const seen = new Map();   // entity key -> updatedAtBlock at the last render
  const open = new Set();   // entity keys whose details are open
  let flashKey = null;      // the entity a "recorded" event just wrote

  async function refresh() {
    if (loading) return;
    loading = true;
    try {
      const info = await (await fetch("/arkiv/info")).json();
      renderInfo(info);
      if (!info.enabled) return;
      const res = await fetch("/arkiv/entities");
      const list = await res.json();
      if (!res.ok) throw new Error(list.error);
      renderEntities(list);
    } catch (err) {
      $("read").innerHTML = `<span class="err">${esc(err.message)}</span>`;
    } finally {
      loading = false;
    }
  }

  function renderInfo(info) {
    if (!info.enabled) {
      $("info").innerHTML = `<span class="err">${esc(info.reason)}</span>`;
      $("writes").textContent = "";
      $("entities").textContent = "";
      return;
    }
    $("info").innerHTML = `${esc(info.network)} (chain ${info.chainId}) · saver wallet ${ext(info.addressUrl, short(info.address))}`
      + ` · schema <code>${esc(info.schema)}</code> · an entity expires ${info.expiryDays} day after its last write`;
    $("writes").innerHTML = info.writes.length
      ? info.writes.slice(0, 10).map((w) => `<div class="row"><span>${time(w.at)}</span>`
        + `<span class="op ${w.op}">${w.op === "create" ? "ADD" : "UPDATE"}</span>`
        + `<span>chat ${esc(w.chatId.slice(0, 8))}${w.chatId === chatId ? " (this chat)" : ""}</span>`
        + `<span>turn ${w.turns}</span><span>entity ${hash(w.entityKey)} (${ext(w.entityUrl, "explorer")})</span>`
        + `<span>tx ${hash(w.txHash)} (${ext(w.txUrl, "explorer")})</span></div>`).join("")
      : `<div class="meta">Nothing yet. Ask a question: when the answer ends, it is saved here.</div>`;
  }

  function renderEntities(list) {
    $("read").textContent = `Read at ${time(list.readAt)}, block ${list.currentBlock.toLocaleString()} · ${list.entities.length} conversation${list.entities.length === 1 ? "" : "s"}`;
    for (const d of $("entities").querySelectorAll("details[data-key]")) (d.open ? open.add(d.dataset.key) : open.delete(d.dataset.key));
    const changed = new Set();
    for (const e of list.entities) {
      const before = seen.get(e.key);
      if ((before !== undefined && before !== e.updatedAtBlock) || e.key === flashKey) changed.add(e.key);
      seen.set(e.key, e.updatedAtBlock);
    }
    flashKey = null;
    $("entities").innerHTML = list.entities.map((e) => {
      const mine = e.chatId === chatId;
      const badges = (mine ? `<span class="badge">THIS CHAT</span>` : "") + (changed.has(e.key) ? `<span class="badge">JUST UPDATED</span>` : "");
      return entityHtml(e, { open: open.has(e.key) || (mine && changed.has(e.key)), badges }).replace(`class="ent"`, `class="ent${mine ? " mine" : ""}"`);
    }).join("") || `<div class="meta">No conversations from this wallet on chain yet (or they all expired).</div>`;
    for (const key of changed) {
      const el = $("entities").querySelector(`details[data-key="${CSS.escape(key)}"]`);
      el?.classList.add("flash");
      setTimeout(() => el?.classList.remove("flash"), 1500);
    }
  }

  async function lookup(text) {
    text = String(text ?? "").trim();
    if (!query || !text) return;
    $("q").value = text;
    history.replaceState(null, "", `#q=${encodeURIComponent(text)}`);
    $("found").innerHTML = `<div class="meta">Reading from Arkiv…</div>`;
    try {
      const res = await fetch(`/arkiv/lookup?q=${encodeURIComponent(text)}`);
      const r = await res.json();
      if (!res.ok) throw new Error(r.error);
      renderFound(r);
    } catch (err) {
      $("found").innerHTML = `<div class="err">${esc(err.message)}</div>`;
    }
  }

  function renderFound(r) {
    const tx = r.tx;
    const head = tx
      ? `<div class="row"><span>tx ${ext(tx.url, short(tx.hash))}</span><span>block ${tx.block.toLocaleString()}</span><span>${new Date(tx.timeMs).toLocaleString()}</span>`
        + `<span>from ${esc(short(tx.from))}</span><span>${tx.status === "success" ? esc(tx.ops.map((o) => OPS[o] ?? o).join(", ") || "no entity changes") : "<span class=\"err\">reverted</span>"}</span></div>`
      : "";
    const e = r.entities;
    const saved = (x) => (x.savedAtTx != null
      ? `<div class="meta">This transaction saved the first ${x.savedAtTx} answer${x.savedAtTx === 1 ? "" : "s"}${x.savedAtTx < x.turns ? `; the ${x.turns - x.savedAtTx} after it are dimmed` : ""}. Arkiv keeps only the latest version, so this is the conversation as it is now.</div>`
      : "");
    const body = e.length
      ? e.map((x) => saved(x) + entityHtml(x, { open: e.length === 1, savedAtTx: x.savedAtTx ?? null })).join("")
      : "";
    const count = r.kind === "chat" && e.length ? `<div class="meta">${e.length} conversation${e.length === 1 ? "" : "s"} whose chat id starts with <code>${esc(r.query)}</code></div>` : "";
    $("found").innerHTML = `<div class="found">${head}${count}${r.note ? `<div class="meta">${esc(r.note[0].toUpperCase() + r.note.slice(1))}.</div>` : ""}${body}</div>`;
  }

  $("refresh").addEventListener("click", refresh);
  if (query) {
    $("form").addEventListener("submit", (ev) => {
      ev.preventDefault();
      lookup($("q").value);
    });
    root.addEventListener("click", (ev) => {
      const b = ev.target.closest("button.q");
      if (!b) return;
      ev.preventDefault();
      lookup(b.dataset.q);
      $("q").scrollIntoView({ block: "center", behavior: "smooth" });
    });
    const initial = new URLSearchParams(location.hash.slice(1)).get("q");
    if (initial) lookup(initial);
  }

  const panel = {
    lookup,
    start() {
      if (timer) return;
      refresh();
      timer = setInterval(refresh, POLL_MS);
    },
    stop() {
      clearInterval(timer);
      timer = null;
    },
    setChat(id) {
      chatId = id;
      refresh();
    },
    recorded(e) {
      if (e.entityKey) flashKey = e.entityKey;
      if (timer) refresh();
    },
  };
  panel.start();
  return panel;
}
