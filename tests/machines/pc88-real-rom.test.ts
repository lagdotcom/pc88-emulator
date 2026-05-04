// Real-ROM integration test. Skipped unless PC88_REAL_ROMS=1 (and
// the ROMs are actually present in PC88_ROM_DIR / `roms/`). Runs
// the full mkI N-BASIC boot path against the BIOS ROM and asserts
// the visible screen contains the banner. Locks in everything we've
// fixed during first-light:
//   - DIP-driven cold-boot BASIC selection
//   - IM 2 vector dispatch through I:0x00
//   - μPD3301 port 0x50/0x51 routing + top-3-bit command decode
//   - 80x20 attribute-mode TVRAM layout (chars at even, attrs at odd)
//   - DMAC channel-2 source as the visible-region offset
//   - E-ROM disabled at reset (BIOS enables when ready)

import { describe, expect, it } from "vitest";

import { kOps } from "../../src/flavour.makers.js";
import { PC88Machine, runMachine } from "../../src/machines/pc88.js";
import type { LoadedROMs } from "../../src/machines/pc88-memory.js";
import { loadRoms } from "../../src/machines/rom-loader.js";
import { MKI } from "../../src/machines/variants/mk1.js";
import { MKII_SR } from "../../src/machines/variants/mk2sr.js";
import { PC88_SHIFT_ROW_COL, pc88KeyFor } from "../tools.js";

// Run the machine until row `row` has been read `count` times. The
// BIOS debounces: a single scan with a key held isn't always
// registered as a press; tests need the key visible across two or
// more consecutive scans of that row. `count = 2` is enough for the
// mkI N-BASIC ROM. Times out after `maxOps`.
function runUntilRowReadCount(
  machine: PC88Machine,
  row: number,
  count: number,
  maxOps: number,
): void {
  let seen = 0;
  const prev = machine.ioBus.tracer;
  machine.ioBus.tracer = (kind, port, value) => {
    if (kind === "r" && (port & 0xff) === row) seen++;
    prev?.(kind, port, value);
  };
  try {
    runMachine(machine, {
      maxOps,
      onProgress: () => (seen >= count ? true : undefined),
    });
  } finally {
    machine.ioBus.tracer = prev;
  }
  if (seen < count) {
    throw new Error(
      `runUntilRowReadCount: row 0x${row.toString(16)} read ${seen}/${count} within ${maxOps} ops`,
    );
  }
}

// Headless type-a-character: press, wait for the BIOS scan to visit
// the pressed row twice (debounce window), release, wait twice more
// (so the key is observed as released, not still held). For shifted
// chars, hold SHIFT around the inner press so both bits are present
// in the same scan window.
function typeChar(machine: PC88Machine, ch: string): void {
  const cap = kOps(40);
  const debounce = 2;
  const k = pc88KeyFor(ch);
  if (k.shift) {
    machine.keyboard.pressKey(PC88_SHIFT_ROW_COL[0], PC88_SHIFT_ROW_COL[1]);
    runUntilRowReadCount(machine, PC88_SHIFT_ROW_COL[0], debounce, cap);
  }
  machine.keyboard.pressKey(k.row, k.col);
  runUntilRowReadCount(machine, k.row, debounce, cap);
  machine.keyboard.releaseKey(k.row, k.col);
  runUntilRowReadCount(machine, k.row, debounce, cap);
  if (k.shift) {
    machine.keyboard.releaseKey(PC88_SHIFT_ROW_COL[0], PC88_SHIFT_ROW_COL[1]);
    runUntilRowReadCount(machine, PC88_SHIFT_ROW_COL[0], debounce, cap);
  }
}

function typeLine(machine: PC88Machine, s: string): void {
  for (const ch of s) typeChar(machine, ch);
}

const REAL = process.env.PC88_REAL_ROMS === "1";
const ROM_DIR = process.env.PC88_ROM_DIR ?? "roms";

