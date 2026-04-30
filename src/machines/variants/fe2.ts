import { makeROM, type PC88Config } from "../config.js";
import { MKI_KANJI1 } from "./mk1.js";
import { MH_KANJI2, MH_N80 } from "./mh.js";

// PC-8801 FE2 (1989): the low-cost MA2 — like FE (no built-in
// floppy) but with the dictionary-ROM Japanese-IME support that MA
// introduced. Same hardware generation as MA2.
//
// Not in MAME's main driver. ROM hashes TODO.
const FE2_N88 = makeROM("fe2-n88", 32, "todo-md5");
const FE2_E0 = makeROM("fe2-e0", 8, "todo-md5");
const FE2_E1 = makeROM("fe2-e1", 8, "todo-md5");
const FE2_E2 = makeROM("fe2-e2", 8, "todo-md5");
const FE2_E3 = makeROM("fe2-e3", 8, "todo-md5");
const FE2_JISHO = makeROM("fe2-jisho", 256, "todo-md5");

export const FE2: PC88Config = {
  model: "PC-8801 FE2",
  nicknames: ["fe2"],
  releaseYear: 1989,
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
  disk: { count: 0, model: "μPD765a", hasSubCpu: true },
  dipSwitches: {
    port30: 0b1111_1011,
    port31: 0b1110_1101,
  },
  roms: {
    n80: MH_N80,
    n88: FE2_N88,
    e0: FE2_E0,
    e1: FE2_E1,
    e2: FE2_E2,
    e3: FE2_E3,
    kanji1: MKI_KANJI1,
    kanji2: MH_KANJI2,
    jisho: FE2_JISHO,
  },
};
