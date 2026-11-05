// Saves every finished conversation to Arkiv's Rabdi testnet, an open
// database anyone can read. Runs only in the tracker (Node): it holds the
// private key of the saver wallet, which must never reach a browser.
//
//   const arkiv = createArkivStore({ privateKey, accessKey, model })   // null without a key
//   await arkiv.save({ chatId, messages, metrics })   // creates the chat's entity, or updates it
//   await arkiv.list()                                 // the saver's entities, read back from the chain
//
// One chat is one entity. Its first answer creates it; every answer after
// that patches the messages and metrics and pushes the expiry a day out, in
// one transaction. Entities live a day after their last write.
//
// Writes go out one at a time: they share the saver wallet's nonce, and two
// writes to one chat must land in order.

import { createPublicClient, createWalletClient, ExpirationTime, NoEntityFoundError } from "@arkiv-network/sdk";
import { rabdi } from "@arkiv-network/sdk/chains";
import { desc, eq } from "@arkiv-network/sdk/query";
import { bytes, defineSchema, str, u64 } from "@arkiv-network/sdk/schema";
import { hexToString, http, isHex, stringToBytes } from "viem";
import { privateKeyToAccount } from "viem/accounts";

export const SCHEMA_NAME = "pied-piper.conversation.v1";
export const EXPIRY_DAYS = 1;
export const EXPLORER = "https://rabdi.explorer.arkiv.network";
const MAX_PAYLOAD = 120 * 1024; // the bytes columns of one entity share 128 KiB
const MAX_TURNS_KEPT = 200;     // metrics entries kept per chat

// Anyone can write entities under any schema name, so reads filter by the
// saver's address too.
export const Conversations = defineSchema(SCHEMA_NAME, {
  chatId: str().indexed(),
  model: str().indexed(),
  turns: u64().indexed(),     // answers in the chat so far
  tokens: u64(),              // answer tokens over all turns
  updatedMs: u64().indexed(), // wall clock of the last write; $updatedAt can't be sorted on
  messages: bytes(),          // JSON: [{ role, content }]
  metrics: bytes(),           // JSON: one entry per answer, see the tracker's "record"
});

export const links = {
  tx: (hash) => `${EXPLORER}/tx/${hash}`,
  entity: (key) => `${EXPLORER}/entity/${key}`,
  address: (address) => `${EXPLORER}/address/${address}`,
};

