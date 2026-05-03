import { describe, expect, it } from "vitest";

import { YM2203 } from "../../../src/chips/io/YM2203.js";
import { IOBus } from "../../../src/core/IOBus.js";
import type { Cycles } from "../../../src/flavours.js";

function setup() {
  const bus = new IOBus();
  const opn = new YM2203();
  opn.register(bus);
  let irqCount = 0;
  opn.onIrq = () => {
    irqCount++;
  };
  return {
    bus,
    opn,
    irqCount: () => irqCount,
  };
}

// Helpers — abstract the addr-then-data Yamaha protocol.
function writeReg(bus: IOBus, reg: number, value: number) {
  bus.write(0x44, reg);
  bus.write(0x45, value);
}

describe("YM2203 register interface", () => {
  it("writes a register via 0x44 (addr) + 0x45 (data)", () => {
    const { bus, opn } = setup();
    writeReg(bus, 0x07, 0xab);
    // Snapshot exposes the latched register array.
    expect(opn.snapshot().regs[0x07]).toBe(0xab);
  });

  it("reading port 0x45 returns the timer-status byte", () => {
    const { bus } = setup();
    // Idle = 0x00 (no overflow, BUSY not modelled).
    expect(bus.read(0x45)).toBe(0x00);
  });
});

describe("YM2203 timer A", () => {
  it("fires IRQ after (1024 - NA) × 72 cycles when load+irq enabled", () => {
    const { bus, opn, irqCount } = setup();
    // NA = 1023 → counter reload = 1, period = 1 × 72 = 72 cycles.
    writeReg(bus, 0x24, 0xff); // TA high (8 bits)
    writeReg(bus, 0x25, 0x03); // TA low (2 bits)
    writeReg(bus, 0x27, 0x05); // LOAD A + IRQ A enable

    // Just under the period — no overflow yet.
    opn.tick(71 as Cycles);
    expect(irqCount()).toBe(0);
    expect(bus.read(0x45) & 0x01).toBe(0);

    // Cross the threshold — exactly one tick consumed → counter
    // hits zero → overflow latched, IRQ asserted.
    opn.tick(1 as Cycles);
    expect(irqCount()).toBe(1);
    expect(bus.read(0x45) & 0x01).toBe(1);
  });

  it("does NOT fire IRQ when LOAD A is set but IRQ A is masked", () => {
    const { bus, opn, irqCount } = setup();
    writeReg(bus, 0x24, 0xff);
    writeReg(bus, 0x25, 0x03);
    writeReg(bus, 0x27, 0x01); // LOAD A only; IRQ A bit clear

    opn.tick(72 as Cycles);
    expect(irqCount()).toBe(0);
    // The status flag still latches — software polling can still
    // see the overflow without an IRQ wakeup.
    expect(bus.read(0x45) & 0x01).toBe(1);
  });

  it("RESET A bit clears the status latch without disabling the timer", () => {
    const { bus, opn } = setup();
    writeReg(bus, 0x24, 0xff);
    writeReg(bus, 0x25, 0x03);
    writeReg(bus, 0x27, 0x01); // LOAD A
    opn.tick(72 as Cycles);
    expect(bus.read(0x45) & 0x01).toBe(1);

    // Mode reg with RESET A bit + LOAD A still set.
    writeReg(bus, 0x27, 0x11);
    expect(bus.read(0x45) & 0x01).toBe(0);

    // Timer is still running — next overflow re-latches.
    opn.tick(72 as Cycles);
    expect(bus.read(0x45) & 0x01).toBe(1);
  });

  it("doesn't tick when LOAD A is clear", () => {
    const { bus, opn, irqCount } = setup();
    writeReg(bus, 0x24, 0xff);
    writeReg(bus, 0x25, 0x03);
    // LOAD A cleared but IRQ A enabled.
    writeReg(bus, 0x27, 0x04);
    opn.tick(72 as Cycles);
    expect(irqCount()).toBe(0);
    expect(bus.read(0x45) & 0x01).toBe(0);
  });

  it("fires repeatedly across multiple periods", () => {
    const { bus, opn, irqCount } = setup();
    writeReg(bus, 0x24, 0xff);
    writeReg(bus, 0x25, 0x03);
    writeReg(bus, 0x27, 0x05); // LOAD A + IRQ A
    // First overflow fires; subsequent overflows need RESET A
    // between them to deassert before re-asserting.
    opn.tick(72 as Cycles);
    expect(irqCount()).toBe(1);
    // No reset — the second tick still re-loads but doesn't fire
    // again because the status flag is still latched.
    opn.tick(72 as Cycles);
    expect(irqCount()).toBe(1);
    // After RESET A, next overflow re-asserts.
    writeReg(bus, 0x27, 0x15);
    opn.tick(72 as Cycles);
    expect(irqCount()).toBe(2);
  });
});

describe("YM2203 timer B", () => {
  it("fires IRQ after (256 - NB) × 1152 cycles when load+irq enabled", () => {
    const { bus, opn, irqCount } = setup();
    // NB = 0xFF → counter reload = 1, period = 1 × 1152 cycles.
    writeReg(bus, 0x26, 0xff);
    writeReg(bus, 0x27, 0x0a); // LOAD B + IRQ B

    opn.tick(1151 as Cycles);
    expect(irqCount()).toBe(0);
    opn.tick(1 as Cycles);
    expect(irqCount()).toBe(1);
    expect(bus.read(0x45) & 0x02).toBe(0x02);
  });

  it("RESET B clears bit 1 of status independently of A", () => {
    const { bus, opn } = setup();
    // Run TA to overflow + TB to overflow.
    writeReg(bus, 0x24, 0xff);
    writeReg(bus, 0x25, 0x03);
    writeReg(bus, 0x26, 0xff);
    writeReg(bus, 0x27, 0x03); // LOAD A + LOAD B (no IRQ enable)
    opn.tick(1152 as Cycles);
    expect(bus.read(0x45) & 0x03).toBe(0x03);

    // Reset only B; A still latched.
    writeReg(bus, 0x27, 0x23); // LOAD A + LOAD B + RESET B
    expect(bus.read(0x45) & 0x03).toBe(0x01);
  });
});

describe("YM2203 snapshot round-trip", () => {
  it("preserves timer state through snapshot/restore", () => {
    const { bus, opn } = setup();
    writeReg(bus, 0x24, 0xab);
    writeReg(bus, 0x25, 0x02);
    writeReg(bus, 0x26, 0x42);
    writeReg(bus, 0x27, 0x0f);
    opn.tick(50 as Cycles);

    const snap = opn.snapshot();
    const fresh = new YM2203();
    fresh.fromSnapshot(snap);
    const fresh2 = fresh.snapshot();
    expect(fresh2).toEqual(snap);
  });
});
