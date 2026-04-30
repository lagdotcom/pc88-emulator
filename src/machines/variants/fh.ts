import { type PC88Config, PORT30, PORT31 } from "../config.js";
import { MKI_KANJI1 } from "./mk1.js";
import { MH_E0, MH_E1, MH_E2, MH_E3, MH_KANJI2, MH_N80, MH_N88 } from "./mh.js";

// PC-8801 FH (1985): same chassis as MH but no built-in floppy
// drive (FH = Floppy-less Hardware? marketed as the cheaper option).
// MAME doesn't model FH separately — its pc8801mh state class is
// labelled `pc8801fh_state` and used for both, suggesting NEC made
// no electrical changes outside the disk subsystem.
//
// Reuses MH's ROM set entirely. Disk count is 0 (FH had no internal
// drive; users could attach external 5.25" or 8" drives via the
// floppy I/F card).
export const FH: PC88Config = {
  model: "PC-8801 FH",
  nicknames: ["fh"],
  releaseYear: 1985,
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
  // No built-in floppy drive on FH; sub-CPU is still present in
  // case external drives are connected via the FDD interface card.
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
    n88: MH_N88,
    e0: MH_E0,
    e1: MH_E1,
    e2: MH_E2,
    e3: MH_E3,
    kanji1: MKI_KANJI1,
    kanji2: MH_KANJI2,
  },
};