// Returns null when there is no private key: the swarm runs as before.
export function createArkivStore({ privateKey, accessKey = "", model = "unknown" }) {
  if (!privateKey) return null;
  if (!privateKey.startsWith("0x")) privateKey = `0x${privateKey}`; // wallets often export it bare
  if (!isHex(privateKey) || privateKey.length !== 66) {
    throw new Error("ARKIV_PRIVATE_KEY must be a 32-byte hex private key (64 hex digits, 0x optional)");
  }
  const account = privateKeyToAccount(privateKey);
  const chain = rabdi({ accessKey });
  const publicClient = createPublicClient({ chain, transport: http() });
  const walletClient = createWalletClient({ chain, transport: http(), account });

  const chats = new Map(); // chatId -> { entityKey, metrics: [...] }
  const writes = [];       // the last writes, newest last, for the dashboards
  let queue = Promise.resolve();
  let listCache = null;    // { at, promise }: the page polls, the RPC is rate limited

  // The chat's entity, from memory or, after a tracker restart, from the chain.
  async function findChat(chatId) {
    if (chats.has(chatId)) return chats.get(chatId);
    const page = await publicClient
      .select({ $key: true, metrics: true })
      .from(Conversations)
      .where(eq("chatId", chatId))
      .ownedBy(account.address)
      .limit(1)
      .fetch();
    const row = page.entities[0];
    if (!row) return null;
    const chat = { entityKey: row.$key, metrics: parseJson(row.metrics.value, []) };
    chats.set(chatId, chat);
    return chat;
  }

  async function write({ chatId, messages, metrics }) {
    const chat = (await findChat(chatId)) ?? { entityKey: null, metrics: [] };
    const allMetrics = [...chat.metrics, metrics].slice(-MAX_TURNS_KEPT);
    const turns = messages.filter((m) => m.role === "assistant").length;
    const tokens = allMetrics.reduce((sum, m) => sum + (m.tokens ?? 0), 0);
    const now = Date.now();
    const payload = fit(messages, allMetrics);
    const values = {
      turns: u64(turns),
      tokens: u64(tokens),
      updatedMs: u64(now),
      messages: payload.messages,
      metrics: payload.metrics,
    };
    const expiration = ExpirationTime.fromDays(EXPIRY_DAYS);

    let op, txHash, entityKey = chat.entityKey;
    if (entityKey) {
      try {
        // Patch and extend in one transaction, so an update also keeps the entity a day longer.
        ({ txHash } = await walletClient.executeBatch({
          patches: [{ schema: Conversations, entityKey, set: values }],
          extensions: [{ entityKey, expiration }],
        }));
        op = "update";
      } catch (err) {
        if (!(await expired(entityKey))) throw err;
        entityKey = null; // it expired since the last answer: start a new one
      }
    }
    if (!entityKey) {
      ({ entityKey, txHash } = await walletClient.createEntity(
        Conversations,
        { chatId, model, ...values },
        { expiration },
      ));
      op = "create";
    }
    chats.set(chatId, { entityKey, metrics: allMetrics });
    listCache = null;

    const result = {
      op, chatId, entityKey, txHash, turns, tokens, at: now,
      expiresAtMs: now + EXPIRY_DAYS * 86400000,
      txUrl: links.tx(txHash),
      entityUrl: links.entity(entityKey),
      trimmed: payload.trimmed,
    };
    writes.push(result);
    if (writes.length > 30) writes.shift();
    return result;
  }

  async function expired(entityKey) {
    try {
      await publicClient.getEntity(entityKey);
      return false;
    } catch (err) {
      return err instanceof NoEntityFoundError;
    }
  }

  return {
    address: account.address,

    // Queued: resolves once the transaction is in a block.
    save(record) {
      const job = queue.then(() => write(record));
      queue = job.catch(() => {});
      return job;
    },

    info() {
      return {
        enabled: true,
        network: "Rabdi testnet",
        chainId: chain.id,
        schema: SCHEMA_NAME,
        expiryDays: EXPIRY_DAYS,
        address: account.address,
        addressUrl: links.address(account.address),
        explorer: EXPLORER,
        writes: [...writes].reverse(),
      };
    },

    // The saver's conversations, newest first, read back from the chain.
    list({ limit = 20 } = {}) {
      if (listCache && Date.now() - listCache.at < 3000) return listCache.promise;
      const promise = (async () => {
        const [timing, page] = await Promise.all([
          publicClient.getBlockTiming(),
          publicClient
            .select({
              $key: true, $expiresAt: true, $createdAt: true, $updatedAt: true,
              chatId: true, model: true, turns: true, tokens: true, updatedMs: true, messages: true, metrics: true,
            })
            .from(Conversations)
            .ownedBy(account.address)
            .orderBy(desc("updatedMs"))
            .limit(limit)
            .fetch(),
        ]);
        const block = timing.currentBlock;
        return {
          readAt: Date.now(),
          currentBlock: Number(block),
          blockSeconds: timing.blockDuration,
          entities: page.entities.map((e) => ({
            key: e.$key,
            url: links.entity(e.$key),
            createdAtBlock: Number(e.$createdAt),
            updatedAtBlock: Number(e.$updatedAt),
            expiresAtBlock: Number(e.$expiresAt),
            expiresInSec: Number(e.$expiresAt - block) * timing.blockDuration,
            chatId: e.chatId.value,
            model: e.model.value,
            turns: Number(e.turns.value),
            tokens: Number(e.tokens.value),
            updatedMs: Number(e.updatedMs.value),
            messages: parseJson(e.messages.value, []),
            metrics: parseJson(e.metrics.value, []),
          })),
        };
      })();
      listCache = { at: Date.now(), promise };
      promise.catch(() => (listCache = null));
      return promise;
    },
  };
}

// Drops the oldest messages and metrics until both fit in one entity.
function fit(messages, metrics) {
  let m = messages, k = metrics, trimmed = false;
  const encode = () => [stringToBytes(JSON.stringify(m)), stringToBytes(JSON.stringify(k))];
  let [a, b] = encode();
  while (a.length + b.length > MAX_PAYLOAD && (m.length > 1 || k.length > 1)) {
    if (m.length > 1 && (a.length >= b.length || k.length <= 1)) m = m.slice(1);
    else k = k.slice(1);
    trimmed = true;
    [a, b] = encode();
  }
  if (a.length + b.length > MAX_PAYLOAD) {
    // One message on its own is too big: keep its end.
    const last = m.at(-1);
    m = [{ ...last, content: "…" + last.content.slice(-(MAX_PAYLOAD / 4)) }];
    trimmed = true;
    [a, b] = encode();
  }
  return { messages: bytes(a), metrics: bytes(b), trimmed };
}

function parseJson(hex, fallback) {
  try {
    return JSON.parse(hexToString(hex));
  } catch {
    return fallback;
  }
}

// The SDK wraps RPC errors several times over ("Execution error without
// revert data"); the useful part, like "insufficient funds", is at the bottom.
export function describeError(err) {
  let e = err, message = err?.shortMessage ?? err?.message ?? String(err);
  while (e?.cause) {
    e = e.cause;
    message = e.details ?? e.shortMessage ?? e.message ?? message;
  }
  message = String(message).split("\n")[0];
  if (/insufficient funds/i.test(message)) message += " (fund the saver wallet at https://hub.arkiv.network/faucet)";
  return message;
}
