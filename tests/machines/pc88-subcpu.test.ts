import { describe, expect, it } from "vitest";

import { kOps } from "../../src/flavour.makers.js";
import type { u8 } from "../../src/flavours.js";
import type { PC88Config } from "../../src/machines/config.js";
import { PC88Machine, runMachine } from "../../src/machines/pc88.js";
import type { LoadedROMs } from "../../src/machines/pc88-memory.js";
import { MKI } from "../../src/machines/variants/mk1.js";
import { buildTestDisk, filledROM, SUBCPU_ECHO_PLUS_ONE } from "../tools.js";

// Padded to the variant descriptor's 2 KB so SubCPU's ROM mirror
// region behaves the same as it would with a real PC-8031 image.
function echoPlusOneRom(): Uint8Array {
  const rom = new Uint8Array(2048).fill(0x00);
  rom.set(SUBCPU_ECHO_PLUS_ONE, 0);
  return rom;
}

function syntheticRoms(program: u8[], opts: { withDisk?: boolean } = {}): LoadedROMs {
  const n80 = filledROM(0x8000, 0x76);
  for (let i = 0; i < program.length; i++) n80[i] = program[i]!;
  const n88 = filledROM(0x8000, 0x76);
  const e0 = filledROM(0x2000, 0x76);
  const base = { n80, n88, e0 };
  return opts.withDisk ? { ...base, disk: echoPlusOneRom() } : base;
}

const MKII_LIKE: PC88Config = {
  ...MKI,
  disk: { ...MKI.disk, hasSubCpu: true },
};

describe("PC88Machine + SubCPU wiring", () => {
  it("does not create a SubCPU when hasSubCpu is false", () => {
    const machine = new PC88Machine(MKI, syntheticRoms([0x00]));
    expect(machine.subcpu).toBeNull();
    expect(machine.ppi).toBeNull();
  });

  it("does not create a SubCPU if hasSubCpu but disk ROM is missing", () => {
    const machine = new PC88Machine(MKII_LIKE, syntheticRoms([0x00]));
    expect(machine.subcpu).toBeNull();
    expect(machine.ppi).toBeNull();
  });

  it("creates SubCPU + PPI when both conditions are met", () => {
    const machine = new PC88Machine(
      MKII_LIKE,
      syntheticRoms([0x00], { withDisk: true }),
    );
    expect(machine.subcpu).not.toBeNull();
    expect(machine.ppi).not.toBeNull();
  });

  it("PPI is registered on the main IOBus at 0xFC-0xFF", () => {
    const machine = new PC88Machine(
      MKII_LIKE,
      syntheticRoms([0x00], { withDisk: true }),
    );
    expect(machine.ppi).not.toBeNull();
    machine.ioBus.write(0xfc, 0xa5);
    expect(machine.ppi!.hasFreshForSub()).toBe(true);
  });
});

describe("PC88Machine.snapshot with SubCPU", () => {
  it("emits null subcpu/ppi entries on hasSubCpu=false variants", () => {
    const machine = new PC88Machine(MKI, syntheticRoms([0x00]));
    machine.reset();
    const snap = machine.snapshot();
    expect(snap.subcpu).toBeNull();
    expect(snap.ppi).toBeNull();
  });

  it("emits real subcpu/ppi entries on hasSubCpu=true variants", () => {
    const machine = new PC88Machine(
      MKII_LIKE,
      syntheticRoms([0x00], { withDisk: true }),
    );
    machine.reset();
    const snap = machine.snapshot();
    expect(snap.subcpu).not.toBeNull();
    expect(snap.ppi).not.toBeNull();
    expect(snap.subcpu!.cpu.PC).toBe(0);
  });

  it("reset propagates to the sub-CPU", () => {
    const machine = new PC88Machine(
      MKII_LIKE,
      syntheticRoms([0x00], { withDisk: true }),
    );
    machine.subcpu!.cpu.regs.PC = 0x1234;
    machine.subcpu!.cpu.cycles = 9999;
    machine.reset();
    expect(machine.subcpu!.cpu.regs.PC).toBe(0);
    expect(machine.subcpu!.cpu.cycles).toBe(0);
  });
});

