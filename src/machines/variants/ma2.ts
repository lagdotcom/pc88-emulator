import { makeROM, type PC88Config } from "../config.js";
import { MKI_DISC, MKI_KANJI1 } from "./mk1.js";
import { MA_E0, MA_E1, MA_E2, MA_E3 } from "./ma.js";
import { MH_KANJI2, MH_N80 } from "./mh.js";

// PC-8801 MA2 (1988): MA with newer dictionary ROM. Per MAME's
// pc8801ma2 ROM_START the n80, n88, E0-E3 and kanji2 are bit-identical
// to MA — only the jisho ROM is bumped.
const MA2_N88 = makeROM("ma2-n88", 32, "todo-md5");
const MA2_JISHO = makeROM("ma2-jisho", 256, "todo-md5");

export const MA2: PC88Config = {
  model: "PC-8801 MA2",
  nicknames: ["ma2"],
  releaseYear: 1988,
  cpu: { main: "μPD780C-1", sub: "μPD780C-1", highSpeedMode: true },
  memory: {
    mainRam: 192,
    // MR/MH/MA/MA2 ship with 64 KB main + 128 KB extended
    // RAM (port 0xE2/0xE3 bank-switch). Total addressable 192 KB.
    hasExtendedRam: true,
    textVram: 4,
    tvramSeparate: true,
    graphicsVramPlanes: 3,
    graphicsVramPerPlane: 16,
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
    n80: MH_N80,
    n88: MA2_N88,
    e0: MA_E0,
    e1: MA_E1,
    e2: MA_E2,
    e3: MA_E3,
    kanji1: MKI_KANJI1,
    kanji2: MH_KANJI2,
    jisho: MA2_JISHO,
  },
};
