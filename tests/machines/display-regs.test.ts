import { describe, expect, it } from "vitest";

import { IOBus } from "../../src/core/IOBus.js";
import { DisplayRegisters } from "../../src/machines/display-regs.js";
import { PC88MemoryMap } from "../../src/machines/pc88-memory.js";
import { filledROM } from "../tools.js";

function setup() {
  const memoryMap = new PC88MemoryMap({
    n80: filledROM(0x8000, 0x80),
    n88: filledROM(0x8000, 0x88),
    e0: filledROM(0x2000, 0xe0),
  });
  const bus = new IOBus();
  const regs = new DisplayRegisters(memoryMap);
  regs.register(bus);
  return { bus, regs };
}

describe("DisplayRegisters palette — digital mode (default)", () => {
  it("each port 0x54..0x5B write lands in palramLow[idx] with palramHigh untouched", () => {
    const { bus, regs } = setup();
    for (let i = 0; i < 8; i++) bus.write(0x54 + i, i + 1);
    for (let i = 0; i < 8; i++) {
      expect(regs.palramLow[i]).toBe(i + 1);
      expect(regs.palramHigh[i]).toBe(0);
    }
  });

  it("repeated writes to the same port overwrite (no toggle)", () => {
    const { bus, regs } = setup();
    bus.write(0x54, 0x11);
    bus.write(0x54, 0x22);
    bus.write(0x54, 0x33);
    expect(regs.palramLow[0]).toBe(0x33);
    expect(regs.palramHigh[0]).toBe(0);
  });
});

describe("DisplayRegisters palette — analogue mode (after setPMode(1))", () => {
  it("alternates writes to the same port between low and high halves", () => {
    const { bus, regs } = setup();
    regs.setPMode(1);
    // SR's V2 init writes 16 consecutive bytes (low, high, low, high,
    // ...) but the loop at sr-n88 0x3962 increments the port each
    // pair. For per-port toggle behaviour, write twice to the same
    // port: first byte → low, second → high.
    bus.write(0x54, 0xab);
    bus.write(0x54, 0xcd);
    expect(regs.palramLow[0]).toBe(0xab);
    expect(regs.palramHigh[0]).toBe(0xcd);
  });

  it("third write to the same port returns to the low slot (toggle wraps)", () => {
    const { bus, regs } = setup();
    regs.setPMode(1);
    bus.write(0x54, 0x10);
    bus.write(0x54, 0x20);
    bus.write(0x54, 0x30);
    expect(regs.palramLow[0]).toBe(0x30);
    expect(regs.palramHigh[0]).toBe(0x20);
  });

  it("each port's toggle is independent", () => {
    const { bus, regs } = setup();
    regs.setPMode(1);
    bus.write(0x54, 0xa0); // pal0 low
    bus.write(0x55, 0xb0); // pal1 low
    bus.write(0x54, 0xa1); // pal0 high
    bus.write(0x55, 0xb1); // pal1 high
    expect(regs.palramLow[0]).toBe(0xa0);
    expect(regs.palramHigh[0]).toBe(0xa1);
    expect(regs.palramLow[1]).toBe(0xb0);
    expect(regs.palramHigh[1]).toBe(0xb1);
  });

  it("matches the SR V2 init data (8 ports × 2 bytes) from sr-n88 0x3DA4", () => {
    // The init loop at sr-n88 0x3962 sources bytes from the table at
    // 0x3DA4 (16 bytes; (G+R, B+sentinel) × 8). Replay it here against
    // the registered ports and confirm both halves land correctly.
    const { bus, regs } = setup();
    regs.setPMode(1);
    const data = [
      0x00, 0x40, 0x07, 0x40, 0x37, 0x40, 0x3f, 0x40, 0x00, 0x47, 0x07, 0x47,
      0x37, 0x47, 0x3f, 0x47,
    ];
    for (let i = 0; i < 8; i++) {
      bus.write(0x54 + i, data[i * 2]!); // low (G+R)
      bus.write(0x54 + i, data[i * 2 + 1]!); // high (B + sentinel)
    }
    expect(Array.from(regs.palramLow)).toEqual([
      0x00, 0x07, 0x37, 0x3f, 0x00, 0x07, 0x37, 0x3f,
    ]);
    expect(Array.from(regs.palramHigh)).toEqual([
      0x40, 0x40, 0x40, 0x40, 0x47, 0x47, 0x47, 0x47,
    ]);
  });
});

describe("DisplayRegisters setPMode toggle reset", () => {
  it("flipping PMODE resets the per-port high-next flags", () => {
    const { bus, regs } = setup();
    regs.setPMode(1);
    // Get pal0 into "high next" state by writing one byte.
    bus.write(0x54, 0xaa);
    expect(regs.palramHighNext[0]).toBe(true);
    // Flip to digital → high-next must clear.
    regs.setPMode(0);
    expect(regs.palramHighNext[0]).toBe(false);
    // Flip back to analogue → first byte still goes to low half.
    regs.setPMode(1);
    bus.write(0x54, 0xbb);
    expect(regs.palramLow[0]).toBe(0xbb);
    expect(regs.palramHigh[0]).toBe(0); // unchanged from initial
  });

  it("setPMode does not clobber palramLow / palramHigh contents", () => {
    const { bus, regs } = setup();
    regs.setPMode(1);
    bus.write(0x54, 0x12);
    bus.write(0x54, 0x34);
    expect(regs.palramLow[0]).toBe(0x12);
    expect(regs.palramHigh[0]).toBe(0x34);
    regs.setPMode(0);
    expect(regs.palramLow[0]).toBe(0x12);
    expect(regs.palramHigh[0]).toBe(0x34);
  });
});

describe("DisplayRegisters snapshot round-trip with palette state", () => {
  it("preserves pmode + both palette halves + per-port toggle flags", () => {
    const { bus, regs } = setup();
    regs.setPMode(1);
    bus.write(0x54, 0x11);
    bus.write(0x55, 0x22);
    bus.write(0x55, 0x33); // pal1 fully written; pal0 mid-pair (high-next)
    const snap = regs.snapshot();
    expect(snap.pmode).toBe(1);
    expect(snap.palramLow[0]).toBe(0x11);
    expect(snap.palramLow[1]).toBe(0x22);
    expect(snap.palramHigh[1]).toBe(0x33);
    expect(snap.palramHighNext[0]).toBe(true); // mid-pair
    expect(snap.palramHighNext[1]).toBe(false); // pair completed

    const fresh = new DisplayRegisters(regs["memoryMap"]);
    fresh.fromSnapshot(snap);
    expect(fresh.pmode).toBe(1);
    expect(Array.from(fresh.palramLow)).toEqual(snap.palramLow);
    expect(Array.from(fresh.palramHigh)).toEqual(snap.palramHigh);
    expect(fresh.palramHighNext).toEqual(snap.palramHighNext);
  });
});
