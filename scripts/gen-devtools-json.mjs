// Emit web/.well-known/appspecific/com.chrome.devtools.json so Chrome
// DevTools' "Workspace folders" feature can map served sources back
// to the on-disk repo. Format spec:
//
//   {
//     "workspace": {
//       "root": "<absolute path>",
//       "uuid": "<stable random uuid>"
//     }
//   }
//
// `root` is the user's absolute path so we can't bake it into a
// committed file (and the file is gitignored). The UUID is stable
// per-checkout: we read the existing one back if the file already
// exists, generate a fresh one otherwise.
//
// Run it manually with `yarn devtools-json` or let `yarn web:host`
// invoke it as a prelude.

import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

const repoRoot = resolve(process.cwd());
const outPath = join(
  repoRoot,
  "web",
  ".well-known",
  "appspecific",
  "com.chrome.devtools.json",
);

let uuid;
if (existsSync(outPath)) {
  try {
    const existing = JSON.parse(readFileSync(outPath, "utf8"));
    uuid = existing?.workspace?.uuid;
  } catch {
    /* fall through to fresh uuid */
  }
}
uuid ??= randomUUID();

mkdirSync(dirname(outPath), { recursive: true });
writeFileSync(
  outPath,
  JSON.stringify({ workspace: { root: repoRoot, uuid } }, null, 2) + "\n",
);

console.log(`wrote ${outPath}\n  root=${repoRoot}\n  uuid=${uuid}`);
