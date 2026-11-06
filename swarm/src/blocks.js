// Where phones go. Pure functions of the block list and how many phones hold
// each block, shared by the tracker and the checks.
//
// A block is { start, end }: layers [start, end), plus the embedding if it
// starts at 0 and the output layer if it ends at the last layer. Blocks are
// in layer order and cover every layer.

// Splits the layers into k blocks of balanced memory: the least sum of
// squared block sizes, so no block is much bigger than the others. The
// embedding table weighs on both ends, because the first block looks tokens
// up in it and the last block reuses it as the output layer.
export function initialCut(manifest, k) {
  const L = manifest.config.num_layers;
  if (!(k >= 1 && k <= L)) throw new Error(`min blocks must be between 1 and ${L}, got ${k}`);
  const mb = (bytes) => bytes / 1e6;
  const prefix = [0];
  for (const layer of manifest.layers) prefix.push(prefix.at(-1) + mb(layer.bytes));
  const embed = mb(manifest.embed.bytes);
  const output = mb(manifest.final_norm.bytes + (manifest.lm_head?.bytes ?? 0));
  const size = (s, e) => prefix[e] - prefix[s] + (s === 0 || e === L ? embed : 0) + (e === L ? output : 0);

  // best[j][e]: the least cost of cutting layers [0, e) into j blocks.
  const best = Array.from({ length: k + 1 }, () => new Array(L + 1).fill(Infinity));
  const from = Array.from({ length: k + 1 }, () => new Array(L + 1).fill(-1));
  best[0][0] = 0;
  for (let j = 1; j <= k; j++) {
    for (let e = j; e <= L; e++) {
      for (let s = j - 1; s < e; s++) {
        const c = best[j - 1][s] + size(s, e) ** 2;
        if (c < best[j][e]) {
          best[j][e] = c;
          from[j][e] = s;
        }
      }
    }
  }
  const bounds = [L];
  for (let j = k, e = L; j > 0; j--) bounds.unshift((e = from[j][e]));
  return bounds;
}

// The compute of a block, in layers. The output layer is a vocab × hidden
// matmul, which costs as much as several layers (8 for SmolLM2-135M).
export function costModel(manifest) {
  const { hidden_size: d, vocab_size: vocab, num_layers: L } = manifest.config;
  const params = manifest.layers[0].tensors.reduce((sum, t) => sum + t.shape.reduce((a, b) => a * b, 1), 0);
  const outputLayers = (vocab * d) / params;
  return (b) => b.end - b.start + (b.end === L ? outputLayers : 0);
}

// Where to cut a block in two: the layer that splits its compute most evenly,
// with at least one layer on each side.
export function splitPoint(b, cost) {
  let best = -1, bestGap = Infinity;
  for (let m = b.start + 1; m < b.end; m++) {
    const gap = Math.abs(cost({ start: b.start, end: m }) - cost({ start: m, end: b.end }));
    if (gap < bestGap) {
      best = m;
      bestGap = gap;
    }
  }
  return best;
}

// The block with the most compute that can still be cut in two, or -1.
// Lowest index on a tie.
export function largestBlock(blocks, cost) {
  let best = -1;
  for (let i = 0; i < blocks.length; i++) {
    if (blocks[i].end - blocks[i].start < 2) continue;
    if (best < 0 || cost(blocks[i]) > cost(blocks[best])) best = i;
  }
  return best;
}

// Where a joining phone goes, given holders[i], the phones holding blocks[i]:
//
//   1. a block nobody holds, so the swarm has a whole path;
//   2. else a block with fewer than minReplica holders, so a phone leaving
//      doesn't cut answers;
//   3. else the largest block, as one more replica. The phone that brings it
//      to 2 × minReplica holders splits it in two instead, minReplica phones
//      per half, so each token takes less compute per phone.
//
// Fewest holders first, lowest index on a tie. Returns { block: i } or
// { split: i }.
export function placeJoin(blocks, holders, { minReplica, cost }) {
  const fewest = Math.min(...holders);
  if (fewest < minReplica) return { block: holders.indexOf(fewest) };
  const i = largestBlock(blocks, cost);
  if (i < 0) {
    // Nothing left to split: spread the compute.
    const load = blocks.map((b, k) => cost(b) / holders[k]);
    return { block: load.indexOf(Math.max(...load)) };
  }
  return holders[i] + 1 >= 2 * minReplica ? { split: i } : { block: i };
}

// After a phone leaves, one move that repairs the swarm, or null:
//
//   1. a block nobody holds takes a phone from the block with the most
//      holders, if that block can spare one;
//   2. else a block with fewer than minReplica holders takes one from a
//      block with more than minReplica.
//
// Blocks that were split stay split. Returns { from: i, to: j }.
export function repairMove(holders, minReplica) {
  const most = Math.max(...holders);
  const from = holders.indexOf(most);
  const empty = holders.indexOf(0);
  if (empty >= 0) return most >= 2 ? { from, to: empty } : null;
  const fewest = Math.min(...holders);
  if (fewest < minReplica && most > minReplica) return { from, to: holders.indexOf(fewest) };
  return null;
}
