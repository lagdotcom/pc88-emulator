import { makeROM, type PC88Config } from "../config.js";
import { MKI_DISC, MKI_KANJI1 } from "./mk1.js";
import { MH_KANJI2, MH_N80 } from "./mh.js";

// PC-8801 FA (1987): same FH/MH-class hardware (Z80 4/8 MHz, OPNA,
// V2 mode) with newer firmware. MAME's `pc8801fa` state class is
// pc8801fh_state — no electrical changes from MH.
//
// MAME's pc8801fa ROM_START shares fa_n80.rom with MH (same CRC).
// The n88 and E1-E3 ROMs are FA-specific (newer BASIC versions
// "2.3 V2 / 1.9 V1" per MAME comment).
export const FA_N88 = makeROM("fa-n88", 32, "todo-md5");
export const FA_E0 = makeROM("fa-e0", 8, "todo-md5");
export const FA_E1 = makeROM("fa-e1", 8, "todo-md5");
export const FA_E2 = makeROM("fa-e2", 8, "todo-md5");
export const FA_E3 = makeROM("fa-e3", 8, "todo-md5");

export const FA: PC88Config = {
  model: "PC-8801 FA",
  nicknames: ["fa"],
  releaseYear: 1987,
  cpu: { main: "μPD780C-1", sub: "μPD780C-1", highSpeedMode: true },
  memory: {
    mainRam: 64,
    textVram: 4,
    tvramSeparate: true,
    graphicsVramPlanes: 3,
    graphicsVramPerPlane: 16,
    hasExtendedRam: false,
  },
  video: {
    modes: ["N", "V1", "V2"],
    hasAnaloguePalette: true,
    hasKanjiRom: true,
  },
  sound: { psg: "YM2608" },
  disk: { count: 2, model: "μPD765a", hasSubCpu: true },
  dipSwitches: {
    port30: 0b1111_1011,
    port31: 0b1110_1101,
  },
  roms: {
    disk: MKI_DISC,
    // FA reuses MH's n80 image (same CRC in MAME).
    n80: MH_N80,
    n88: FA_N88,
    e0: FA_E0,
    e1: FA_E1,
    e2: FA_E2,
    e3: FA_E3,
    kanji1: MKI_KANJI1,
    // kanji2 differs from MH (FA has its own dump CRC=376eb677...
    // wait, MAME shows fa_kanji2.rom CRC=376eb677 same as MH).
    // Reuse MH_KANJI2 — the byte image is identical across the
    // FH/MH/FA generation per MAME's hashes.
    kanji2: MH_KANJI2,
  },
};
