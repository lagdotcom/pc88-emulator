import { makeROM, type PC88Config } from "../config.js";

export const MKI_DISC = makeROM("mkI-disc", 2, "");
const MKI_N80 = makeROM("mkI-n80", 32, "");
const MKI_N88 = makeROM("mkI-n88", 32, "");
const MKI_E0 = makeROM("mkI-e0", 8, "");
const MKI_FONT = makeROM("mkI-font", 2, "");
const MKI_KANJI1 = makeROM("mkI-kanji1", 128, "");

export const MKI: PC88Config = {
  model: "PC-8801",
  cpu: { main: "μPD780C-1", sub: "μPD780C-1", highSpeedMode: false },
  memory: {
    mainRam: 64,
    textVram: 4,
    graphicsVramPlanes: 3,
    graphicsVramPerPlane: 16,
    hasExtendedRam: false,
  },
  video: {
    modes: ["N", "V1"],
    hasAnaloguePalette: true,
    hasKanjiRom: true,
  },
  sound: { psg: "beeper" },
  disk: { count: 0, model: "μPD765a", hasSubCpu: false },
  roms: {
    disk: MKI_DISC,
    font: MKI_FONT,
    n80: MKI_N80,
    n88: MKI_N88,
    e0: MKI_E0,
    kanji1: MKI_KANJI1,
  },
};
