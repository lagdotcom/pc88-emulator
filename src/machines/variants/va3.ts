import { makeROM, type PC88Config } from "../config.js";

// PC-88 VA3 (1989): final entry in the VA lineup. Same μPD9002
// architecture, further-revised firmware. Believed identical to VA2
// from a port-map perspective; a "VA3" boot target would mostly
// differ in ROM contents.
//
// MAME's pc88va driver isn't covered by our refs/ slice. ROM hashes
// TODO.
export const VA3: PC88Config = {
  model: "PC-88 VA3",
  nicknames: ["va3", "pc88va3"],
  releaseYear: 1989,
  cpu: { main: "μPD9002", sub: "μPD780C-1", highSpeedMode: true },
  memory: {
    mainRam: 64,
    textVram: 4,
    tvramSeparate: true,
    graphicsVramPlanes: 3,
    graphicsVramPerPlane: 16,
    hasExtendedRam: true,
  },
  video: {
    modes: ["N", "V1", "V2", "V3"],
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
    n80: makeROM("va3-n80", 32, "todo-md5", false),
    n88: makeROM("va3-n88", 64, "todo-md5", false),
    e0: makeROM("va3-e0", 8, "todo-md5", false),
  },
};
