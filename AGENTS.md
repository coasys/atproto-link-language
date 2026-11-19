# AGENTS.md — atproto-link-language

AD4M link language that stores a Perspective on the **AT Protocol** by riding each
repo's **Merkle Search Tree (MST) commit chain**, unioning across repos, and
projecting links as **`app.bsky.feed.post` records** so Bluesky renders them as
posts.

## Architecture (the load-bearing idea)

Two roles, kept strictly separate:

- **Role A — convergence substrate (source of truth).** Each agent's AT Proto
  repo is an MST with a signed **commit chain** (native authority per repo). The
  neighbourhood state is a **cross-repo OR-Set union** keyed by link hash over all
  members' commit chains.
- **Role B — native projection (derived).** A SHACL-driven transform writes
  Role-A links as `app.bsky.feed.post` records.

Invariants — do not break these:

- `currentRevision()` is a **content hash of the commit-chain head CID(s)** — the
  head commit CID for a single repo, else a deterministic digest of the sorted
  per-repo head CIDs. **Never** a firehose sequence number, a `rev` timestamp, or
  a record count.
- Merge is per-repo **MST commit authority** + a **cross-repo OR-Set union** for
  the neighbourhood; removals carry the original link hash.
- Sync follows commit chains + MST diffs; the local cache is rebuilt from
  commits, never authoritative.
- The projection is a **pure fold of Role A, never read back to rebuild the DAG**.
  Genuinely native-authored posts whose author has **no AD4M DID** are
  echo-suppressed and ingested as new Role-A links.

## Channel-B projection (shared, verbatim)

`src/projection/` is a **protocol-agnostic SHACL→native transformer copied
verbatim** across all Channel-B languages (matrix, nostr, atproto, solid, ap):
`bridge.ts`, `expression.ts`, `index.ts`, `literal.ts`, `profile.ts`,
`project.ts`, `types.ts`. **Do not edit it in isolation** — mirror any change to
every Channel-B repo or the copies drift (asserted identical by diff). A
`NodeShape` annotated `projection://nativeType` selects the native body property;
`projection://field` marks projected properties. `src/atproto-projection.ts` is
the thin per-protocol `NativeAdapter` mapping to/from an `app.bsky.feed.post`.

## Layout

- `src/mst.ts` — Merkle Search Tree model, commit chain, MST diff.
- `src/cid.ts` — dag-cbor encoding + CIDv1 commit-CID.
- `src/orset.ts` — cross-repo OR-Set union keyed by link hash.
- `src/lexicon.ts` — AT Proto lexicon record definitions.
- `src/xrpc.ts` — XRPC client calls (com.atproto / app.bsky).
- `src/auth.ts` — PDS session auth.
- `src/atproto-projection.ts` — the `app.bsky.feed.post` `NativeAdapter` (Channel B).
- `src/projection/` — the shared SHACL transformer (see above).
- `src/rendering.ts` — link → post body rendering helpers.
- `src/sync.ts` — commit-chain head tracking → MST diff → cross-repo fold → diff.
- `src/translate.ts` — link ↔ record translation.
- `src/store.ts` — derived link cache + query indexes.
- `src/{settings,types}.ts` — settings + shared types.
- `src/adapters.ts` / `src/adapters-deno.ts` — injected adapters; `ad4m:host`
  confined to `adapters-deno.ts` + `index.ts`.

## Build / test / typecheck

```bash
NODE_ENV=development pnpm install     # NODE_ENV=production skips devDeps — installs look broken
deno run --allow-all esbuild.ts       # bundle → build/ (needs @coasys/ad4m-ldk at ../ad4m/ad4m-ldk/js or AD4M_LDK_ENTRY)
npx tsc --noEmit                      # typecheck — the ONLY type gate; tsx/esbuild transpile without checking
node --experimental-vm-modules --import tsx --test tests/*.test.ts   # full suite
```

ESM imports use explicit `.js` extensions even for `.ts` sources. `npm test`
summary lines are `ℹ tests N` / `ℹ pass N` / `ℹ fail N`.

## What's unit-tested vs what needs a live backend

Hermetic: MST model + commit-CID, cross-repo OR-Set union, revision stability,
and the projection (`app.bsky.feed.post` payload shape + echo-suppressed ingest)
against in-memory fixtures. **Not** in CI: a live PDS round-trip and **live
rendering in Bluesky**.

## Gotchas

- **The executor discards `sync()`'s return value.** `Language::sync()` runs the
  handler purely for side effects; a folded peer delta becomes queryable via
  `perspective.queryLinks` **only** when pushed through the host's
  `emitPerspectiveDiff` channel. Folding into the local store keeps `render()` /
  `currentRevision()` correct but leaves peer links invisible to the executor's
  perspective — a silent add-freeze under multi-agent convergence. Both `init()`
  and the sync handler route through `foldAndEmit` (`src/sync.ts`), the single
  seam that folds **and** emits; keep it that way. Regression-guarded in
  `tests/sync.test.ts`.
- The AT Proto firehose is one-way, so there is no telepresence channel — do not
  claim presence support.
