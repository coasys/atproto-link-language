/**
 * Round 2, item 2, at the real host boundary: the executor's own storage
 * writes under SIGKILL, and the product bundle's fail-closed check.
 *
 *  - A probe language (live/crash-probe-language.js) rewrites an 8 MB file
 *    in a tight loop; the executor is SIGKILLed at a random moment; the
 *    file must be whole. Plain `writeStorageFile` (what the KV uses) can
 *    tear — recorded, not asserted (chance); `writeStorageFileAtomic` must
 *    never tear.
 *  - The built bundle refuses to publish on an executor without
 *    `writeStorageFileAtomic` (AD4M_EXECUTOR_PINNED, acorn a9 c9d4a8de1 as
 *    found), with no request; on AD4M_EXECUTOR it passes that check.
 *
 * Skipped unless MOUNT_LIVE=1. Needs AD4M_EXECUTOR (with the atomic write)
 * and, for the fail-closed part, AD4M_EXECUTOR_PINNED.
 */
import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import { spawn, execFileSync, type ChildProcess } from "node:child_process";
import { mkdtempSync, readFileSync, existsSync, mkdirSync, writeFileSync, openSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";

const LIVE = process.env.MOUNT_LIVE === "1";
const ROOT = fileURLToPath(new URL("..", import.meta.url));
const EXECUTOR = process.env.AD4M_EXECUTOR ?? "";
const PINNED = process.env.AD4M_EXECUTOR_PINNED ?? "";
const PORT = Number(process.env.AD4M_PORT ?? 47110);
const KILLS = Number(process.env.CRASH_KILLS ?? 6);
const RUN = process.env.LIVE_RUN_DIR ?? (LIVE ? mkdtempSync(join(tmpdir(), "atproto-s2-crash-")) : "");
const PASS = "crash-test-passphrase";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const evidence: Record<string, unknown> = {};
const record = (k: string, v: unknown) => {
    evidence[k] = v;
    if (RUN) writeFileSync(join(RUN, "evidence.json"), JSON.stringify(evidence, null, 2));
};

let proc: ChildProcess | null = null;
let ws: WebSocket | null = null;
let nextId = 1;
const waiting = new Map<string, (m: any) => void>();

async function waitFor(what: string, fn: () => Promise<boolean>, ms = 120000, step = 1000) {
    const t0 = Date.now();
    let last: unknown;
    while (Date.now() - t0 < ms) {
        try {
            if (await fn()) return;
        } catch (e) {
            last = e;
        }
        await sleep(step);
    }
    throw new Error(`${what} not ready (${(last as Error)?.message ?? ""})`);
}

function rpc(type: string, params: Record<string, unknown> = {}, ms = 120000): Promise<any> {
    return new Promise((res, rej) => {
        const id = String(nextId++);
        const t = setTimeout(() => rej(new Error(`${type} timed out`)), ms);
        waiting.set(id, (m) => {
            clearTimeout(t);
            m.error ? rej(new Error(`${type}: ${JSON.stringify(m.error)}`)) : res(m.result);
        });
        ws!.send(JSON.stringify({ id, type, params }));
    });
}
async function interact(url: string, name: string, params: unknown = {}, ms = 120000) {
    const r = await rpc("expression.interact", { url, interactionCall: { name, parametersStringified: JSON.stringify(params) } }, ms);
    try {
        return JSON.parse(r);
    } catch {
        return r;
    }
}

async function start(exe: string, data: string, first: boolean) {
    if (first) {
        mkdirSync(data, { recursive: true });
        execFileSync(exe, ["init", "-d", data], { stdio: "ignore" });
    }
    const log = openSync(join(data, "..", "executor.log"), "a");
    proc = spawn(exe, ["run", "-a", data, "--port", String(PORT), "--localhost", "true", "--insecure-no-admin-credential",
        "--hc-use-proxy", "false", "--hc-use-bootstrap", "false", "--hc-use-mdns", "false",
        "--hc-admin-port", String(PORT + 1), "--hc-app-port", String(PORT + 2), "--run-dapp-server", "false",
        "--enable-mcp", "false", "--exit-with-parent", "true"], { stdio: ["ignore", log, log], env: { ...process.env, RUST_LOG: "info" } });
    await waitFor("health", async () => (await fetch(`http://127.0.0.1:${PORT}/health`)).ok);
    ws = new WebSocket(`ws://127.0.0.1:${PORT}/api/v1/ws`);
    ws.onmessage = (ev) => {
        const m = JSON.parse(String(ev.data));
        waiting.get(m.id)?.(m);
        waiting.delete(m.id);
    };
    await new Promise<void>((r, j) => {
        ws!.onopen = () => r();
        ws!.onerror = () => j(new Error("ws"));
    });
    const st = await rpc("agent.status");
    if (!st.isInitialized) await rpc("agent.generate", { passphrase: PASS }, 300000);
    else if (!st.isUnlocked) await rpc("agent.unlock", { passphrase: PASS }, 300000);
}

async function stop(signal: NodeJS.Signals) {
    ws?.close();
    ws = null;
    if (!proc || proc.exitCode !== null) return;
    proc.kill(signal);
    for (let i = 0; i < 40 && proc.exitCode === null && proc.signalCode === null; i++) await sleep(250);
    if (proc.exitCode === null && proc.signalCode === null) proc.kill("SIGKILL");
    await sleep(1000);
}

const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
function b58(bytes: Buffer) {
    const d = [0];
    for (const by of bytes) {
        let c = by;
        for (let i = 0; i < d.length; i++) {
            const x = (d[i] << 8) + c;
            d[i] = x % 58;
            c = (x / 58) | 0;
        }
        while (c) {
            d.push(c % 58);
            c = (c / 58) | 0;
        }
    }
    let o = "";
    for (const by of bytes) {
        if (by === 0) o += "1";
        else break;
    }
    return o + d.reverse().map((x) => B58[x]).join("");
}
function install(data: string, file: string, name: string): string {
    const src = readFileSync(file, "utf8");
    const addr = "Qmz" + b58(Buffer.concat([Buffer.from([1, 0, 0x12, 0x20]), createHash("sha256").update(src).digest()]));
    const dir = join(data, "ad4m", "languages", addr);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "bundle.js"), src);
    writeFileSync(join(dir, "meta.json"), JSON.stringify({ name }));
    return addr;
}

