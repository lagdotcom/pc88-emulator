import { makeROM, type PC88Config, PORT30, PORT31 } from "../config.js";
import { MKI_KANJI1 } from "./mk1.js";
import { SR_E0, SR_N80 } from "./mk2sr.js";

export const FR_DISK = makeROM(
  "fr-disk",
  2,
  "fbb43de2ebd228e9b769c64631cb13be",
);

const FR_N88 = makeROM("fr-n88", 32, "59da45572acfe7f6da809a97b74d758f");
export const FR_E1 = makeROM("fr-e1", 8, "dc7afa99838daa1dad9bfab9027881b0");
const FR_E2 = makeROM("fr-e2", 8, "272bf8e6ca45ed06384e5b7c1d35715f");
export const FR_E3 = makeROM("fr-e3", 8, "3ba670725fb95b3675fcbc75b8b0f49f");

export const MKII_FR: PC88Config = {
  model: "PC-8801 mkII FR",
  nicknames: ["fr", "mkiifr", "mkii_fr", "mkii-fr"],
  releaseYear: 1985,
  cpu: { main: "μPD780C-1", sub: "μPD780C-1", highSpeedMode: false },
  memory: {
    mainRam: 64,
    textVram: 4,
    // FR shares the SR architecture; SR onwards has the dedicated
    // 4 KB TVRAM chip rather than upper-RAM aliasing.
    tvramSeparate: true,
    graphicsVramPlanes: 3,
    graphicsVramPerPlane: 16,
    hasExtendedRam: false,
  },
  video: {
    // FR ships the n80 ROM and the BIOS still honours the RMODE DIP
    // bit, so N-BASIC is bootable even though NEC's marketing
    // dropped it from the front-of-box features list.
    modes: ["N", "V1", "V2"],
    hasAnaloguePalette: true,
    hasKanjiRom: true,
  },
  sound: { psg: "YM2203" },
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
    disk: FR_DISK,
    n80: SR_N80,
    n88: FR_N88,
    e0: SR_E0,
    e1: FR_E1,
    e2: FR_E2,
    e3: FR_E3,
    kanji1: MKI_KANJI1,
  },
};
