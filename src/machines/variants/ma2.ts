import { makeROM, type PC88Config, PORT30, PORT31 } from "../config.js";
import { FH_E0 } from "./fh.js";
import { MH_DISK, MH_E1, MH_E3, MH_N80 } from "./mh.js";
import { MKI_KANJI1 } from "./mk1.js";
import { MR_KANJI2 } from "./mk2mr.js";

// PC-8801 MA2 (1988): MA with newer dictionary ROM. Per MAME's
// pc8801ma2 ROM_START the n80, n88, E0-E3 and kanji2 are bit-identical
// to MA — only the jisho ROM is bumped.
const MA2_N88 = makeROM("ma2-n88", 32, "681e37570581cc43c785bae53eefa155");
const MA2_E2 = makeROM("ma2-e2", 8, "87bc14a8a9ec66a99e89561bca4bda9b");
const MA2_JISHO = makeROM("ma2-jisho", 256, "b4d66a04e8ce3ec00410d397e04f549e");

export const MA2: PC88Config = {
  model: "PC-8801 MA2",
  nicknames: ["ma2"],
  releaseYear: 1988,
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
    n88: MA2_N88,
    e0: FH_E0,
    e1: MH_E1,
    e2: MA2_E2,
    e3: MH_E3,
    kanji1: MKI_KANJI1,
    kanji2: MR_KANJI2,
    jisho: MA2_JISHO,
  },
};
