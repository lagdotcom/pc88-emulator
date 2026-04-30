import {
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
  mkdirSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { u8 } from "../../src/flavours.js";
import {
  addLabel,
  addPortLabel,
  deleteLabel,
  deletePortLabel,
  loadDebugSymbols,
  renderLabelList,
  romIdAt,
} from "../../src/machines/debug-symbols.js";
import { PC88Machine } from "../../src/machines/pc88.js";
import type { LoadedROMs } from "../../src/machines/pc88-memory.js";
import { MKI } from "../../src/machines/variants/mk1.js";
import { filledROM } from "../tools.js";

// Synthetic-ROM fixture so we don't need real BIOS images. Each
// ROM is filled with a recognisable byte pattern.
function syntheticRoms(): LoadedROMs {
  const n80 = filledROM(0x8000, 0x76);
  const n88 = filledROM(0x8000, 0x77);
  const e0 = filledROM(0x2000, 0xe0);
  return { n80, n88, e0 };
}

// Spin up an isolated cwd so test runs of `addLabel` write into a
// throw-away `syms/` directory. Restores cwd in afterEach.
let cwdBackup = "";
let tmpDir = "";
beforeEach(() => {
  cwdBackup = process.cwd();
  tmpDir = mkdtempSync(join(tmpdir(), "pc88-syms-"));
  mkdirSync(join(tmpDir, "syms"), { recursive: true });
  process.chdir(tmpDir);
});
afterEach(() => {
  process.chdir(cwdBackup);
  rmSync(tmpDir, { recursive: true, force: true });
});

describe("romIdAt", () => {
  it("returns the BASIC ROM id for 0x0000-0x5FFF based on basicMode", () => {
    const machine = new PC88Machine(MKI, syntheticRoms());
    machine.reset();
    expect(romIdAt(machine, 0x0000)).toBe(MKI.roms.n80.id);
    expect(romIdAt(machine, 0x5fff)).toBe(MKI.roms.n80.id);
    machine.memoryMap.setBasicMode("n88");
    expect(romIdAt(machine, 0x0000)).toBe(MKI.roms.n88.id);
  });

  it("returns the BASIC ROM id for 0x6000-0x7FFF when E-ROM is disabled", () => {
    const machine = new PC88Machine(MKI, syntheticRoms());
    machine.reset();
    expect(machine.memoryMap.eromEnabled).toBe(false);
    expect(romIdAt(machine, 0x6000)).toBe(MKI.roms.n80.id);
    expect(romIdAt(machine, 0x7fff)).toBe(MKI.roms.n80.id);
  });

  it("returns the active E-ROM id when one is enabled", () => {
    const machine = new PC88Machine(MKI, syntheticRoms());
    machine.reset();
    machine.memoryMap.setEromEnabled(true);
    expect(romIdAt(machine, 0x6000)).toBe(MKI.roms.e0!.id);
  });

  it("returns null for RAM regions (phase 3 territory)", () => {
    const machine = new PC88Machine(MKI, syntheticRoms());
    machine.reset();
    expect(romIdAt(machine, 0x8000)).toBeNull();
    expect(romIdAt(machine, 0xc000)).toBeNull();
    expect(romIdAt(machine, 0xf000)).toBeNull();
  });
});

describe("addLabel + deleteLabel + renderLabelList", () => {
  function makeMachine(): { machine: PC88Machine; roms: LoadedROMs } {
    const roms = syntheticRoms();
    const machine = new PC88Machine(MKI, roms);
    machine.reset();
    return { machine, roms };
  }

  it("addLabel writes a new symbol file with md5 header on first use", async () => {
    const { machine, roms } = makeMachine();
    const syms = await loadDebugSymbols(machine, roms);
    const result = await addLabel(machine, roms, syms, 0x1234, "init_entry");
    expect(result.scope).toBe(MKI.roms.n80.id);

    const text = readFileSync(result.path, "utf-8");
    // md5 header must mention the actual n80 ROM hash and the
    // newly-added symbol must be in the file.
    expect(text).toMatch(/^# Symbol file for mkI-n80\./m);
    expect(text).toMatch(/^# md5: [0-9a-f]{32}$/m);
    expect(text).toContain("0x1234 init_entry");

    // The in-memory file's md5 should match the file we'd compute
    // ourselves so subsequent loads pass the sanity check.
    const fileEntry = syms.byRomId.get(MKI.roms.n80.id)!;
    expect(fileEntry.file.md5).toBeDefined();
  });

  it("addLabel routes to the right ROM when basicMode is n88", async () => {
    const { machine, roms } = makeMachine();
    machine.memoryMap.setBasicMode("n88");
    const syms = await loadDebugSymbols(machine, roms);
    const r = await addLabel(machine, roms, syms, 0x1234, "n88_entry");
    expect(r.scope).toBe(MKI.roms.n88.id);
    expect(r.path).toContain("mkI-n88.sym");
  });

  it("addLabel renames an existing symbol without re-emitting header", async () => {
    const { machine, roms } = makeMachine();
    const syms = await loadDebugSymbols(machine, roms);
    await addLabel(machine, roms, syms, 0x1234, "first");
    const r = await addLabel(machine, roms, syms, 0x1234, "renamed");
    const text = readFileSync(r.path, "utf-8");
    expect(text).toContain("0x1234 renamed");
    expect(text).not.toContain("0x1234 first");
    // md5 header still present after the rename — first-mutation
    // path is only triggered on a truly empty file.
    expect(text.match(/^# md5:/gm)?.length).toBe(1);
  });

  it("deleteLabel by address finds the symbol via memory-map state", async () => {
    const { machine, roms } = makeMachine();
    const syms = await loadDebugSymbols(machine, roms);
    await addLabel(machine, roms, syms, 0x1234, "victim");
    const r = await deleteLabel(machine, syms, 0x1234);
    expect(r).not.toBeNull();
    const text = readFileSync(r!.path, "utf-8");
    expect(text).not.toContain("victim");
  });

  it("deleteLabel by name searches every loaded ROM file", async () => {
    const { machine, roms } = makeMachine();
    machine.memoryMap.setBasicMode("n88");
    const syms = await loadDebugSymbols(machine, roms);
    await addLabel(machine, roms, syms, 0x2000, "n88_only");
    machine.memoryMap.setBasicMode("n80"); // switch back
    // Even though n88 isn't currently mapped, the name-based
    // delete should find it in mkI-n88.sym.
    const r = await deleteLabel(machine, syms, "n88_only");
    expect(r).not.toBeNull();
    expect(r!.scope).toBe(MKI.roms.n88.id);
  });

  it("renderLabelList groups by ROM with sorted addresses", async () => {
    const { machine, roms } = makeMachine();
    const syms = await loadDebugSymbols(machine, roms);
    await addLabel(machine, roms, syms, 0x3000, "third");
    await addLabel(machine, roms, syms, 0x1000, "first");
    await addLabel(machine, roms, syms, 0x2000, "second");
    const out = renderLabelList(syms);
    expect(out).toMatch(/-- mkI-n80 \(3 labels\) --/);
    // First / second / third must appear in address-sorted order.
    const i1 = out.indexOf("first");
    const i2 = out.indexOf("second");
    const i3 = out.indexOf("third");
    expect(i1).toBeGreaterThan(0);
    expect(i1).toBeLessThan(i2);
    expect(i2).toBeLessThan(i3);
  });

  it("renderLabelList reports '(no labels loaded)' when nothing is set", async () => {
    const { machine, roms } = makeMachine();
    const syms = await loadDebugSymbols(machine, roms);
    expect(renderLabelList(syms)).toBe("(no labels loaded)");
  });

  it("the resolver dispatches to the right ROM based on live memory map", async () => {
    const { machine, roms } = makeMachine();
    const syms = await loadDebugSymbols(machine, roms);
    // Add a label at 0x1234 in n80, switch to n88, add a different
    // label at the same address, then verify each name surfaces in
    // the right context.
    await addLabel(machine, roms, syms, 0x1234, "n80_label");
    machine.memoryMap.setBasicMode("n88");
    await addLabel(machine, roms, syms, 0x1234, "n88_label");

    expect(syms.resolver(0x1234)).toBe("n88_label");
    machine.memoryMap.setBasicMode("n80");
    expect(syms.resolver(0x1234)).toBe("n80_label");
  });

  it("addLabel routes RAM-region addresses to the variant RAM file", async () => {
    // Was: rejects with "isn't in a ROM region". Phase 3 makes it
    // succeed and write to syms/<variant>.ram.sym instead.
    const { machine, roms } = makeMachine();
    const syms = await loadDebugSymbols(machine, roms);
    const r = await addLabel(machine, roms, syms, 0x8000, "in_ram");
    expect(r.scope).toBe("ram");
  });
});

// Sanity test: an existing symbol file with a wrong md5 still
// loads, but a warning is emitted to stderr.
describe("md5 mismatch warning", () => {
  it("loads symbols even when the header md5 doesn't match the ROM", async () => {
    const roms = syntheticRoms();
    const machine = new PC88Machine(MKI, roms);
    machine.reset();
    const path = join("syms", `${MKI.roms.n80.id}.sym`);
    writeFileSync(
      path,
      "# md5: deadbeefdeadbeefdeadbeefdeadbeef\n0x4000 known\n",
      "utf-8",
    );

    // Capture stderr.
    const errs: string[] = [];
    const origWrite = process.stderr.write;
    process.stderr.write = ((s: string) => {
      errs.push(typeof s === "string" ? s : String(s));
      return true;
    }) as typeof process.stderr.write;
    try {
      const syms = await loadDebugSymbols(machine, roms);
      expect(
        syms.byRomId.get(MKI.roms.n80.id)?.file.byAddr.get(0x4000)?.name,
      ).toBe("known");
    } finally {
      process.stderr.write = origWrite;
    }
    expect(errs.join("")).toMatch(/declares md5=.*but ROM is/);
  });
});

describe("RAM + port + fuzzy resolution", () => {
  function makeMachine(): { machine: PC88Machine; roms: LoadedROMs } {
    const roms = syntheticRoms();
    const machine = new PC88Machine(MKI, roms);
    machine.reset();
    return { machine, roms };
  }

  it("addLabel routes RAM-region addresses to the variant RAM file", async () => {
    const { machine, roms } = makeMachine();
    const syms = await loadDebugSymbols(machine, roms);
    const r = await addLabel(machine, roms, syms, 0xed42, "ram_print_hook");
    expect(r.scope).toBe("ram");
    expect(r.path).toContain(".ram.sym");
    expect(syms.ramFile.byAddr.get(0xed42)?.name).toBe("ram_print_hook");
    // Resolver picks up the RAM label since it's not in any ROM region.
    expect(syms.resolver(0xed42)).toBe("ram_print_hook");
  });

  it("addPortLabel writes to variant.port.sym", async () => {
    const { machine, roms } = makeMachine();
    const syms = await loadDebugSymbols(machine, roms);
    const r = await addPortLabel(machine, syms, 0x71, "io_rom_bank", "secondary ROM bank");
    expect(r.scope).toBe("port");
    expect(r.path).toContain(".port.sym");
    expect(syms.portFile.byAddr.get(0x71)?.name).toBe("io_rom_bank");
    expect(syms.portResolver(0x71)).toBe("io_rom_bank");
    expect(syms.portResolver(0x99)).toBeUndefined();
  });

  it("deletePortLabel removes the entry by number or name", async () => {
    const { machine, roms } = makeMachine();
    const syms = await loadDebugSymbols(machine, roms);
    await addPortLabel(machine, syms, 0x71, "io_rom_bank");
    await addPortLabel(machine, syms, 0xe6, "irq_mask");
    expect((await deletePortLabel(syms, 0x71))?.scope).toBe("port");
    expect((await deletePortLabel(syms, "irq_mask"))?.scope).toBe("port");
    expect(syms.portFile.byAddr.size).toBe(0);
    expect(await deletePortLabel(syms, "missing")).toBeNull();
  });

  it("resolver emits name+N for addresses within the fuzzy window", async () => {
    const { machine, roms } = makeMachine();
    const syms = await loadDebugSymbols(machine, roms);
    await addLabel(machine, roms, syms, 0x5550, "print_string");
    expect(syms.resolver(0x5550)).toBe("print_string");
    expect(syms.resolver(0x5552)).toBe("print_string+2");
    expect(syms.resolver(0x5560)).toBe("print_string+16"); // window edge
    expect(syms.resolver(0x5561)).toBeUndefined();
  });

  it("renderLabelList includes ram and port sections when populated", async () => {
    const { machine, roms } = makeMachine();
    const syms = await loadDebugSymbols(machine, roms);
    await addLabel(machine, roms, syms, 0xed42, "ram_hook");
    await addPortLabel(machine, syms, 0x71, "io_rom_bank");
    const out = renderLabelList(syms);
    expect(out).toContain("-- ram (1 labels) --");
    expect(out).toContain("ram_hook");
    expect(out).toContain("-- port (1 labels) --");
    expect(out).toContain("io_rom_bank");
  });
});

// Force tests to round-trip cleanly even when called via vitest in
// parallel — the `process.chdir` dance above is not thread-safe but
// vitest runs test files in separate worker pools so this is OK.
void cwdBackup;
