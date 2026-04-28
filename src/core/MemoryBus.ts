import logLib from "log";

import type { u8, u16 } from "../flavours.js";
import { byte, word } from "../tools.js";

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
    for (const provider of this.providers) {
      if (
        address >= provider.start &&
        address < provider.end &&
        provider.read
      ) {
        const value = provider.read(address - provider.start);
        log.debug(`read ${byte(value)} from ${word(address)}`);
        return value;
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
    for (const provider of this.providers) {
      if (
        address >= provider.start &&
        address < provider.end &&
        provider.write
      ) {
        log.debug(`wrote ${byte(value)} to ${word(address)}`);
        return provider.write(address - provider.start, value);
      }
    }

    log.warn(`failed to write to ${word(address)}`);
  }

  writeWord(address: number, value: u16) {
    this.write(address, value & 0xff);
    this.write(address + 1, (value & 0xff00) >> 8);
  }
}
