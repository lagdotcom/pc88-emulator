import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

import type { FilesystemPath, MD5Sum } from "../flavours.js";
import type { PC88Config, ROMDescriptor, ROMManifest } from "./config.js";
import type { LoadedROMs } from "./pc88-memory.js";
import {
  assembleLoadedRoms,
  isLoadedRomSlot,
  RomLoadError,
  validateRomBytes,
} from "./rom-validate.js";

export { RomLoadError } from "./rom-validate.js";

export interface RomLoadOptions {
  // Directory to search. Defaults to the `roms/` folder at repo root,
  // overridable via env var (the caller is expected to pass through
  // `process.env.PC88_ROM_DIR`).
  dir?: FilesystemPath;
  // Disable md5 verification. Used by the synthetic-ROM tests, which
  // build images on the fly.
  skipMd5?: boolean;
}

// Resolve every ROM slot in the manifest to a `Uint8Array`. Required
// slots throw if missing or if the contents fail size / md5
// validation. Optional slots resolve to undefined if the file is
// absent, but still throw if it's present-but-invalid.
//
// Returns `LoadedROMs` directly — required slots (`n80`, `n88`) are
// guaranteed populated because the loader throws on missing required
// files, so callers don't need a runtime null-check on those slots.
export async function loadRoms(
  config: PC88Config,
  opts: RomLoadOptions = {},
): Promise<LoadedROMs> {
  const dir = opts.dir ?? "roms";
  const result: { -readonly [K in keyof LoadedROMs]?: Uint8Array } = {};

  for (const [slot, descriptor] of Object.entries(config.roms) as [
    keyof ROMManifest,
    ROMDescriptor | undefined,
  ][]) {
    if (!descriptor) continue;
    const path = join(dir, `${descriptor.id}.rom`);
    if (!existsSync(path)) {
      if (descriptor.required) {
        throw new RomLoadError(
          `required ROM "${descriptor.id}" not found at ${path}`,
          slot,
          descriptor,
        );
      }
      continue;
    }
    const bytes = new Uint8Array(await readFile(path));
    if (opts.skipMd5) {
      validateRomBytes(bytes, slot, descriptor);
    } else {
      const md5 = createHash("md5").update(bytes).digest("hex") as MD5Sum;
      validateRomBytes(bytes, slot, descriptor, { md5 });
    }
    if (isLoadedRomSlot(slot)) result[slot] = bytes;
  }
  return assembleLoadedRoms(result);
}
