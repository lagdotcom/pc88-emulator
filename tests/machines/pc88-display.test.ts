import { describe, expect, it } from "vitest";

import { PC88Machine, runMachine } from "../../src/machines/pc88.js";
import type { LoadedRoms } from "../../src/machines/pc88-memory.js";
import { MKI } from "../../src/machines/variants/mk1.js";

function syntheticRoms(program: number[]): LoadedRoms {
  const n80 = new Uint8Array(0x8000);
  n80.fill(0x76); // HALT
  for (let i = 0; i < program.length; i++) n80[i] = program[i]!;
  const n88 = new Uint8Array(0x8000);
  n88.fill(0x76);
  const e0 = new Uint8Array(0x2000);
  e0.fill(0x76);
  return { n80, n88, e0 };
}

// Helper: drop a string into TVRAM at the given absolute address as
// 2-byte cells (char + 0x00 attribute).
function fillTextCells(machine: PC88Machine, addr: number, s: string): void {
  const tvramOffset = addr - 0xf000;
  for (let i = 0; i < s.length; i++) {
    machine.memoryMap.tvram[tvramOffset + i * 2] = s.charCodeAt(i);
    machine.memoryMap.tvram[tvramOffset + i * 2 + 1] = 0;
  }
}

describe("PC88TextDisplay visible region", () => {
  it("returns a placeholder when the CRTC has not been programmed", () => {
    const machine = new PC88Machine(MKI, syntheticRoms([0x76])); // HALT
    machine.reset();
    runMachine(machine, { maxOps: 10 });
    const dump = machine.display.toAsciiDump();
    expect(dump).toMatch(/CRTC not yet programmed/);
  });

  it("renders the CRTC+DMAC-fetched region when SET MODE has run", () => {
    // Program the machine the way N-BASIC does: SET MODE for an
    // 80-byte cell run × 20 rows, DMAC ch2 source = 0xF300, then
    // drop "HELLO" at the top-left of the visible region.
    const machine = new PC88Machine(MKI, syntheticRoms([0x76]));
    machine.reset();

    // CRTC SET MODE (cmd 0x00, 5 params: 80x20, etc.)
    machine.ioBus.write(0x51, 0x00);
    machine.ioBus.write(0x50, 0xce);
    machine.ioBus.write(0x50, 0x93);
    machine.ioBus.write(0x50, 0x69);
    machine.ioBus.write(0x50, 0xbe);
    machine.ioBus.write(0x50, 0x13);

    // DMAC ch2 source = 0xF300 (low byte then high byte).
    machine.ioBus.write(0x64, 0x00);
    machine.ioBus.write(0x64, 0xf3);

    fillTextCells(machine, 0xf300, "HELLO");

    const dump = machine.display.toAsciiDump();
    const lines = dump.split("\n");
    expect(lines[0]).toBe("HELLO");
    expect(lines).toHaveLength(20);
  });

  it("honours the DMAC source offset when it isn't 0xF000", () => {
    // The first 0x300 bytes of TVRAM are off-screen scratch when
    // DMAC ch2 starts at 0xF300; bytes there must NOT show up in
    // the visible dump.
    const machine = new PC88Machine(MKI, syntheticRoms([0x76]));
    machine.reset();
    machine.ioBus.write(0x51, 0x00);
    machine.ioBus.write(0x50, 0xce);
    machine.ioBus.write(0x50, 0x93);
    machine.ioBus.write(0x50, 0x69);
    machine.ioBus.write(0x50, 0xbe);
    machine.ioBus.write(0x50, 0x13);
    machine.ioBus.write(0x64, 0x00);
    machine.ioBus.write(0x64, 0xf3);

    fillTextCells(machine, 0xf000, "OFFSCREEN");
    fillTextCells(machine, 0xf300, "VISIBLE");

    const dump = machine.display.toAsciiDump();
    expect(dump).not.toMatch(/OFFSCREEN/);
    expect(dump).toMatch(/^VISIBLE/);
  });

  it("rawTvramDump shows the full 4 KB regardless of CRTC state", () => {
    const machine = new PC88Machine(MKI, syntheticRoms([0x76]));
    machine.reset();
    fillTextCells(machine, 0xf000, "OFFSCREEN");
    const dump = machine.display.rawTvramDump();
    // 4 KB / 16 bytes per line = 256 lines.
    expect(dump.split("\n")).toHaveLength(256);
    // First line should contain the 'O' 'F' 'F' bytes interleaved
    // with 0x00 attributes.
    expect(dump.split("\n")[0]).toContain("4f 00 46 00 46 00");
    expect(dump.split("\n")[0]).toContain("O.F.F.");
  });
});
