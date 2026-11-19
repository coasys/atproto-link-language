/**
 * The live test's credential scan (P3): only grep's exit 1 means "no match";
 * an error (exit 2: unreadable or missing path, bad grep) must fail the scan.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { secretHits } from "./mount-secret-scan.js";

describe("P3: credential scan", () => {
    const dir = mkdtempSync(join(tmpdir(), "secret-scan-"));
    writeFileSync(join(dir, "log"), "token=abc123secret\n");

    it("finds a secret and reports no hit for an absent one", () => {
        assert.deepEqual(secretHits(["abc123secret"], [dir]), [join(dir, "log")]);
        assert.deepEqual(secretHits(["not-there"], [dir]), []);
    });

    it("a missing path is an error, not 'no hits'", () => {
        assert.throws(() => secretHits(["not-there"], [join(dir, "missing")]), /grep/);
    });
});
