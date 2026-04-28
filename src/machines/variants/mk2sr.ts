import { makeROM, type PC88Config } from "../config.js";
import { MKI_DISC } from "./mk1.js";

export const SR_N80 = makeROM("sr-n80", 32, "");
const SR_N88 = makeROM("sr-n88", 32, "");
export const SR_E0 = makeROM("sr-e0", 8, "");
const SR_E1 = makeROM("sr-e1", 8, "");
const SR_E2 = makeROM("sr-e2", 8, "");
const SR_E3 = makeROM("sr-e3", 8, "");
const SR_FONT = makeROM("sr-font", 2, "");

export const MKII_SR: PC88Config = {
  model: "PC-8801 mkII SR",
  cpu: { main: "μPD780C-1", sub: "μPD780C-1", highSpeedMode: false },
  memory: {
    mainRam: 64,
    textVram: 4,
    graphicsVramPlanes: 3,
    graphicsVramPerPlane: 16,
    hasExtendedRam: false,
  },
  video: {
    modes: ["N", "V1", "V2"],
    hasAnaloguePalette: true,
    hasKanjiRom: true,
  },
  sound: { psg: "YM2203" },
  disk: { count: 2, model: "μPD765a", hasSubCpu: true },
  roms: {
    disk: MKI_DISC,
    font: SR_FONT,
    n80: SR_N80,
    n88: SR_N88,
    e0: SR_E0,
    e1: SR_E1,
    e2: SR_E2,
    e3: SR_E3,
    // TODO I have SR_KANJI2 but not _KANJI1
  },
};
