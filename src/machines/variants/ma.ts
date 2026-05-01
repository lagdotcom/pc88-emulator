import { makeROM, type PC88Config, PORT30, PORT31 } from "../config.js";
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
// MA's E2 ROM: MAME's pc8801ma ROM_START loads `ma_n88_2.rom` here
// but no local dump is available yet. Mark as not-required and
// placeholder-md5 so the loader skips silently until a real dump
// arrives (memory map falls back to BASIC continuation at slot 2,
// which may be wrong for software that depends on it).
const MA_E2 = makeROM("ma-e2", 8, "todo-md5", false);

export const MA: PC88Config = {
  model: "PC-8801 MA",
  nicknames: ["ma"],
  releaseYear: 1987,
  cpu: { main: "μPD780C-1", sub: "μPD780C-1", highSpeedMode: true },
  memory: {
    mainRam: 192,
    textVram: 4,
    tvramSeparate: true,
  },
  video: {
    modes: ["N", "V1", "V2"],
    hasAnaloguePalette: true,
  },
  sound: { psg: "YM2608" },
  disk: { count: 2, model: "μPD765a", hasSubCpu: true },
  dipSwitches: {
    port30:
      PORT30.COLS_80 |
      PORT30.MONO |
      PORT30.CASSETTE_MOTOR |
      PORT30.USART_RS232_HIGH |
      0xc0, // bits 6-7 model-specific
    port31:
      PORT31.LINES_200 |
      PORT31.RMODE_N80 |
      PORT31.GRPH |
      PORT31.HIGHRES |
      0xc0, // bits 6-7 model-specific
  },
  roms: {
    disk: MH_DISK,
    n80: MH_N80,
    n88: FA_N88,
    e0: FH_E0,
    e1: MH_E1,
    e2: MA_E2,
    e3: MH_E3,
    kanji1: MKI_KANJI1,
    kanji2: MR_KANJI2,
    jisho: MA_JISHO,
  },
};
