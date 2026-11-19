// Controlled ATProto network for the live acceptance: an in-process PLC
// directory + PDS (@atproto/dev-env TestNetworkNoAppView — no docker, no
// Postgres, never a production host), two fresh test accounts, and an env
// file the live test reads. Runs until SIGTERM/SIGINT, then closes both.
//
//   PLC_PORT=47101 PDS_PORT=47102 ENV_OUT=live/.run/pds.json node live/pds.mjs
//
// Needs Node >= 22 (dev-env's engines).
import { TestNetworkNoAppView } from "@atproto/dev-env";
import { mkdirSync, writeFileSync } from "node:fs";
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
