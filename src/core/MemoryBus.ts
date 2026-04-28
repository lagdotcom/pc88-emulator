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
}

export class MemoryBus {
  constructor(
    public providers: MemoryProvider[] = [],
    public invalidByte: u8 = 0xec,
  ) {}

  read(address: number): u8 {
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
