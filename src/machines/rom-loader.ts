import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

import type { Bytes } from "../flavours.js";
import type { PC88Config, ROMDescriptor, ROMManifest } from "./config.js";

// ROMs found on disk, keyed by their slot in `ROMManifest`. Required
// slots are guaranteed Uint8Array; optional slots are present only if
// the file existed (and validated cleanly). Stripping `readonly` from
// the manifest mapping so the loader can assemble the result
// incrementally; consumers can re-add it on their own end.
export type LoadedRoms = {
  -readonly [K in keyof ROMManifest]: Uint8Array;
};

export interface RomLoadOptions {
  // Directory to search. Defaults to the `roms/` folder at repo root,
  // overridable via env var (the caller is expected to pass through
  // `process.env.PC88_ROM_DIR`).
  dir?: string;
  // Disable md5 verification. Used by the synthetic-ROM tests, which
  // build images on the fly.
  skipMd5?: boolean;
}

export class RomLoadError extends Error {
  constructor(
    message: string,
    public readonly slot: keyof ROMManifest,
    public readonly descriptor: ROMDescriptor,
  ) {
    super(message);
    this.name = "RomLoadError";
  }
}

// Resolve every ROM slot in the manifest to a `Uint8Array`. Required
// slots throw if missing or if the contents fail size / md5
// validation. Optional slots resolve to undefined if the file is
// absent, but still throw if it's present-but-invalid.
export async function loadRoms(
  config: PC88Config,
  opts: RomLoadOptions = {},
): Promise<Partial<LoadedRoms>> {
  const dir = opts.dir ?? "roms";
  const result: Partial<LoadedRoms> = {};

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
    const expectedSize: Bytes = descriptor.size * 1024;
    if (bytes.length !== expectedSize) {
      throw new RomLoadError(
        `ROM "${descriptor.id}" at ${path} is ${bytes.length} bytes, expected ${expectedSize}`,
        slot,
        descriptor,
      );
    }
    if (!opts.skipMd5) {
      const got = createHash("md5").update(bytes).digest("hex");
      if (got !== descriptor.md5) {
        throw new RomLoadError(
          `ROM "${descriptor.id}" md5 mismatch: expected ${descriptor.md5}, got ${got}`,
          slot,
          descriptor,
        );
      }
    }
    result[slot] = bytes;
  }
  return result;
}
