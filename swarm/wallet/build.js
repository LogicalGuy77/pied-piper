// Bundles the wallet card (main.jsx, with React and Privy) to
// swarm/web/dist/wallet.js and the chunks it loads, for the phone page.
//
//   cd swarm && npm run build

import { build } from "esbuild";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));

// Privy's Solana features import optional packages we don't install; the
// wallet is Ethereum only, so they resolve to an empty CommonJS module.
const noSolana = {
  name: "no-solana",
  setup(b) {
    b.onResolve({ filter: /^@solana(-program)?\// }, (args) => ({ path: args.path, namespace: "no-solana" }));
    b.onLoad({ filter: /.*/, namespace: "no-solana" }, () => ({ contents: "module.exports = {};", loader: "js" }));
  },
};

await build({
  plugins: [noSolana],
  entryPoints: [join(HERE, "main.jsx")],
  entryNames: "wallet",
  outdir: join(HERE, "..", "web", "dist"),
  bundle: true,
  format: "esm",
  splitting: true, // Privy, most of the bundle, loads only when there is a Privy app
  jsx: "automatic",
  target: "es2022",
  minify: true,
  define: { "process.env.NODE_ENV": '"production"', global: "globalThis" },
  logLevel: "info",
});
