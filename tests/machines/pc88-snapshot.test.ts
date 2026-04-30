import { describe, expect, it } from "vitest";

import type { u8 } from "../../src/flavours.js";
import { PC88Machine } from "../../src/machines/pc88.js";
import type { LoadedRoms } from "../../src/machines/pc88-memory.js";
import { MKI } from "../../src/machines/variants/mk1.js";
import { filledROM } from "../tools.testHelpers.js";

function syntheticRoms(program: u8[]): LoadedRoms {
  const n80 = filledROM(0x8000, 0x76);
  for (let i = 0; i < program.length; i++) n80[i] = program[i]!;
  const n88 = filledROM(0x8000, 0x76);
  const e0 = filledROM(0x2000, 0x76);
  return { n80, n88, e0 };
}

describe("PC88Machine.snapshot", () => {
  it("aggregates per-chip state into a JSON-friendly object", () => {
    const machine = new PC88Machine(MKI, syntheticRoms([0x00]));
    machine.reset();
    const snap = machine.snapshot();

    // Top-level shape: every stateful chip is represented.
    expect(Object.keys(snap).sort()).toEqual(
      ["beeper", "cpu", "crtc", "dmac", "irq", "memoryMap", "misc", "sysctrl"]
        .sort(),
    );

    // CPU registers reflect post-reset state.
    expect(snap.cpu.PC).toBe(0);
    expect(snap.cpu.SP).toBe(0);
    expect(snap.cpu.iff1).toBe(false);

    // Memory-map state matches the DIP-derived BASIC mode (mkI
    // factory default = N-BASIC).
    expect(snap.memoryMap.basicMode).toBe("n80");
    expect(snap.memoryMap.basicRomEnabled).toBe(true);
    expect(snap.memoryMap.eromSlot).toBe(0);

    // sysctrl, irq, misc carry their startup values.
    expect(snap.sysctrl.dipSwitch1).toBe(MKI.dipSwitches.port30);
    expect(snap.sysctrl.dipSwitch2).toBe(MKI.dipSwitches.port31);
    expect(snap.irq.programmed).toBe(false);
    expect(snap.misc.lastE7).toBeNull();
    expect(snap.misc.lastF8).toBeNull();
  });

  it("is a deep copy — round-tripping through JSON preserves shape", () => {
    // Critical for savestate: the snapshot must be JSON-serialisable
    // and survive a stringify+parse without loss of shape.
    const machine = new PC88Machine(MKI, syntheticRoms([0x00]));
    machine.reset();
    const a = machine.snapshot();
    const b = JSON.parse(JSON.stringify(a)) as typeof a;
    expect(b).toEqual(a);
  });

  it("chip.fromSnapshot round-trips state changes", () => {
    // Mutate per-chip state, snapshot it, reset the chip, then
    // restore — the resulting state should match the snapshot.
    const machine = new PC88Machine(MKI, syntheticRoms([0x00]));
    machine.reset();

    machine.ioBus.write(0x51, 0x00); // CRTC SET MODE start
    machine.ioBus.write(0x50, 0xce);
    machine.ioBus.write(0x50, 0x93);
    machine.ioBus.write(0x50, 0x69);
    machine.ioBus.write(0x50, 0xbe);
    machine.ioBus.write(0x50, 0x13);
    machine.ioBus.write(0xe6, 0x42); // IRQ mask programmed
    machine.ioBus.write(0xe7, 0x55); // misc/0xE7 latch

    const before = machine.snapshot();
    expect(before.crtc.charsPerRow).toBe(80);
    expect(before.irq.mask).toBe(0x42);
    expect(before.misc.lastE7).toBe(0x55);

    // Build a fresh machine and restore from the snapshot.
    const fresh = new PC88Machine(MKI, syntheticRoms([0x00]));
    fresh.reset();
    fresh.crtc.fromSnapshot(before.crtc);
    fresh.irq.fromSnapshot(before.irq);
    fresh.misc.fromSnapshot(before.misc);

    const after = fresh.snapshot();
    expect(after.crtc).toEqual(before.crtc);
    expect(after.irq).toEqual(before.irq);
    expect(after.misc).toEqual(before.misc);
  });
});
