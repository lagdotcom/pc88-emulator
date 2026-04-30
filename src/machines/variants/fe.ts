import { makeROM, type PC88Config, PORT30, PORT31 } from "../config.js";
import { MKI_KANJI1 } from "./mk1.js";
import { MH_KANJI2, MH_N80 } from "./mh.js";

// PC-8801 FE (1988): low-cost variant of FA — fewer expansion slots,
// no built-in floppy drive (like FH:MH was earlier). Same firmware
// generation as FA so most ROMs match.
//
// MAME doesn't model FE separately. ROM hashes are TODO until a
// dump is available; expect FA-like content.
const FE_N88 = makeROM("fe-n88", 32, "todo-md5");
const FE_E0 = makeROM("fe-e0", 8, "todo-md5");
const FE_E1 = makeROM("fe-e1", 8, "todo-md5");
const FE_E2 = makeROM("fe-e2", 8, "todo-md5");
const FE_E3 = makeROM("fe-e3", 8, "todo-md5");

export const FE: PC88Config = {
  model: "PC-8801 FE",
  nicknames: ["fe"],
  releaseYear: 1988,
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
  // No built-in floppy drive on FE.
  disk: { count: 0, model: "μPD765a", hasSubCpu: true },
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
    n80: MH_N80,
    n88: FE_N88,
    e0: FE_E0,
    e1: FE_E1,
    e2: FE_E2,
    e3: FE_E3,
    kanji1: MKI_KANJI1,
    kanji2: MH_KANJI2,
  },
};
