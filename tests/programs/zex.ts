import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { bOps, mOps } from "../../src/flavour.makers.js";
import type { FilesystemPath, Operations, WebURI } from "../../src/flavours.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURES = join(HERE, "fixtures");

const ZEX_URLS: Record<FilesystemPath, WebURI> = {
  "zexdoc.com":
    "https://raw.githubusercontent.com/anotherlin/z80emu/master/testfiles/zexdoc.com",
  "zexall.com":
    "https://raw.githubusercontent.com/anotherlin/z80emu/master/testfiles/zexall.com",
};

// Approximate total instructions to completion. Used only for the ETA in
// progress logs — the actual run terminates on BDOS function 0 from the
// binary itself, not on hitting this count. Numbers come from a measured
// run on this emulator (~5.78 G ops to a clean exit, regardless of
// whether the test reports ERROR or ok). Refresh if the emulator's
// behaviour changes enough that these get noticeably off.
export const APPROX_TOTAL_OPS: Record<FilesystemPath, Operations> = {
  "zexdoc.com": bOps(5.8),
  "zexall.com": bOps(5.8),
};

export const MAX_OPS = bOps(10);
export const SHOW_PROGRESS_EVERY_OPS = mOps(50);

export async function loadZEXBinary(name: FilesystemPath): Promise<Uint8Array> {
  const cached = join(FIXTURES, name);
  if (existsSync(cached)) return new Uint8Array(await readFile(cached));

  const url = ZEX_URLS[name];
  if (!url) throw new Error(`no URL configured for ${name}`);

  console.info(`fetching ${url}...`);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`fetch failed: ${res.status}`);

  const buf = new Uint8Array(await res.arrayBuffer());
  await mkdir(FIXTURES, { recursive: true });
  await writeFile(cached, buf);
  return buf;
}
