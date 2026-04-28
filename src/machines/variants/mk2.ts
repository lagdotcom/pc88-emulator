import { makeROM, type PC88Config } from "../config.js";

const MKII_N80 = makeROM("mkII-n80", 32, "");
const MKII_N88 = makeROM("mkII-n88", 32, "");
const MKII_E0 = makeROM("mkII-e0", 8, "");

export const MKII: PC88Config = {
  model: "PC-8801 mkII",
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
  sound: { psg: "beeper" }, // TODO is it?
  disk: { count: 2, model: "μPD765a", hasSubCpu: true },
  roms: {
    n80: MKII_N80,
    n88: MKII_N88,
    e0: MKII_E0,
    // TODO which _DISK does it use? could only be MKI I guess...
  },
};
