import logLib from "log";

import type { u8, u16 } from "../flavours.js";
import { word } from "../tools.js";

const log = logLib.get("bus");

export interface MemoryProvider {
  name: string;
  start: number;
  end: number;
  read?: (offset: number) => u8;
  write?: (offset: number, value: u8) => void;
  // Optional direct access window. When a provider exposes a Uint8Array
  // covering its full [start, end) range and offset 0 maps to start, the
  // bus can skip its own dispatch and read/write the array directly.
  // Set this to make the typical "single 64K RAM" case much faster on the
  // M1-fetch hot path.
  bytes?: Uint8Array;
}

export class MemoryBus {
  // Resolved at refresh() time. When a single full-coverage provider has
  // a `bytes` Uint8Array, this is set to the array and read/write skip
  // the provider scan entirely.
  fastBytes: Uint8Array | null = null;

  constructor(
    public providers: MemoryProvider[] = [],
    public invalidByte: u8 = 0xec,
  ) {
    this.refresh();
  }

  // Recompute the fast-path. Call after mutating `providers` if you
  // want subsequent reads to pick up the new layout.
  refresh(): void {
    if (this.providers.length === 1) {
      const p = this.providers[0]!;
      if (
        p.start === 0 &&
        p.end >= 0x10000 &&
        p.bytes &&
        p.bytes.length >= 0x10000
      ) {
        this.fastBytes = p.bytes;
        return;
      }
    }
    this.fastBytes = null;
  }

  read(address: number): u8 {
    const fast = this.fastBytes;
    if (fast !== null) return fast[address & 0xffff]!;
    const providers = this.providers;
    for (let i = 0; i < providers.length; i++) {
      const provider = providers[i]!;
      if (
        address >= provider.start &&
        address < provider.end &&
        provider.read
      ) {
        return provider.read(address - provider.start);
      }
    }

    log.warn(`failed to read from ${word(address)}`);
    return this.invalidByte;
  }

  readWord(address: number): u16 {
    const lo = this.read(address);
    const hi = this.read(address + 1);
    return (hi << 8) | lo;
  }

  write(address: number, value: u8) {
    const fast = this.fastBytes;
    if (fast !== null) {
      fast[address & 0xffff] = value;
      return;
    }
    const providers = this.providers;
    for (let i = 0; i < providers.length; i++) {
      const provider = providers[i]!;
      if (
        address >= provider.start &&
        address < provider.end &&
        provider.write
      ) {
        provider.write(address - provider.start, value);
        return;
      }
    }

    log.warn(`failed to write to ${word(address)}`);
  }

  writeWord(address: number, value: u16) {
    this.write(address, value & 0xff);
    this.write(address + 1, (value & 0xff00) >> 8);
  }
}