- `src/projection/` is shared — edit here and propagate, never fork.
- **Channel-B post rkeys must be bare TIDs.** `app.bsky.feed.post`'s Lexicon pins
  `key: tid`, so a modern PDS (`@atproto/pds` ≥ 0.5.x) rejects any non-TID record
  key with `InvalidRequest: Invalid record key for app.bsky.feed.post: Invalid
  TID string`. `projectPostsRoleB` therefore keys projections with a bare
  `tidNow()` — never a prefixed/derived string. Older 0.4.x PDS builds did not
  enforce this, which is why the defect went unseen until a live round-trip on a
  current PDS. Regression-guarded in `tests/xrpc.test.ts` (TID grammar
  `/^[234567abcdefghij][234567a-z]{12}$/`). Verified live: the projected record
  is written via `applyWrites#create` and read back natively via
  `com.atproto.repo.getRecord` / `listRecords` as a clean post (no ad4m envelope).

## Mounted reader (spike, `spike/mounted-reader`; publication: `spike/mounted-reader-s2`)

A second, independent entry point: `mount-index.ts`, read-only except for
the explicit publication below. It does
not touch `index.ts`, Role A/B, `src/mst.ts`, the OR-set, the projection or
app-password auth. It needs the Acorn A-step executor stack
(`coasys/ad4m` `acorn/a9-mount-lifecycle`; plain `dev` has no mount API) and
that stack's LDK (`mount` capability).

- `src/mount/reader.ts` — DID resolution (did:plc via PLC, hostname
  did:web), `getRepoStatus`, revision-pinned `listRecords` inventory
  (all-or-nothing), AppView `getPosts` labels.
- `src/mount/mapping.ts` — records → mount entries; address =
  `<did>/<collection>/<rkey>`; lossless `sourceRecord`; `atAuthor`.
- `src/mount/shapes.ts` — read-only `ATPost` / `ATFollow` / `ATAccount`.
- `src/mount/state.ts` — last complete inventory per account (persisted in
  host KV); a failed read never removes anything.
- `src/mount/lossless-json.ts` — integers beyond 2^53 survive.
- `mount-build.mjs` → `build/mount/bundle.js`; template variables
  `ACCOUNTS`, `PLC_URL`, `APPVIEW_URL`, `POLL_MS`, `ALLOW_HTTP` live in the
  banner. URLs must be https unless `ALLOW_HTTP` is "1" (a local dev network
  only). That is not SSRF protection: production needs an egress policy.

```bash
node mount-build.mjs                    # MOUNT_LDK_ENTRY overrides ../ad4m-acorn/ad4m-ldk/js/lib/index.js
node mount-typecheck.mjs                 # same MOUNT_LDK_ENTRY as the build (mount-ldk.mjs)
node --import tsx --test tests/mount-*.test.ts            # hermetic
(cd live && npm install)                                  # Node >= 22
MOUNT_LIVE=1 AD4M_EXECUTOR=<acorn executor> \
  node --import tsx --test --test-concurrency=1 tests/mount-live.test.ts
```

The live test starts a local PLC + PDS (`live/pds.mjs`, @atproto/dev-env,
two fresh accounts) and an executor on a temp data dir, and stops both.

### Explicit publication (slice 2, `spike/mounted-reader-s2`)

The one write: `ATPost`'s constructor is an acorn a2 `call` action to
`<lang>://class/ATPost` `publish`, so `perspective.createSubject("ATPost",
{text, atAuthor, publicationKey})` creates an `app.bsky.feed.post` through
`com.atproto.repo.createRecord`. Refresh, snapshot, status and record
addresses never write.

- `src/mount/oauth.ts` — atproto OAuth: DID -> PDS -> protected-resource ->
  AS discovery (checked), PAR, PKCE S256, DPoP ES256 + nonces, `iss`, token
  `sub` / scope / type checks, the account's PDS must name the issuer.
  Scope `atproto repo:app.bsky.feed.post?action=create`. Loopback client
  (`http://localhost?...`, redirect `http://127.0.0.1/callback`): dev only.
  Interactions on `<lang>://project`: `authorize {account}` -> URL to open;
  `completeAuthorization {callbackUrl}`; `sessions`; `signOut {account}`.
- `src/mount/vault.ts`, `sealed-box.ts` — tokens and DPoP keys only as boxes
  sealed to the executor agent (executor `sealed_box.rs` format, opened by
  `agentOpenSealed`), keyed `oauth/v1/session/<agent did>/<at did>`.
- `src/mount/publisher.ts` — ledger per `publicationKey` with an rkey chosen
  before the first send. Anything but a parsed success leaves it pending;
  the next request with that key lists the account's posts before any
  resend. Never add a resend path that skips the listing.
- `src/mount/service.ts` — reader + publisher; `mount-index.ts` only binds
  the host. OAuth/PDS writes use the isolate's `fetch` (they need the
  DPoP-Nonce response header, which `httpFetch` does not return).
- `mount-template.mjs` — the only template variables, all public. Never add
  a credential: the template is stored in the bundle in the data dir.

```bash
node --import tsx --test tests/mount-publish.test.ts tests/mount-oauth.test.ts   # hermetic
MOUNT_LIVE=1 AD4M_EXECUTOR=<acorn executor> \
  node --import tsx --test --test-concurrency=1 tests/mount-publish-live.test.ts
```

The live test runs `live/pds.mjs` with `CONTROL_PORT` (request log, a
"commit then drop the reply" fault, a file of issued secrets for the
credential scan) and plays the person at the authorization page with a
scripted, browser-less user agent (the AS's own sign-in/consent API).
