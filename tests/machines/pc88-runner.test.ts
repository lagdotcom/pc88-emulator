import { describe, expect, it } from "vitest";

import { mCycles } from "../../src/flavour.makers.js";
import type { u8 } from "../../src/flavours.js";
import { PC88Machine, runMachine } from "../../src/machines/pc88.js";
import type { LoadedROMs } from "../../src/machines/pc88-memory.js";
import { MKI } from "../../src/machines/variants/mk1.js";
import { filledROM } from "../tools.js";

function syntheticRoms(program: u8[]): LoadedROMs {
  const n80 = filledROM(0x8000, 0x76);
  for (let i = 0; i < program.length; i++) n80[i] = program[i]!;

  const n88 = filledROM(0x8000, 0x76);
  const e0 = filledROM(0x2000, 0x76);

  return { n80, n88, e0 };
}

const MAX_CYCLES = mCycles(5);

describe("runMachine VBL gating via IRQ mask register", () => {
  // Program that arms IFF1 and HALTs at 0x0002. With IFF1=true the
  // halted-no-irq stop doesn't fire; the runner is free to inject
  // VBL pulses and accept them — unless the IRQ mask blocks delivery.
  const HALT_WITH_EI = [
    0xed,
    0x5e, // IM 2
    0xfb, // EI
    0x76, // HALT
  ];

  it("delivers VBL when bit 2 of the IRQ mask is set (default)", () => {
    const machine = new PC88Machine(MKI, syntheticRoms(HALT_WITH_EI));
    machine.reset();
    // I = 0; vector 0x04 → IM 2 reads PC from RAM[0x0004-0x0005].
    // The synthetic ROM at PC=0 starts with `ED 5E FB 76` so the
    // indirect load at 0x0004 reads two HALT bytes (0x7676); the test
    // only cares that IRQs DO get delivered, not what they jump to —
    // 5M cycles covers ~75 VBL pulses.
    const result = runMachine(machine, { maxCycles: MAX_CYCLES });
    expect(result.vblIrqsRaised).toBeGreaterThan(0);
    expect(result.vblIrqsMasked).toBe(0);
  });

  it("suppresses VBL delivery when bit 2 of the IRQ mask is clear", () => {
    const machine = new PC88Machine(MKI, syntheticRoms(HALT_WITH_EI));
    machine.reset();
    // Mask all interrupt sources.
    machine.ioBus.write(0xe6, 0x00);
    expect(machine.irq.vblMasked()).toBe(true);

    const result = runMachine(machine, { maxCycles: MAX_CYCLES });
    expect(result.vblIrqsRaised).toBe(0);
    expect(result.vblIrqsMasked).toBeGreaterThan(0);
    // Stays in HALT the whole time because no IRQ ever wakes it.
    expect(machine.cpu.halted).toBe(true);
    // The runner still drives the VBL status bits on sysctrl + crtc
    // each pulse — only IRQ delivery is gated. Polling-based BIOS
    // code will still see vsync.
  });
});