describe.runIf(REAL)("PC-8801 mkI N-BASIC boot (real ROMs)", () => {
  it("reaches the BASIC banner in the visible screen at 150k ops", async () => {
    const loaded = await loadRoms(MKI, { dir: ROM_DIR });
    if (!loaded.n80 || !loaded.n88) {
      throw new Error(
        `mkI requires n80 and n88 ROMs in ${ROM_DIR}/ (got ${Object.keys(loaded).join(", ")})`,
      );
    }
    const machine = new PC88Machine(MKI, loaded as LoadedROMs);
    machine.reset();
    runMachine(machine, { maxOps: kOps(150) });

    // CRTC programmed, DMAC ch2 pointed at the screen, display on.
    expect(machine.crtc.charsPerRow).toBe(80);
    expect(machine.crtc.rowsPerScreen).toBe(20);
    expect(machine.crtc.displayOn).toBe(true);
    expect(machine.dmac.channelAddress(2)).toBe(0xf300);
    expect(machine.dmac.channelByteCount(2)).toBe(2400);

    // The banner the ROM lays into TVRAM. toAsciiDump renders just
    // the visible region, so each of these strings must appear in
    // the rendered grid.
    const dump = machine.display.toASCIIDump();
    expect(dump).toContain("NEC PC-8001 BASIC Ver 1.2");
    expect(dump).toContain("Copyright 1979 (C) by Microsoft");
    expect(dump).toContain("Ok");
  });

  it("N-BASIC: types a hello world program, lists it, runs it", async () => {
    // From the "Ok" prompt we feed the full BASIC dialogue through
    // the keyboard matrix:
    //   10 print "hello world"<CR>
    //   list<CR>                  -> BIOS echoes line + canonical "10 PRINT ..."
    //   run<CR>                   -> BIOS echoes "run" + program output
    //
    // typeChar synchronises with the BIOS scan via the IOBus tracer
    // (waits for the pressed row to be re-read) — no fragile op-count
    // timing. After each line we run a fixed budget for the BIOS to
    // tokenise / interpret / render before the next assertion.
    const loaded = await loadRoms(MKI, { dir: ROM_DIR });
    if (!loaded.n80 || !loaded.n88) return;
    const machine = new PC88Machine(MKI, loaded as LoadedROMs);
    machine.reset();
    runMachine(machine, { maxOps: kOps(150) });

    typeLine(machine, '10 print "hello world"\r');
    runMachine(machine, { maxOps: kOps(40) });
    typeLine(machine, "list\r");
    runMachine(machine, { maxOps: kOps(80) });
    typeLine(machine, "run\r");
    runMachine(machine, { maxOps: kOps(120) });

    const dump = machine.display.toASCIIDump();
    expect(dump).toContain('10 print "hello world"');
    // LIST canonicalises the keyword to uppercase but leaves the
    // string literal alone.
    expect(dump).toContain('10 PRINT "hello world"');
    expect(dump).toContain("run");
    // "hello world" should appear three times: in the typed line, in
    // the LIST canonical re-print, and as RUN's standalone output.
    // Counting catches the case where RUN runs but produces no output
    // (the bare-toContain check would still pass on the typed/LIST
    // copies).
    expect(dump.match(/hello world/g)?.length).toBe(3);
  });

  it("--basic=n88 path: BIOS reaches the disk-files prompt", async () => {
    // Locks in N88 boot reaching its first user-visible output: the
    // "How many files(0-15)?" disk-config prompt. Boot then stalls
    // waiting for keyboard input (no input source wired to the key
    // matrix yet) — when that lands, this assertion can be extended
    // to cover the full banner past the prompt.
    const loaded = await loadRoms(MKI, { dir: ROM_DIR });
    if (!loaded.n80 || !loaded.n88) return;
    const config = {
      ...MKI,
      dipSwitches: {
        ...MKI.dipSwitches,
        port31: MKI.dipSwitches.port31 & ~0x04,
      },
    };
    const machine = new PC88Machine(config, loaded as LoadedROMs);
    machine.reset();
    runMachine(machine, { maxOps: kOps(250) });

    expect(machine.memoryMap.basicMode).toBe("n88");
    expect(machine.crtc.charsPerRow).toBe(80);
    expect(machine.crtc.displayOn).toBe(true);
    // N88 explicitly programs the IRQ mask (N-BASIC leaves it at
    // factory default 0xff). Capturing this so we notice if the
    // boot path changes.
    expect(machine.irq.programmed).toBe(true);

    expect(machine.display.toASCIIDump()).toContain("How many files(0-15)?");
  });

  it("--basic=n88 path: answers the prompt and reaches the BASIC banner", async () => {
    // Real silicon reaches the banner past "How many files(0-15)?"
    // only after the user types '0' Return. The keystroke is decoded
    // by the RTC-driven keyboard ISR, which queues the ASCII char
    // into a RAM mailbox the BIOS's polling loop drains. We don't
    // drive RTC IRQs yet (would also need a valid IM 2 vector table
    // — the BIOS LDIRs one to 0xf300 then wipes it again before the
    // prompt), so the matrix scan never fires.
    //
    // To still verify the post-prompt path runs, we forge the ISR's
    // output directly: the mailbox head pointer lives at 0xE6CB; we
    // poke the char field, the BIOS picks it up and processes as if
    // the user typed it. Specific to mkI N88 ROM
    // md5=22be239bc0c4298bc0561252eed98633 (validated by loadRoms).
    const loaded = await loadRoms(MKI, { dir: ROM_DIR });
    if (!loaded.n80 || !loaded.n88) return;
    const config = {
      ...MKI,
      dipSwitches: {
        ...MKI.dipSwitches,
        port31: MKI.dipSwitches.port31 & ~0x04,
      },
    };
    const machine = new PC88Machine(config, loaded as LoadedROMs);
    machine.reset();
    runMachine(machine, { maxOps: kOps(250) });

    const ram = machine.memoryMap.mainRam;
    const mailbox = ram[0xe6cb]! | (ram[0xe6cc]! << 8);
    const charField = (mailbox + 2) & 0xffff;

    ram[charField] = 0x30; // '0'
    runMachine(machine, { maxOps: kOps(50) });

    ram[charField] = 0x0d; // Return
    runMachine(machine, { maxOps: kOps(50) });

    const dump = machine.display.toASCIIDump();
    expect(dump).toContain("How many files(0-15)?");
    expect(dump).toContain("NEC N-88 BASIC");
    expect(dump).toContain("Copyright (C) 1981 by Microsoft");
    expect(dump).toContain("Ok");
  });
});

