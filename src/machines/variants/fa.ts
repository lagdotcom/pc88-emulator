import { makeROM, type PC88Config } from "../config.js";
import { FH_E0, FH_E2 } from "./fh.js";
import { MH_E1, MH_E3, MH_N80 } from "./mh.js";
import { MKI_KANJI1 } from "./mk1.js";
import { FR_DISK } from "./mk2fr.js";
import { MR_KANJI2 } from "./mk2mr.js";

// PC-8801 FA (1987): same FH/MH-class hardware (Z80 4/8 MHz, OPNA,
// V2 mode) with newer firmware. MAME's `pc8801fa` state class is
// pc8801fh_state — no electrical changes from MH.
//
// MAME's pc8801fa ROM_START shares fa_n80.rom with MH (same CRC).
// The n88 and E1-E3 ROMs are FA-specific (newer BASIC versions
// "2.3 V2 / 1.9 V1" per MAME comment).
export const FA_N88 = makeROM("fa-n88", 32, "f7cba6a308c2718dbe97e60e46ddd66a");

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
    disk: FR_DISK,
    n80: MH_N80,
    n88: FA_N88,
    e0: FH_E0,
    e1: MH_E1,
    e2: FH_E2,
    e3: MH_E3,
    kanji1: MKI_KANJI1,
    kanji2: MR_KANJI2,
  },
};
