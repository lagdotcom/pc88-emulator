import { makeROM, type PC88Config } from "../config.js";

export const MKI_DISC = makeROM(
  "mkI-disc",
  2,
  "793f86784e5608352a5d7f03f03e0858",
);
const MKI_N80 = makeROM("mkI-n80", 32, "5d6854624dd01cd791f58727fc43a525");
const MKI_N88 = makeROM("mkI-n88", 32, "22be239bc0c4298bc0561252eed98633");
const MKI_E0 = makeROM("mkI-e0", 8, "e28fe3f520bea594350ea8fb00395370");
const MKI_FONT = makeROM("mkI-font", 2, "cd428f9ee8ff9f84c60beb7a8a0ef628");
export const MKI_KANJI1 = makeROM(
  "mkI-kanji1",
  128,
  "d81c6d5d7ad1a4bbbd6ae22a01257603",
);

export const MKI: PC88Config = {
  model: "PC-8801",
  nicknames: ["88", "pc88", "mki", "original"],
  cpu: { main: "μPD780C-1", sub: "μPD780C-1", highSpeedMode: false },
  memory: {
    mainRam: 64,
    textVram: 4,
    tvramSeparate: false,
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
  // mkI factory defaults: 80 cols, mono bit set, 200 lines / V1
  // mode, ROM boot, N-BASIC. Reproduces the typical "out of the
  // box" configuration users would have seen in 1981.
  dipSwitches: {
    port30: 0b1111_1011,
    port31: 0b1110_1101,
  },
  roms: {
    disk: MKI_DISC,
    font: MKI_FONT,
    n80: MKI_N80,
    n88: MKI_N88,
    e0: MKI_E0,
    kanji1: MKI_KANJI1,
  },
};
