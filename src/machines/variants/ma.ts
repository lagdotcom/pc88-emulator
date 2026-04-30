import { makeROM, type PC88Config } from "../config.js";
import { FA_N88 } from "./fa.js";
import { FH_E0 } from "./fh.js";
import { MH_DISK, MH_E1, MH_E3, MH_N80 } from "./mh.js";
import { MKI_KANJI1 } from "./mk1.js";
import { MR_KANJI2 } from "./mk2mr.js";

// PC-8801 MA (1987): identical hardware to FA except for an added
// dictionary ROM (jisyo) for Japanese input-method support — accessed
// via ports 0xF0-0xF1 (`dic_bank_w` / `dic_ctrl_w` per MAME).
//
// Per MAME's pc8801ma ROM_START: ma_n80 = mh_n80 (same image),
// ma_n88 + E0-E3 are MA-specific, kanji2 = mh_kanji2 (same image),
// jisyo.rom is the new piece (256 KB).
const MA_JISHO = makeROM("ma-jisho", 256, "cbcade0d0057bb9eee79a6b370b4dd3a");

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
    disk: MH_DISK,
    n80: MH_N80,
    n88: FA_N88,
    e0: FH_E0,
    e1: MH_E1,
    // TODO I don't seem to have an e2 ROM for this???
    e3: MH_E3,
    kanji1: MKI_KANJI1,
    kanji2: MR_KANJI2,
    jisho: MA_JISHO,
  },
};