describe("runMachine schedules both CPUs", () => {
  it("advances sub-CPU cycles alongside main", () => {
    // Main program: tight `JR $` loop so the runner exhausts ops
    // budget. Sub-CPU runs the echo+1 program and HALTs.
    //   0x0000  18 FE         JR $
    const machine = new PC88Machine(
      MKII_LIKE,
      syntheticRoms([0x18, 0xfe], { withDisk: true }),
    );
    machine.reset();
    runMachine(machine, { maxOps: kOps(1) });
    expect(machine.subcpu!.cpu.cycles).toBeGreaterThan(0);
    expect(machine.subcpu!.cpu.halted).toBe(true);
  });

  it("runs the full IPC round-trip end-to-end", () => {
    // Main ROM: a tight JR-self loop so the runner spends its ops
    // budget on the sub-CPU. The PPI is primed via the direct-poke
    // API; the bus-only path is exercised separately below.
    //   0x0000  18 FE        JR $
    const machine = new PC88Machine(
      MKII_LIKE,
      syntheticRoms([0x18, 0xfe], { withDisk: true }),
    );
    machine.reset();
    machine.ppi!.pokeMainOutgoing(0x41);

    runMachine(machine, { maxOps: kOps(1) });

    expect(machine.subcpu!.cpu.halted).toBe(true);
    expect(machine.ioBus.read(0xfd)).toBe(0x42);
    expect(machine.ppi!.hasFreshForMain()).toBe(false);
  });

  it("HALTed sub-CPU wakes on a bus-only PPI write and round-trips", () => {
    // Sub-CPU disk ROM:
    //   0x0000  ED 56        IM 1
    //   0x0002  FB           EI
    //   0x0003  76           HALT          ; wait for PPI wake
    //   0x0038  DB FD        IN  A,(0xFD)  ; consume incoming byte
    //   0x003A  3C           INC A
    //   0x003B  D3 FC        OUT (0xFC),A  ; reply
    //   0x003D  76           HALT
    const sub: u8[] = new Array(0x40).fill(0);
    sub[0x00] = 0xed; sub[0x01] = 0x56;
    sub[0x02] = 0xfb;
    sub[0x03] = 0x76;
    sub[0x38] = 0xdb; sub[0x39] = 0xfd;
    sub[0x3a] = 0x3c;
    sub[0x3b] = 0xd3; sub[0x3c] = 0xfc;
    sub[0x3d] = 0x76;

    const subRom = new Uint8Array(2048).fill(0x00);
    subRom.set(sub, 0);

    // Main ROM:
    //   0x0000  3E 41        LD  A,0x41
    //   0x0002  D3 FC        OUT (0xFC),A   ; bus-only — wakes sub
    //   0x0004  18 FE        JR $
    const main: u8[] = [0x3e, 0x41, 0xd3, 0xfc, 0x18, 0xfe];

    const n80 = filledROM(0x8000, 0x76);
    for (let i = 0; i < main.length; i++) n80[i] = main[i]!;
    const machine = new PC88Machine(MKII_LIKE, {
      n80,
      n88: filledROM(0x8000, 0x76),
      e0: filledROM(0x2000, 0x76),
      disk: subRom,
    });
    machine.reset();

    runMachine(machine, { maxOps: kOps(1) });

    expect(machine.subcpu!.cpu.halted).toBe(true);
    expect(machine.ioBus.read(0xfd)).toBe(0x42);
  });
});

describe("PC88Machine drive attachment", () => {
  it("creates default 2 drives and attaches them to the FDC", () => {
    const machine = new PC88Machine(
      MKII_LIKE,
      syntheticRoms([0x00], { withDisk: true }),
    );
    expect(machine.floppy.length).toBe(2);
    // FDC.attachDrive throws on out-of-range; we can verify the
    // attachment indirectly by calling sense-drive-status on each
    // drive index and checking we don't get the "no drive" path.
    // (insertDisk + isReady is more direct.)
    const disk = buildTestDisk();
    machine.insertDisk(0, disk);
    expect(machine.floppy[0]!.hasDisk()).toBe(true);
    expect(machine.floppy[0]!.motorOn).toBe(true);
  });

  it("no drives when the variant declares hasSubCpu=false (mkI default)", () => {
    const machine = new PC88Machine(MKI, syntheticRoms([0x00]));
    expect(machine.floppy.length).toBe(0);
    expect(() => machine.insertDisk(0, buildTestDisk())).toThrow(
      /drive 0 doesn't exist/,
    );
  });

  it("opts.enableDiskSubsystem forces the wiring on a hasSubCpu=false variant", () => {
    // mkI has count=0; the override should default to 2 drives so
    // an inserted disk has somewhere to land.
    const machine = new PC88Machine(
      MKI,
      syntheticRoms([0x00], { withDisk: true }),
      { enableDiskSubsystem: true },
    );
    expect(machine.subcpu).not.toBeNull();
    expect(machine.floppy.length).toBe(2);
    const disk = buildTestDisk();
    machine.insertDisk(0, disk);
    expect(machine.floppy[0]!.hasDisk()).toBe(true);
  });

  it("insertDisk sets motorOn so isReady() is true immediately", () => {
    const machine = new PC88Machine(
      MKII_LIKE,
      syntheticRoms([0x00], { withDisk: true }),
    );
    machine.insertDisk(0, buildTestDisk());
    expect(machine.floppy[0]!.isReady()).toBe(true);
  });
});
