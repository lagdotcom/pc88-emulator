import { describe, expect, it } from "vitest";

import { PC88Machine, runMachine } from "../../src/machines/pc88.js";
import type { LoadedRoms } from "../../src/machines/pc88-memory.js";
import { MKI } from "../../src/machines/variants/mk1.js";

function syntheticRoms(program: number[]): LoadedRoms {
  const n80 = new Uint8Array(0x8000);
  n80.fill(0x76);
  for (let i = 0; i < program.length; i++) n80[i] = program[i]!;
  const n88 = new Uint8Array(0x8000);
  n88.fill(0x76);
  const e0 = new Uint8Array(0x2000);
  e0.fill(0x76);
  return { n80, n88, e0 };
}

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

  it("delivers VBL when bit 0 of the IRQ mask is set (default)", () => {
    const machine = new PC88Machine(MKI, syntheticRoms(HALT_WITH_EI));
    machine.reset();
    // I = 0; vector 0x00 → IM 2 reads PC from RAM[0x0000-0x0001].
    // The synthetic ROM at PC=0 starts with `ED 5E` so the indirect
    // load reads 0x5EED; the test only cares that IRQs DO get
    // delivered, so we don't follow the post-jump path — running
    // 5M cycles is enough to see ~75 VBL pulses' worth of activity.
    const result = runMachine(machine, { maxCycles: 5_000_000 });
    expect(result.vblIrqsRaised).toBeGreaterThan(0);
    expect(result.vblIrqsMasked).toBe(0);
  });

  it("suppresses VBL delivery when bit 0 of the IRQ mask is clear", () => {
    const machine = new PC88Machine(MKI, syntheticRoms(HALT_WITH_EI));
    machine.reset();
    // Mask all interrupt sources.
    machine.ioBus.write(0xe6, 0x00);
    expect(machine.irq.vblMasked()).toBe(true);

    const result = runMachine(machine, { maxCycles: 5_000_000 });
    expect(result.vblIrqsRaised).toBe(0);
    expect(result.vblIrqsMasked).toBeGreaterThan(0);
    // Stays in HALT the whole time because no IRQ ever wakes it.
    expect(machine.cpu.halted).toBe(true);
    // The runner still drives the VBL status bits on sysctrl + crtc
    // each pulse — only IRQ delivery is gated. Polling-based BIOS
    // code will still see vsync.
  });
});