describe.runIf(REAL)("PC-8801 mkII SR N88-BASIC boot (real ROMs)", () => {
  it("reaches the disk-files prompt", { timeout: 30_000 }, async () => {
    // Locks in the SR-N88 boot path past the bypass-handler chain
    // that previously left E-ROM enabled at the unwind to 0x7842.
    // The fix landed in commit e26d66b: aligning port 0x71 with
    // MAME (only bit 0 gates enable; bits 1-3 are MAME-TODO and
    // do NOT pick a slot) made the BIOS's POST writes —
    // 0xfd, 0xfb, 0xf7, 0xef, 0xdf, 0xbf, 0x7f — correctly
    // disable E-ROM instead of enabling it with the wrong slot.
    // Once the POST sequence ends with port 0x71 = 0xff, E-ROM
    // is properly off and the unwind back to sr_disk_detect
    // reads the correct sr-n88 byte at 0x7842.
    const loaded = await loadRoms(MKII_SR, { dir: ROM_DIR });
    if (!loaded.n88 || !loaded.e0) {
      throw new Error(
        `SR requires n88 + e0..e3 ROMs in ${ROM_DIR}/ (got ${Object.keys(loaded).join(", ")})`,
      );
    }
    const config = {
      ...MKII_SR,
      dipSwitches: {
        ...MKII_SR.dipSwitches,
        // N88 mode = port31 bit 2 cleared (RMODE).
        port31: MKII_SR.dipSwitches.port31 & ~0x04,
      },
    };
    const machine = new PC88Machine(config, loaded as LoadedROMs);
    machine.reset();
    runMachine(machine, { maxOps: kOps(30000) });

    expect(machine.display.toASCIIDump()).toContain("How many files(0-15)?");
  });
});
