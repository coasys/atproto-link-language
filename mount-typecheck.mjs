// Typechecks the mounted reader against the same LDK mount-build.mjs bundles
// (MOUNT_LDK_ENTRY, see mount-ldk.mjs): writes a throwaway tsconfig that
// extends tsconfig.mount.json with the resolved `paths`, runs tsc, removes it.
import { spawnSync } from "node:child_process";
import { writeFileSync, rmSync, existsSync } from "node:fs";
import { join, relative } from "node:path";
import { HERE, ldkEntry } from "./mount-ldk.mjs";

const ldk = ldkEntry("mount-typecheck");
const dts = ldk.replace(/\.js$/, ".d.ts");
if (!existsSync(dts)) {
  console.error(`mount-typecheck: no type declarations at ${dts}`);
  process.exit(1);
}
const cfg = join(HERE, ".tsconfig.mount.resolved.json");
writeFileSync(cfg, JSON.stringify({
  extends: "./tsconfig.mount.json",
  compilerOptions: { paths: { "@coasys/ad4m-ldk": ["./" + relative(HERE, dts)] } },
}, null, 2));
const tsc = spawnSync(process.execPath, [join(HERE, "node_modules", "typescript", "bin", "tsc"), "--noEmit", "-p", cfg], { stdio: "inherit" });
rmSync(cfg, { force: true });
console.log(`mount-typecheck: LDK ${dts}: ${tsc.status === 0 ? "ok" : "failed"}`);
process.exit(tsc.status ?? 1);
