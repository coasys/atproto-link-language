// The one place the mounted reader's LDK location is decided, for both
// mount-build.mjs and mount-typecheck.mjs: MOUNT_LDK_ENTRY (the compiled
// lib/index.js of the Acorn-stack LDK), else the pinned spike checkout
// layout ../ad4m-acorn. tsconfig.mount.json names that same default for
// editors; the typecheck script overrides it from here.
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";

export const HERE = dirname(fileURLToPath(import.meta.url));
export const DEFAULT_LDK_ENTRY = "../ad4m-acorn/ad4m-ldk/js/lib/index.js";

/** Absolute path of the LDK's lib/index.js; exits when it is missing or
 *  has no mount capability. */
export function ldkEntry(tool) {
  const ldk = resolve(HERE, process.env.MOUNT_LDK_ENTRY || DEFAULT_LDK_ENTRY);
  if (!existsSync(ldk)) {
    console.error(`${tool}: no LDK at ${ldk} (set MOUNT_LDK_ENTRY)`);
    process.exit(1);
  }
  if (!readFileSync(join(dirname(ldk), "defineLanguage.js"), "utf8").includes("mountSnapshot")) {
    console.error(`${tool}: ${ldk} has no mount capability — use the Acorn-stack LDK`);
    process.exit(1);
  }
  return ldk;
}
