/**
 * Lossless JSON for ATProto records.
 *
 * `JSON.parse` turns every number into a float64, so an integer beyond
 * 2^53 (the data model allows 64-bit signed integers) comes back rounded.
 * This parser keeps integers outside the safe range as `LosslessNumber`
 * holding the exact source digits, keeps object key order as received,
 * and `stringifyLossless` writes the same compact JSON back. Objects have a
 * null prototype and own data properties only, so a `__proto__` key is kept
 * as data and no field can be inherited. `$bytes` and
 * `$link` objects are ordinary objects here — they round-trip as-is.
 *
 * Limitation: keys that look like array indices ("0", "17") are reordered
 * by JS objects. Lexicon field names never take that form.
 */

export class LosslessNumber {
    constructor(readonly raw: string) {}
    toJSON(): string {
        return this.raw;
    }
}

export function parseLossless(text: string): unknown {
    let i = 0;
    const fail = (what: string): never => {
        throw new SyntaxError(`invalid JSON at ${i}: ${what}`);
    };
    const ws = () => {
        while (i < text.length && (text[i] === " " || text[i] === "\n" || text[i] === "\r" || text[i] === "\t")) i++;
    };
    const value = (): unknown => {
        ws();
        const c = text[i];
        if (c === "{") {
            i++;
            // Null prototype + defineProperty: a "__proto__" key is data,
            // and nothing is inherited (no Object.prototype members either).
            const obj: Record<string, unknown> = Object.create(null);
            ws();
            if (text[i] === "}") {
                i++;
                return obj;
            }
            for (;;) {
                ws();
                if (text[i] !== '"') fail("expected key");
                const k = str();
                ws();
                if (text[i] !== ":") fail("expected ':'");
                i++;
                Object.defineProperty(obj, k, { value: value(), enumerable: true, writable: true, configurable: true });
                ws();
                if (text[i] === ",") { i++; continue; }
                if (text[i] === "}") { i++; return obj; }
                fail("expected ',' or '}'");
            }
        }
        if (c === "[") {
            i++;
            const arr: unknown[] = [];
            ws();
            if (text[i] === "]") {
                i++;
                return arr;
            }
            for (;;) {
                arr.push(value());
                ws();
                if (text[i] === ",") { i++; continue; }
                if (text[i] === "]") { i++; return arr; }
                fail("expected ',' or ']'");
            }
        }
        if (c === '"') return str();
        if (text.startsWith("true", i)) { i += 4; return true; }
        if (text.startsWith("false", i)) { i += 5; return false; }
        if (text.startsWith("null", i)) { i += 4; return null; }
        const m = /^-?(0|[1-9]\d*)(\.\d+)?([eE][+-]?\d+)?/.exec(text.slice(i, i + 400));
        if (!m) fail("unexpected token");
        const raw = m![0];
        i += raw.length;
        const n = Number(raw);
        // exact when it is an integer in the safe range, or a non-integer
        // whose shortest form is the source text
        if ((Number.isSafeInteger(n) && !m![2] && !m![3]) || String(n) === raw) return n;
        return new LosslessNumber(raw);
    };
    const str = (): string => {
        // text[i] === '"'
        const start = i;
        i++;
        let simple = true;
        while (i < text.length && text[i] !== '"') {
            if (text[i] === "\\") {
                simple = false;
                i += 2;
            } else {
                if (text.charCodeAt(i) < 0x20) fail("control character in string");
                i++;
            }
        }
        if (i >= text.length) fail("unterminated string");
        i++;
        const lit = text.slice(start, i);
        return simple ? lit.slice(1, -1) : (JSON.parse(lit) as string);
    };
    const v = value();
    ws();
    if (i !== text.length) fail("trailing data");
    return v;
}

export function stringifyLossless(v: unknown): string {
    if (v instanceof LosslessNumber) return v.raw;
    if (v === null) return "null";
    if (Array.isArray(v)) return "[" + v.map(stringifyLossless).join(",") + "]";
    switch (typeof v) {
        case "string":
            return JSON.stringify(v);
        case "number":
            if (!Number.isFinite(v)) throw new TypeError("non-finite number");
            return JSON.stringify(v);
        case "boolean":
            return v ? "true" : "false";
        case "object":
            return "{" + Object.entries(v as Record<string, unknown>)
                .filter(([, x]) => x !== undefined)
                .map(([k, x]) => JSON.stringify(k) + ":" + stringifyLossless(x))
                .join(",") + "}";
    }
    throw new TypeError(`cannot encode ${typeof v}`);
}
