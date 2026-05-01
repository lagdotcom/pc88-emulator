import type { MD5Sum, ROMID } from "../flavours.js";
import type { PC88Config, ROMDescriptor, ROMManifest } from "./config.js";
import type { LoadedROMs } from "./pc88-memory.js";
import {
  assembleLoadedRoms,
  isLoadedRomSlot,
  RomLoadError,
  validateRomBytes,
} from "./rom-validate.js";

// Resolve a `LoadedROMs` set from already-loaded byte buffers keyed
// by ROMID. The caller (web boot screen, tests) is responsible for
// loading the bytes — from the user's disk via <input type="file">,
// from OPFS, from a fixture array, etc.
//
// Required slots throw if missing from `bytes` or if their contents
// fail size / md5 validation. Optional slots resolve to undefined if
// they're not in the map; present-but-invalid optional slots still
// throw.
export function loadRomsFromMap(
  config: PC88Config,
  bytes: Map<ROMID, Uint8Array>,
  computeMd5: (data: Uint8Array) => MD5Sum,
): LoadedROMs {
  const result: { -readonly [K in keyof LoadedROMs]?: Uint8Array } = {};

  for (const [slot, descriptor] of Object.entries(config.roms) as [
    keyof ROMManifest,
    ROMDescriptor | undefined,
  ][]) {
    if (!descriptor) continue;
    const data = bytes.get(descriptor.id);
    if (!data) {
      if (descriptor.required) {
        throw new RomLoadError(
          `required ROM "${descriptor.id}" not loaded`,
          slot,
          descriptor,
        );
      }
      continue;
    }
    validateRomBytes(data, slot, descriptor, { md5: computeMd5(data) });
    if (isLoadedRomSlot(slot)) result[slot] = data;
  }
  return assembleLoadedRoms(result);
}
