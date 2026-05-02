# AT Protocol Link Language for AD4M

AD4M link language that syncs Perspective triples to an AT Protocol PDS via XRPC, stored as records in a custom `ad4m.link.triple` collection.

## What It Does

- **Commits:** links → XRPC `com.atproto.repo.createRecord` calls to the PDS
- **Sync:** lists repo records for new entries → local links
- **Query:** indexed local store (source, target, predicate)
- **Custom Lexicon:** `ad4m.link.triple` schema for structured link data in the AT repo (see `lexicons/`)

## Template Variables

| Variable | Description |
|----------|-------------|
| `AT_PDS_URL` | PDS server URL |
| `AT_RELAY_URL` | Relay (BGS) URL for firehose |
| `AT_DID` | Account DID |
| `AT_HANDLE` | Account handle |
| `AT_COLLECTION_NSID` | Collection NSID (default: `ad4m.link.triple`) |
| `AT_APP_PASSWORD` | App password for auth |
| `NEIGHBOURHOOD_META` | AD4M neighbourhood metadata |

## Building

```bash
pnpm install
deno run --allow-all esbuild.ts
```

Requires `@coasys/ad4m-ldk` at `../ad4m/ad4m-ldk/js/` or set `AD4M_LDK_ENTRY`.

## Testing

```bash
node --experimental-vm-modules --import tsx --test tests/*.test.ts
```

238 tests across 9 suites.

## Architecture

Same [pure/impure pattern](https://github.com/HexaField/ad4m-link-language-template) as all AD4M link languages. Protocol-specific modules:

- `src/xrpc.ts` / `xrpc.pure.ts` — XRPC client for PDS communication
- `src/auth.ts` — app password authentication + session refresh
- `src/lexicon.ts` — custom Lexicon definition for `ad4m.link.triple`
- `src/rendering.ts` / `rendering.pure.ts` — link rendering
- `src/translate.ts` / `translate.pure.ts` — link ↔ AT record translation
- `src/dual-language.ts` — dual-language support
- `src/sdna.ts` — social DNA definitions
- `src/settings.ts` — language settings
- `src/sync.ts` — sync orchestration

Lexicon schemas live in `lexicons/`.

`ad4m:host` imports confined to 4 adapter files + `index.ts`.

## License

CAL-1.0
