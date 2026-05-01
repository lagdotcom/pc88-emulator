import logLib from "log";

import type { u8, u16 } from "../flavours.js";
import { byte } from "../tools.js";

const log = logLib.get("io");

export interface IOPort {
  name: string;
  read?: (port: u16) => u8;
  write?: (port: u16, value: u8) => void;
}

type Reader = (port: u16) => u8;
type Writer = (port: u16, value: u8) => void;

// 256-slot pre-resolved I/O bus. The Z80 emits a full 16-bit port number
// (the upper byte is A on `IN A,(n)` / `OUT (n),A`, or B on `IN r,(C)` /
// `OUT (C),r`). PC-88 chips decode only the low 8 bits, so the dispatch
// table is sized by `port & 0xff`. The full 16-bit port is still passed
// to the handler so test harnesses keyed on the high byte can use it.
//
// Default contents are a noisy-once reader (`0xff`) and a noisy-once
// writer (no-op). Real chip stubs replace specific slots via
// `register()` / `registerRange()`. The hot path is one array load and
// one call — no branch on every IN/OUT.
export type IOTracer = (kind: "r" | "w", port: u16, value: u8) => void;

export class IOBus {
  private readers: Reader[];
  private writers: Writer[];
  private warnedRead = new Set<number>();
  private warnedWrite = new Set<number>();
  // Optional opt-in tracer. When set, called on every IN/OUT before
  // dispatch — used by the CLI runner's PC88_TRACE_IO=1 mode. The hot
  // path stays one extra null check; cost is negligible vs. the
  // dispatch itself.
  tracer: IOTracer | null = null;

  constructor() {
    this.readers = new Array(256);
    this.writers = new Array(256);
    for (let i = 0; i < 256; i++) {
      this.readers[i] = (port: u16) => this.warnRead(port);
      this.writers[i] = (port: u16, value: u8) => this.warnWrite(port, value);
    }
  }

  // Install handlers at one specific port (low byte). Read or write may
  // be omitted; the omitted direction keeps the noisy-once default.
  register(port: u8, handler: IOPort): void {
    const slot = port & 0xff;
    if (handler.read) this.readers[slot] = handler.read;
    if (handler.write) this.writers[slot] = handler.write;
  }

  // Install handlers across an inclusive range of ports.
  registerRange(start: u8, end: u8, handler: IOPort): void {
    for (let p = start; p <= end; p++) this.register(p, handler);
  }

  // Test-harness convenience: install a single read/write pair across
  // all 256 slots. The handler still gets the full 16-bit port.
  registerAll(handler: IOPort): void {
    for (let p = 0; p < 256; p++) this.register(p, handler);
  }

  read(port: u16): u8 {
    const v = this.readers[port & 0xff]!(port);
    if (this.tracer) this.tracer("r", port, v);
    return v;
  }

  write(port: u16, value: u8): void {
    if (this.tracer) this.tracer("w", port, value);
    this.writers[port & 0xff]!(port, value);
  }

  private warnRead(port: u16): u8 {
    if (!this.warnedRead.has(port)) {
      this.warnedRead.add(port);
      log.warn(`unhandled IN  ${byte(port)} (full ${port})`);
    }
    return 0xff;
  }

  private warnWrite(port: u16, value: u8): void {
    if (!this.warnedWrite.has(port)) {
      this.warnedWrite.add(port);
      log.warn(`unhandled OUT ${byte(port)} = ${byte(value)} (full ${port})`);
    }
  }
}