/** whole = parses and its pad is as long as it says */
function inspect(path: string): { whole: boolean; i?: number; bytes: number } {
    if (!existsSync(path)) return { whole: false, bytes: -1 };
    const text = readFileSync(path, "utf8");
    try {
        const j = JSON.parse(text);
        return { whole: typeof j.pad === "string" && j.pad.length === j.size, i: j.i, bytes: text.length };
    } catch {
        return { whole: false, bytes: text.length };
    }
}

describe("host storage writes under SIGKILL, and fail-closed publishing", { skip: !LIVE && "set MOUNT_LIVE=1 (needs AD4M_EXECUTOR)" }, () => {
    after(async () => {
        await stop("SIGTERM");
    });

    for (const mode of ["plain", "atomic"] as const) {
        it(`${mode}: ${KILLS} SIGKILLs during an 8 MB rewrite loop`, async () => {
            const data = join(RUN, `crash-${mode}`, "executor");
            const probe = join(ROOT, "live", "crash-probe-language.js");
            const results: Array<{ killAfterMs: number; whole: boolean; i?: number; bytes: number; temps: number }> = [];
            let path = "";
            for (let k = 0; k < KILLS; k++) {
                await start(EXECUTOR, data, k === 0);
                const L = install(data, probe, "crash-probe");
                let where: any;
                await waitFor("probe loaded", async () => !!(where = await interact(`${L}://project`, "where")), 120000, 1000);
                assert.equal(where.atomic, true, "this executor offers writeStorageFileAtomic");
                path = `${String(where.dir).replace(/\/+$/, "")}/crash-probe.json`;
                interact(`${L}://project`, "rewrite", { mode, ms: 30000, kb: 8192 }, 60000).catch(() => {});
                const killAfterMs = 1500 + Math.floor(Math.random() * 2500);
                await sleep(killAfterMs);
                await stop("SIGKILL");
                const dir = String(where.dir);
                const temps = existsSync(dir) ? readdirSync(dir).filter((n) => n.startsWith("crash-probe.json.tmp-")).length : 0;
                results.push({ killAfterMs, ...inspect(path), temps });
            }
            record(mode, results);
            const torn = results.filter((r) => !r.whole).length;
            if (mode === "plain") {
                // the hazard, recorded, not asserted: whether a kill lands in
                // the truncate-then-write window is a matter of chance
                record("plainTorn", torn);
            } else {
                assert.equal(torn, 0, `atomic rewrite never tears: ${JSON.stringify(results)}`);
            }
        });
    }

    it("the built bundle refuses to publish on an executor without the atomic write; with it, that check passes", async () => {
        const bundle = join(ROOT, "build", "mount", "bundle.js");
        assert.ok(existsSync(bundle), "build the bundle first");
        const did = "did:plc:abcdefghijklmnopqrstuvwx";
        const out: Record<string, string> = {};
        for (const [label, exe] of [["pinned-without-atomic", PINNED], ["with-atomic", EXECUTOR]] as const) {
            if (!exe) continue;
            const data = join(RUN, `failclosed-${label}`, "executor");
            await start(exe, data, true);
            const base = install(data, bundle, "atproto-mounted-reader");
            const templ = { ACCOUNTS: did, PLC_URL: "http://127.0.0.1:9", APPVIEW_URL: "", POLL_MS: "3600000", ALLOW_HTTP: "1" };
            const L = (await rpc("language.applyTemplateLocal", { sourceLanguageHash: base, templateData: JSON.stringify(templ) }, 300000)).address;
            await waitFor("bundle loaded", async () => !!(await interact(`${L}://project`, "status")), 120000, 2000);
            const err = await interact(`${L}://class/ATPost`, "publish", { text: "hi", atAuthor: did, publicationKey: "failclosed-1" }).then(
                () => "no error", (e: Error) => e.message);
            out[label] = err;
            await stop("SIGTERM");
        }
        record("failClosed", out);
        assert.ok(PINNED, "AD4M_EXECUTOR_PINNED must name the executor without the atomic write");
        assert.match(out["pinned-without-atomic"], /no atomic durable storage write/);
        assert.match(out["with-atomic"], /not authorized/, "with the atomic write the next check (session) is reached");
    });
});
