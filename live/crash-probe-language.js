// Crash probe for the host's storage writes (slice 2 round 2, item 2): a
// minimal flat-export language. `rewrite {mode, ms, kb}` rewrites one file in
// its storage directory in a tight, blocking loop for `ms` milliseconds with
// either `writeStorageFile` (plain; what the KV uses) or
// `writeStorageFileAtomic`. The live test SIGKILLs the executor mid-loop and
// checks whether the file is whole. Every version is self-describing:
// {i, size, pad} with pad.length === size.
import * as host from "ad4m:host";

export const name = "atproto-s2-crash-probe";
export async function init() {}
export function isPublic() { return false; }

export function interactions(address) {
  if (address !== "project") return [];
  return [
    { label: "Where", name: "where", parameters: [], execute: async () => ({
        dir: host.languageStorageDirectory(), atomic: typeof host.writeStorageFileAtomic === "function" }) },
    { label: "Rewrite", name: "rewrite", parameters: [], execute: async (p) => {
        const path = host.languageStorageDirectory().replace(/\/+$/, "") + "/crash-probe.json";
        const size = (p.kb || 8192) * 1024;
        const pad = "x".repeat(size);
        const end = Date.now() + (p.ms || 20000);
        let i = 0;
        while (Date.now() < end) {
          const content = JSON.stringify({ i: ++i, size, pad });
          if (p.mode === "atomic") host.writeStorageFileAtomic(path, content);
          else host.writeStorageFile(path, content);
        }
        return i;
      } },
  ];
}
