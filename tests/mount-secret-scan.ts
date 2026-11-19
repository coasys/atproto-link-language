/**
 * Files under `paths` that contain any of `secrets` (grep -rlaF). Only grep's
 * exit 1 counts as "no match"; any other failure throws.
 */
import { execFileSync } from "node:child_process";

export function secretHits(secrets: string[], paths: string[]): string[] {
    const hits: string[] = [];
    for (const s of secrets) {
        try {
            const out = execFileSync("grep", ["-rlaF", s, ...paths], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
            hits.push(...out.trim().split("\n").filter(Boolean));
        } catch (e) {
            // grep exits 1 on no match; anything else (2: missing or
            // unreadable path, no grep at all) means nothing was checked
            const status = (e as { status?: number | null }).status;
            if (status === 1) continue;
            throw new Error(`grep failed (status ${status ?? "none"}): ${String((e as { stderr?: unknown }).stderr ?? (e as Error).message).trim()}`);
        }
    }
    return hits;
}
