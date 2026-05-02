// IM 1 / IM 2 maskable-interrupt acceptance. Drives the Z80 directly
// via requestIrq() and asserts the dispatch shape: PC pushed, vector
// computed by mode, IFF1/IFF2 cleared, halted cleared.

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

describe("IM 2 IRQ acceptance", () => {
  it("dispatches via the I:vector table", () => {
    const h = makeProgramHarness();
    const { cpu, ram } = h;

    // Vector table at 0x4000, vector byte 0x10. Target = 0x1234.
    cpu.regs.I = 0x40;
    ram.bytes[0x4010] = 0x34;
    ram.bytes[0x4011] = 0x12;

    ram.bytes[0x0100] = 0xfb; // EI
    ram.bytes[0x0101] = 0x00; // NOP
    ram.bytes[0x0102] = 0x76; // HALT
    cpu.regs.PC = 0x0100;
    cpu.regs.SP = 0xff00;
    cpu.im = 2;

    cpu.runOneOp(); // EI
    cpu.runOneOp(); // NOP — eiDelay consumed
    cpu.runOneOp(); // HALT
    expect(cpu.halted).toBe(true);

    cpu.requestIrq(0x10);
    cpu.runOneOp();

    expect(cpu.halted).toBe(false);
    expect(cpu.regs.PC).toBe(0x1234);
    expect(cpu.iff1).toBe(false);
    expect(cpu.regs.SP).toBe(0xfefe);
    // Return PC pushed = address after HALT.
    const lo = ram.bytes[0xfefe]!;
    const hi = ram.bytes[0xfeff]!;
    expect((hi << 8) | lo).toBe(0x0103);
  });

  it("im=0 + bus byte 0x00 (NOP) wakes from HALT without push", () => {
    // PC-80S31 sub-CPU IRQ ack: the source asserts NOP (0x00) on the
    // data bus during the IRQ acknowledge cycle. The CPU executes it
    // as a normal opcode — no PC push, no vector dispatch — so the
    // EI;HALT;DI;... sequence the disk ROM uses to wait on FDC
    // completions resumes at the instruction after HALT.
    const h = makeProgramHarness();
    const { cpu, ram } = h;

    ram.bytes[0x0100] = 0xfb; // EI
    ram.bytes[0x0101] = 0x00; // NOP
    ram.bytes[0x0102] = 0x76; // HALT
    ram.bytes[0x0103] = 0xf3; // DI (post-HALT continuation)
    cpu.regs.PC = 0x0100;
    cpu.regs.SP = 0xff00;
    cpu.im = 0;

    cpu.runOneOp(); // EI
    cpu.runOneOp(); // NOP — eiDelay consumed
    cpu.runOneOp(); // HALT
    expect(cpu.halted).toBe(true);

    cpu.requestIrq(0x00);
    cpu.runOneOp(); // IRQ accepted as NOP

    expect(cpu.halted).toBe(false);
    expect(cpu.iff1).toBe(false);
    // No push (SP unchanged), PC unchanged — instruction after HALT
    // executes next.
    expect(cpu.regs.SP).toBe(0xff00);
    expect(cpu.regs.PC).toBe(0x0103);

    cpu.runOneOp(); // DI
    expect(cpu.regs.PC).toBe(0x0104);
  });

  it("forces bit 0 of the vector byte to zero", () => {
    // Real silicon ties D0 of the vector byte to ground for the table
    // read so the low byte address is even. Our acceptance does the
    // same — vector 0x11 reads from I:0x10, not I:0x11.
    const h = makeProgramHarness();
    const { cpu, ram } = h;

    cpu.regs.I = 0x80;
    ram.bytes[0x8010] = 0xcd;
    ram.bytes[0x8011] = 0xab;

    ram.bytes[0x0100] = 0xfb;
    ram.bytes[0x0101] = 0x00;
    ram.bytes[0x0102] = 0x00;
    cpu.regs.PC = 0x0100;
    cpu.regs.SP = 0xff00;
    cpu.im = 2;

    cpu.runOneOp(); // EI
    cpu.runOneOp(); // NOP — eiDelay consumed
    cpu.requestIrq(0x11);
    cpu.runOneOp(); // NOP — IRQ accepted

    expect(cpu.regs.PC).toBe(0xabcd);
  });
});
