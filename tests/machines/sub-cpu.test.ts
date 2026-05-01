import { describe, expect, it } from "vitest";

import { μPD8255 } from "../../src/chips/io/μPD8255.js";
import { IOBus } from "../../src/core/IOBus.js";
import { SubCPU } from "../../src/machines/sub-cpu.js";

// Sub-CPU test ROM: echo + 1.
//   IN  A,(0xFD)   ; read incoming byte from main side
//   INC A
//   OUT (0xFC),A   ; write outgoing byte back
//   HALT
const ECHO_PLUS_ONE = new Uint8Array([
  0xdb, 0xfd, 0x3c, 0xd3, 0xfc, 0x76,
]);

function setup(rom: Uint8Array = ECHO_PLUS_ONE) {
  const ppi = new μPD8255();
  const main = new IOBus();
  ppi.registerMain(main);
  const sub = new SubCPU({ rom, ppi });
  sub.reset();
  return { ppi, main, sub };
}

describe("SubCPU memory map", () => {
  it("exposes the ROM at 0x0000-0x1FFF (mirrored within the region)", () => {
    const rom = new Uint8Array([0xaa, 0xbb, 0xcc, 0xdd]);
    const { sub } = setup(rom);
    expect(sub.memBus.read(0x0000)).toBe(0xaa);
    expect(sub.memBus.read(0x0003)).toBe(0xdd);
    expect(sub.memBus.read(0x0004)).toBe(0xaa);
    expect(sub.memBus.read(0x1000)).toBe(0xaa);
    expect(sub.memBus.read(0x1fff)).toBe(0xdd);
  });

  it("RAM is read/write at 0x4000-0x7FFF and reset clears it", () => {
    const { sub } = setup();
    sub.memBus.write(0x4000, 0x42);
    sub.memBus.write(0x7fff, 0x99);
    expect(sub.memBus.read(0x4000)).toBe(0x42);
    expect(sub.memBus.read(0x7fff)).toBe(0x99);
    sub.reset();
    expect(sub.memBus.read(0x4000)).toBe(0);
    expect(sub.memBus.read(0x7fff)).toBe(0);
  });
});

describe("SubCPU peripheral ports", () => {
  it("port 0xF0 latches the IRQ vector", () => {
    const { sub } = setup();
    sub.ioBus.write(0xf0, 0x42);
    expect(sub.irqVector).toBe(0x42);
  });

  it("port 0xF4 latches the drive mode", () => {
    const { sub } = setup();
    sub.ioBus.write(0xf4, 0x9c);
    expect(sub.driveMode).toBe(0x9c);
  });
});

describe("SubCPU end-to-end IPC via PPI", () => {
  it("runs an echo+1 program through main → sub → main", () => {
    const { main, sub } = setup();

    main.write(0xfc, 0x41);
    sub.runOps(8);

    expect(sub.cpu.halted).toBe(true);
    expect(main.read(0xfd)).toBe(0x42);
  });

  it("survives multiple round trips after re-priming the program", () => {
    const { main, sub } = setup();
    for (const x of [0x10, 0x55, 0xfe]) {
      sub.reset();
      main.write(0xfc, x);
      sub.runOps(8);
      expect(main.read(0xfd)).toBe((x + 1) & 0xff);
    }
  });
});

describe("SubCPU runner termination", () => {
  it("runOps stops on HALT and returns the executed op count", () => {
    const { sub } = setup();
    const ran = sub.runOps(64);
    expect(sub.cpu.halted).toBe(true);
    expect(ran).toBeLessThan(64);
    expect(ran).toBeGreaterThan(0);
  });

  it("runCycles stops on HALT and reports cycles consumed", () => {
    const { sub } = setup();
    const cycles = sub.runCycles(1000);
    expect(sub.cpu.halted).toBe(true);
    expect(cycles).toBeGreaterThan(0);
    expect(cycles).toBeLessThan(1000);
  });
});

describe("SubCPU snapshot / restore", () => {
  it("round-trips registers + cycles + irq vector + drive mode", () => {
    const { sub } = setup();
    sub.ioBus.write(0xf0, 0xa5);
    sub.ioBus.write(0xf4, 0x5a);
    sub.runOps(2);
    const snap = sub.snapshot();

    const { sub: fresh } = setup();
    fresh.fromSnapshot(snap);
    expect(fresh.snapshot()).toEqual(snap);
  });

  it("survives JSON round-trip", () => {
    const { sub } = setup();
    sub.runOps(3);
    const snap = JSON.parse(JSON.stringify(sub.snapshot()));
    const { sub: fresh } = setup();
    fresh.fromSnapshot(snap);
    expect(fresh.cpu.regs.PC).toBe(snap.cpu.PC);
    expect(fresh.cpu.cycles).toBe(snap.cpu.cycles);
  });
});
