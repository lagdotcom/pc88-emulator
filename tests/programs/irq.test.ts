// IM 1 maskable-interrupt acceptance. Drives the Z80 directly via
// requestIrq() and asserts the dispatch shape: PC pushed, vector to
// 0x0038, IFF1/IFF2 cleared, halted cleared.

import { describe, expect, it } from "vitest";

import { makeProgramHarness } from "./harness.js";

describe("IM 1 IRQ acceptance", () => {
  it("vectors to 0x0038 and pushes return PC", () => {
    const h = makeProgramHarness();
    const { cpu, ram } = h;

    // EI ; NOP ; HALT — once we're in HALT with IFF1=1 we can fire IRQ.
    ram.bytes[0x0100] = 0xfb; // EI
    ram.bytes[0x0101] = 0x00; // NOP
    ram.bytes[0x0102] = 0x76; // HALT
    cpu.regs.PC = 0x0100;
    cpu.regs.SP = 0xff00;
    cpu.im = 1;

    cpu.runOneOp(); // EI — sets eiDelay, IFF1 not yet effective
    cpu.runOneOp(); // NOP — eiDelay consumed, IFF1 is now live
    cpu.runOneOp(); // HALT
    expect(cpu.halted).toBe(true);
    expect(cpu.iff1).toBe(true);

    cpu.requestIrq();
    cpu.runOneOp();

    expect(cpu.halted).toBe(false);
    expect(cpu.regs.PC).toBe(0x0038);
    expect(cpu.iff1).toBe(false);
    expect(cpu.iff2).toBe(false);
    expect(cpu.regs.SP).toBe(0xfefe);

    // Pushed PC should be the address of the instruction after HALT.
    const lo = ram.bytes[0xfefe]!;
    const hi = ram.bytes[0xfeff]!;
    expect((hi << 8) | lo).toBe(0x0103);
  });

  it("does not fire while IFF1 is clear", () => {
    const h = makeProgramHarness();
    const { cpu, ram } = h;

    ram.bytes[0x0100] = 0x00; // NOP
    cpu.regs.PC = 0x0100;
    cpu.regs.SP = 0xff00;
    cpu.iff1 = false; // explicit
    cpu.requestIrq();
    cpu.runOneOp();

    expect(cpu.regs.PC).toBe(0x0101);
    expect(cpu.irqLine).toBe(true); // line still asserted
    expect(cpu.regs.SP).toBe(0xff00);
  });

  it("respects the EI grace period", () => {
    const h = makeProgramHarness();
    const { cpu, ram } = h;

    // EI ; NOP — IRQ fires before the EI is set, asserts must NOT
    // accept on the instruction immediately after EI (eiDelay grace).
    ram.bytes[0x0100] = 0xfb; // EI
    ram.bytes[0x0101] = 0x00; // NOP
    ram.bytes[0x0102] = 0x00; // NOP
    cpu.regs.PC = 0x0100;
    cpu.regs.SP = 0xff00;

    cpu.runOneOp(); // EI
    expect(cpu.iff1).toBe(true);
    expect(cpu.eiDelay).toBe(true);

    cpu.requestIrq();
    cpu.runOneOp(); // NOP — IRQ blocked by eiDelay
    expect(cpu.regs.PC).toBe(0x0102);
    expect(cpu.irqLine).toBe(true);

    cpu.runOneOp(); // NOP — IRQ now accepted
    expect(cpu.regs.PC).toBe(0x0038);
    expect(cpu.irqLine).toBe(false);
  });
});
