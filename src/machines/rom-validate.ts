import type { Bytes, MD5Sum } from "../flavours.js";
import type { ROMDescriptor, ROMManifest } from "./config.js";
import type { LoadedROMs } from "./pc88-memory.js";

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

export interface ValidateRomOpts {
  // Pre-computed md5 of `bytes`. Omit to skip the md5 check
  // (synthetic-ROM tests build images on the fly and don't have
  // a stable hash).
  md5?: MD5Sum;
}

// Validate a single ROM's size + (optionally) md5 against its
// descriptor. Pure: no platform-specific imports. Throws RomLoadError
// on mismatch; returns the input bytes unchanged on success.
export function validateRomBytes(
  bytes: Uint8Array,
  slot: keyof ROMManifest,
  descriptor: ROMDescriptor,
  opts: ValidateRomOpts = {},
): Uint8Array {
  const expectedSize: Bytes = descriptor.size * 1024;
  if (bytes.length !== expectedSize) {
    throw new RomLoadError(
      `ROM "${descriptor.id}" is ${bytes.length} bytes, expected ${expectedSize}`,
      slot,
      descriptor,
    );
  }
  if (opts.md5 !== undefined && opts.md5 !== descriptor.md5) {
    throw new RomLoadError(
      `ROM "${descriptor.id}" md5 mismatch: expected ${descriptor.md5}, got ${opts.md5}`,
      slot,
      descriptor,
    );
  }
  return bytes;
}

// Slots `LoadedROMs` actually carries today. Other manifest entries
// (font, kanji1, etc.) aren't part of the runtime ROM set yet —
// they're declared in variant configs for completeness but the chips
// that consume them haven't been built.
const LOADED_ROM_SLOTS = [
  "n80",
  "n88",
  "e0",
  "e1",
  "e2",
  "e3",
  "disk",
  "font",
] as const;
type LoadedRomSlot = (typeof LOADED_ROM_SLOTS)[number];

export function isLoadedRomSlot(slot: string): slot is LoadedRomSlot {
  return (LOADED_ROM_SLOTS as readonly string[]).includes(slot);
}

// Required-slot guarantee: PC88Machine's LoadedROMs declares `n80`
// and `n88` as non-optional. The cast at the call site relies on
// this — every loader path must throw on a missing required slot
// before assembling the result.
export function assembleLoadedRoms(parts: {
  -readonly [K in LoadedRomSlot]?: Uint8Array;
}): LoadedROMs {
  return parts as LoadedROMs;
}
