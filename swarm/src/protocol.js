// Wire format between phones and the tracker.
//
// Control messages are small JSON text frames: hello, welcome, ready, ask,
// session, reroute, end, drop, fail, error, stats, swarm, and watch/state
// for the dashboard.
//
// Data messages are binary frames, a 16-byte little-endian header and a raw payload:
//
//   offset 0  u8   kind     TOKENS, HIDDEN or NEXT
//          1  u8   hop      index of the receiver in the session's route;
//                           hop === route.length means "back to the asker"
//          2  u16  attempt  bumped each time the session is rerouted; frames
//                           from an older attempt are ignored
//          4  u32  session  id from the tracker
//          8  u32  pos      position of the first token in the session
//         12  u32  n        number of tokens
//         16  payload       TOKENS, NEXT: int32[n] token ids
//                           HIDDEN:       float32[n * d], the h between blocks
//
// The header is 16 bytes so the payload stays 4-byte aligned and can be read
// in place, without a copy.

export const KIND = { TOKENS: 1, HIDDEN: 2, NEXT: 3 };
export const HEADER_BYTES = 16;

export function encodeFrame({ kind, hop, attempt = 0, session, pos, n }, payload) {
  const body = new Uint8Array(payload.buffer, payload.byteOffset, payload.byteLength);
  const buf = new ArrayBuffer(HEADER_BYTES + body.byteLength);
  const v = new DataView(buf);
  v.setUint8(0, kind);
  v.setUint8(1, hop);
  v.setUint16(2, attempt, true);
  v.setUint32(4, session, true);
  v.setUint32(8, pos, true);
  v.setUint32(12, n, true);
  new Uint8Array(buf, HEADER_BYTES).set(body);
  return buf;
}

// Reads only the header. `bytes` is an ArrayBuffer or any typed-array view,
// such as a Node Buffer on the tracker.
export function readHeader(bytes) {
  const b = bytes instanceof ArrayBuffer ? new Uint8Array(bytes) : new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (b.byteLength < HEADER_BYTES) throw new Error(`frame of ${b.byteLength} bytes is shorter than the header`);
  const v = new DataView(b.buffer, b.byteOffset, HEADER_BYTES);
  return {
    kind: v.getUint8(0), hop: v.getUint8(1), attempt: v.getUint16(2, true),
    session: v.getUint32(4, true), pos: v.getUint32(8, true), n: v.getUint32(12, true),
  };
}

export function decodeFrame(buf) {
  const header = readHeader(buf);
  const bytes = buf.byteLength - HEADER_BYTES;
  let payload;
  if (header.kind === KIND.HIDDEN) payload = new Float32Array(buf, HEADER_BYTES, bytes / 4);
  else if (header.kind === KIND.TOKENS || header.kind === KIND.NEXT) payload = new Int32Array(buf, HEADER_BYTES, bytes / 4);
  else throw new Error(`unknown frame kind ${header.kind}`);
  if (header.kind !== KIND.HIDDEN && payload.length !== header.n) {
    throw new Error(`frame says ${header.n} tokens but carries ${payload.length}`);
  }
  return { ...header, payload };
}
