// Controlled ATProto network for the live acceptance: an in-process PLC
// directory + PDS (@atproto/dev-env TestNetworkNoAppView — no docker, no
// Postgres, never a production host), two fresh test accounts, and an env
// file the live test reads. Runs until SIGTERM/SIGINT, then closes both.
//
//   PLC_PORT=47101 PDS_PORT=47102 ENV_OUT=live/.run/pds.json node live/pds.mjs
//
// Slice 2 harness (only with CONTROL_PORT set; slice 1 runs without it):
//  - a control server on 127.0.0.1:CONTROL_PORT:
//      GET  /log                  every PDS request so far: {t, method, path,
//                                 repo, collection, rkey, status, dropped}
//      POST /arm?kind=commitThenDrop  the next createRecord is processed
//                                 (committed) but its reply is never sent —
//                                 a timeout after the request was sent
//  - SECRETS_OUT (mode 0600, in the run dir, outside the executor's data
//    dir): every OAuth token the PDS issued, every PKCE verifier and DPoP
//    public key it saw, so the live test can scan the executor's data dir
//    and log for them. Test infrastructure of a throwaway local PDS only.
//
// Needs Node >= 22 (dev-env's engines).
import { TestNetworkNoAppView } from "@atproto/dev-env";
import { mkdirSync, writeFileSync } from "node:fs";
import http from "node:http";
import { dirname } from "node:path";
import { randomBytes } from "node:crypto";

const PLC_PORT = Number(process.env.PLC_PORT || 47101);
const PDS_PORT = Number(process.env.PDS_PORT || 47102);
const ENV_OUT = process.env.ENV_OUT || "live/.run/pds.json";

const network = await TestNetworkNoAppView.create({
  plc: { port: PLC_PORT },
  pds: { port: PDS_PORT, hostname: "localhost" },
});
const pdsUrl = network.pds.url;
const plcUrl = network.plc.url;

async function xrpc(method, body, token) {
  const res = await fetch(`${pdsUrl}/xrpc/${method}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${method} -> ${res.status}: ${text}`);
  return JSON.parse(text);
}

// Two distinct accounts. Passwords are random per run and only ever
// written to the env file the test reads — never to the language.
const accounts = [];
for (const name of ["alice", "bob"]) {
  const password = randomBytes(12).toString("hex");
  const handle = `${name}-${randomBytes(3).toString("hex")}.test`;
  const r = await xrpc("com.atproto.server.createAccount", {
    email: `${handle}@example.invalid`,
    handle,
    password,
  });
  accounts.push({ name, did: r.did, handle: r.handle, password });
}

mkdirSync(dirname(ENV_OUT), { recursive: true });
writeFileSync(
  ENV_OUT,
  JSON.stringify({ plcUrl, pdsUrl, accounts, pid: process.pid }, null, 2),
  { mode: 0o600 }
);
console.log(`pds: plc ${plcUrl} pds ${pdsUrl}`);
for (const a of accounts) console.log(`pds: ${a.name} ${a.did} ${a.handle}`);
console.log("pds: ready");

const CONTROL_PORT = Number(process.env.CONTROL_PORT || 0);
const SECRETS_OUT = process.env.SECRETS_OUT || "";
if (CONTROL_PORT) {
  const log = [];
  let armed = null;
  const secrets = { accessTokens: [], refreshTokens: [], verifiers: [], dpopPublic: [], scopes: [] };
  const saveSecrets = () => SECRETS_OUT && writeFileSync(SECRETS_OUT, JSON.stringify(secrets, null, 2), { mode: 0o600 });
  const add = (list, v) => typeof v === "string" && v && !list.includes(v) && list.push(v);
  const server = network.pds.server.server;
  const listeners = server.listeners("request");
  server.removeAllListeners("request");
  server.on("request", (req, res) => {
    const u = new URL(req.url, pdsUrl);
    const entry = {
      t: Date.now(), method: req.method, path: u.pathname,
      repo: u.searchParams.get("repo") ?? undefined, collection: u.searchParams.get("collection") ?? undefined,
    };
    log.push(entry);
    // tap the body without changing how the PDS consumes it
    const chunks = [];
    const emit = req.emit;
    req.emit = function (ev, chunk, ...rest) {
      if (ev === "data") chunks.push(Buffer.from(chunk));
      if (ev === "end") {
        const body = Buffer.concat(chunks).toString();
        if (u.pathname === "/xrpc/com.atproto.repo.createRecord") {
          try {
            const j = JSON.parse(body);
            Object.assign(entry, { repo: j.repo, collection: j.collection, rkey: j.rkey });
          } catch {}
        }
        if (u.pathname === "/oauth/token") {
          add(secrets.verifiers, new URLSearchParams(body).get("code_verifier"));
          saveSecrets();
        }
      }
      return emit.call(this, ev, chunk, ...rest);
    };
    const proof = req.headers["dpop"];
    if (typeof proof === "string") {
      try {
        const { jwk } = JSON.parse(Buffer.from(proof.split(".")[0], "base64url").toString());
        if (jwk && !secrets.dpopPublic.some((k) => k.x === jwk.x)) {
          secrets.dpopPublic.push({ x: jwk.x, y: jwk.y });
          saveSecrets();
        }
      } catch {}
    }
    const end = res.end;
    if (u.pathname === "/oauth/token") {
      // an uncompressed reply, so the capture below can read it (the live
      // test asserts tokens were captured: the scan is not vacuous)
      delete req.headers["accept-encoding"];
      res.end = function (chunk, ...rest) {
        try {
          const j = JSON.parse(Buffer.from(chunk ?? "").toString());
          add(secrets.accessTokens, j.access_token);
          add(secrets.refreshTokens, j.refresh_token);
          add(secrets.scopes, j.scope);
          saveSecrets();
        } catch {}
        return end.call(this, chunk, ...rest);
      };
    }
    if (armed === "commitThenDrop" && req.method === "POST" && u.pathname === "/xrpc/com.atproto.repo.createRecord") {
      armed = null;
      entry.dropped = true;
      // The PDS handles (and commits) the request; its reply never leaves.
      res.writeHead = function () { return this; };
      res.write = function () { return true; };
      res.end = function (chunk) {
        entry.status = this.statusCode;
        try { entry.reply = JSON.parse(Buffer.from(chunk ?? "").toString()); } catch {}
        return this;
      };
    } else {
      res.on("finish", () => (entry.status = res.statusCode));
    }
    for (const l of listeners) l.call(server, req, res);
  });
  http.createServer((req, res) => {
    const u = new URL(req.url, "http://127.0.0.1");
    res.setHeader("content-type", "application/json");
    if (req.method === "GET" && u.pathname === "/log") return res.end(JSON.stringify(log));
    if (req.method === "POST" && u.pathname === "/arm") {
      armed = u.searchParams.get("kind");
      return res.end(JSON.stringify({ armed }));
    }
    res.statusCode = 404;
    res.end("{}");
  }).listen(CONTROL_PORT, "127.0.0.1");
  saveSecrets();
  console.log(`pds: control on 127.0.0.1:${CONTROL_PORT}`);
}

let closing = false;
async function shutdown() {
  if (closing) return;
  closing = true;
  console.log("pds: closing");
  try {
    await network.close();
  } finally {
    process.exit(0);
  }
}
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
setInterval(() => {}, 1 << 30);
