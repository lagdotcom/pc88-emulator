import type { MemoryProvider } from "../src/core/MemoryBus.js";
import type { Hours, Minutes, Seconds, u8, u16 } from "../src/flavours.js";

export function filledROM(size: number, fill: u8) {
  return new Uint8Array(size).fill(fill);
}

export class RAM64k implements MemoryProvider {
  name = "ram";
  start = 0;
  end = 0x10000;
  bytes = new Uint8Array(0x10000);
  read(o: u16) {
    return this.bytes[o]!;
  }
  write(o: u16, v: u8) {
    this.bytes[o] = v;
  }
}

export class TestIO {
  name = "io";
  inputs = new Map<u16, u8[]>();
  reads: [u16, u8][] = [];
  writes: [u16, u8][] = [];

  enqueueInput(port: u16, value: u8): void {
    let q = this.inputs.get(port);
    if (!q) {
      q = [];
      this.inputs.set(port, q);
    }
    q.push(value);
  }

  read = (port: u16): u8 => {
    const q = this.inputs.get(port);
    const value = q?.shift() ?? 0xff;
    this.reads.push([port, value]);
    return value;
  };

  write = (port: u16, value: u8): void => {
    this.writes.push([port, value]);
  };
}

export function formatHMS(time: Seconds): string {
  if (!isFinite(time) || time < 0) return "?";
  const h: Hours = Math.floor(time / 3600);
  const m: Minutes = Math.floor((time % 3600) / 60);
  const s: Seconds = Math.floor(time % 60);
  if (h > 0) return `${h}h${m.toString().padStart(2, "0")}m`;
  if (m > 0) return `${m}m${s.toString().padStart(2, "0")}s`;
  return `${s}s`;
}
