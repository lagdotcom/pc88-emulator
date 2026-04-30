import { makeROM, type PC88Config } from "../config.js";
import { MKI_DISC, MKI_KANJI1 } from "./mk1.js";
import { MH_KANJI2, MH_N80 } from "./mh.js";

// PC-8801 MA (1987): identical hardware to FA except for an added
// dictionary ROM (jisyo) for Japanese input-method support — accessed
// via ports 0xF0-0xF1 (`dic_bank_w` / `dic_ctrl_w` per MAME).
//
// Per MAME's pc8801ma ROM_START: ma_n80 = mh_n80 (same image),
// ma_n88 + E0-E3 are MA-specific, kanji2 = mh_kanji2 (same image),
// jisyo.rom is the new piece (256 KB).
export const MA_N88 = makeROM("ma-n88", 32, "todo-md5");
export const MA_E0 = makeROM("ma-e0", 8, "todo-md5");
export const MA_E1 = makeROM("ma-e1", 8, "todo-md5");
export const MA_E2 = makeROM("ma-e2", 8, "todo-md5");
export const MA_E3 = makeROM("ma-e3", 8, "todo-md5");
export const MA_JISHO = makeROM("ma-jisho", 256, "todo-md5");

export const MA: PC88Config = {
  model: "PC-8801 MA",
  nicknames: ["ma"],
  releaseYear: 1987,
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
    n88: MA_N88,
    e0: MA_E0,
    e1: MA_E1,
    e2: MA_E2,
    e3: MA_E3,
    kanji1: MKI_KANJI1,
    kanji2: MH_KANJI2,
    jisho: MA_JISHO,
  },
};
