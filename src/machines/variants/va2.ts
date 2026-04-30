import { makeROM, type PC88Config } from "../config.js";

// PC-88 VA2 (1988): VA with newer firmware, more RAM, and a 3.5"
// floppy drive replacing the 5.25" drive of the original VA.
//
// MAME's pc88va driver isn't included in our refs/ slice, so the
// fields below are best-effort. ROM hashes TODO.
export const VA2: PC88Config = {
  model: "PC-88 VA2",
  nicknames: ["va2", "pc88va2"],
  releaseYear: 1988,
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
    n80: makeROM("va2-n80", 32, "todo-md5", false),
    n88: makeROM("va2-n88", 64, "todo-md5", false),
    e0: makeROM("va2-e0", 8, "todo-md5", false),
  },
};
