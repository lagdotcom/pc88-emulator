import { makeROM, type PC88Config } from "../config.js";

// PC-88 VA (1987): a major architectural shift from the rest of the
// PC-8801 line. Uses the μPD9002 — a Z80-compatible CPU that also
// runs 8086 code, allowing N88-V3 mode (640×400 256-colour graphics
// + 16-bit native software).
//
// MAME models VA in a separate driver (`mame/src/mame/nec/pc88va.cpp`)
// not included in our refs/ slice. Without that file we can't list
// the exact port map or ROM hashes — most of the I/O surface differs
// from the 8-bit PC-8801 lineup. The fields below are best-effort
// guesses; treat as documentation only until the VA boot is tackled
// as its own milestone.
const VA_N88 = makeROM("va-n88", 64, "todo-md5", false);

// VBASIC is the V3-mode interpreter shipped on VA. It'll need its
// own slot in ROMManifest when VA boot is wired up; sketched here so
// it shows up in grep but not yet included in the loaded set:
//   makeROM("va-vbasic", 128, "todo-md5", false)

export const VA: PC88Config = {
  model: "PC-88 VA",
  nicknames: ["va", "pc88va"],
  releaseYear: 1987,
  // μPD9002: hybrid Z80/8086 — `main` is the canonical "executes Z80
  // opcodes" mode, but the chip can also enter native V3-mode where
  // it executes 8086 instructions instead. We don't yet model the
  // mode switch.
  cpu: { main: "μPD9002", sub: "μPD780C-1", highSpeedMode: true },
  memory: {
    // VA shipped with 256 KB extended RAM as standard; the original
    // PC-8801 64 KB main bank is preserved as a compatibility plane.
    mainRam: 64,
    textVram: 4,
    tvramSeparate: true,
    graphicsVramPlanes: 3,
    graphicsVramPerPlane: 16,
    hasExtendedRam: true,
  },
  video: {
    // V3 (640×400×256) is unique to the VA family. V1/V2 are
    // preserved for PC-8801 compatibility software.
    modes: ["N", "V1", "V2", "V3"],
    hasAnaloguePalette: true,
    hasKanjiRom: true,
  },
  // VA shipped with a YM2608 OPNA-compatible chip for sound.
  sound: { psg: "YM2608" },
  disk: { count: 2, model: "μPD765a", hasSubCpu: true },
  dipSwitches: {
    port30: 0b1111_1011,
    port31: 0b1110_1101,
  },
  // ROM lineup is mostly unverified. n88 is required for 8-bit
  // compat boot; VBASIC is the V3-mode interpreter shipped on VA.
  // E0..E3, kanji, font etc. exist on VA but the file IDs and
  // sizes haven't been confirmed against MAME's pc88va driver.
  roms: {
    n80: makeROM("va-n80", 32, "todo-md5", false),
    n88: VA_N88,
    e0: makeROM("va-e0", 8, "todo-md5", false),
  },
};
