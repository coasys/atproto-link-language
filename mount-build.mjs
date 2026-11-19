// Builds build/mount/bundle.js: the mounted reader (mount-index.ts) as one
// ESM bundle with `ad4m:host` external and the template-variable banner on
// top, so `language.applyTemplateLocal` can rewrite each value in place
// (the marker line must sit directly above its `const`; esbuild never
// sees these names, so it cannot rename or inline them).
//
//   node mount-build.mjs
//   MOUNT_LDK_ENTRY=<ad4m acorn checkout>/ad4m-ldk/js/lib/index.js node mount-build.mjs
//
// The LDK must come from the Acorn A-step stack (its defineLanguage has the
// `mount` capability); plain dev's LDK silently drops `mount`.
import { build } from "esbuild";
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const LDK = resolve(HERE, process.env.MOUNT_LDK_ENTRY || "../ad4m-acorn/ad4m-ldk/js/lib/index.js");
if (!existsSync(LDK)) {
  console.error(`mount-build: no LDK at ${LDK} (set MOUNT_LDK_ENTRY)`);
  process.exit(1);
}
if (!readFileSync(join(dirname(LDK), "defineLanguage.js"), "utf8").includes("mountSnapshot")) {
  console.error(`mount-build: ${LDK} has no mount capability — use the Acorn-stack LDK`);
  process.exit(1);
}

const VARS = [
  ["ACCOUNTS", ""],
  ["PLC_URL", "https://plc.directory"],
  ["APPVIEW_URL", ""],
  ["POLL_MS", "60000"],
  ["ALLOW_HTTP", ""],
];
const BANNER = VARS.map(([k, v]) => `//!@ad4m-template-variable\nconst ${k} = ${JSON.stringify(v)};`).join("\n");

const out = join(HERE, "build", "mount", "bundle.js");
await build({
  entryPoints: [join(HERE, "mount-index.ts")],
  bundle: true,
  format: "esm",
  platform: "neutral",
  target: "es2022",
  external: ["ad4m:host"],
  alias: { "@coasys/ad4m-ldk": LDK },
  outfile: out,
  banner: { js: BANNER },
  charset: "ascii",
});

const src = readFileSync(out, "utf8");
const lines = src.split("\n");
VARS.forEach(([k], i) => {
  if (lines[2 * i] !== "//!@ad4m-template-variable" || !lines[2 * i + 1].startsWith(`const ${k} = `)) {
    console.error(`mount-build: banner line for ${k} is not where the templater looks`);
    process.exit(1);
  }
});
for (const forbidden of ["src/mst", "orset", "createSession", "app-password", "appPassword"]) {
  if (src.includes(forbidden)) {
    console.error(`mount-build: bundle unexpectedly contains "${forbidden}"`);
    process.exit(1);
  }
}
console.log(`mount-build: ${out} (${src.length} bytes, LDK ${LDK})`);
