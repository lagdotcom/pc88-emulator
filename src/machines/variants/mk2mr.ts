import { makeROM, type PC88Config } from "../config.js";
import { MKI_DISC, MKI_KANJI1 } from "./mk1.js";

// MR ROM hashes are placeholders: MAME's pc8801mk2mr ROM_START
// declares CRC32+SHA1 but we use md5; replace each value once the
// physical ROM has been dumped + md5'd locally. Until then loadRoms()
// will fail md5 validation when --machine=mr is selected.
const MR_N80 = makeROM("mr-n80", 32, "todo-md5");
const MR_N88 = makeROM("mr-n88", 32, "todo-md5");
const MR_E0 = makeROM("mr-e0", 8, "todo-md5");
const MR_E1 = makeROM("mr-e1", 8, "todo-md5");
const MR_E2 = makeROM("mr-e2", 8, "todo-md5");
const MR_E3 = makeROM("mr-e3", 8, "todo-md5");
// kanji2 became standard from MR onwards.
export const MR_KANJI2 = makeROM("mr-kanji2", 128, "todo-md5");

export const MKII_MR: PC88Config = {
  model: "PC-8801 mkII MR",
  nicknames: ["mr", "mkiimr", "mkii_mr", "mkii-mr"],
  releaseYear: 1985,
  cpu: { main: "μPD780C-1", sub: "μPD780C-1", highSpeedMode: false },
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
  sound: { psg: "YM2203" },
  disk: { count: 2, model: "μPD765a", hasSubCpu: true },
  dipSwitches: {
    port30: 0b1111_1011,
    port31: 0b1110_1101,
  },
  roms: {
    disk: MKI_DISC,
    n80: MR_N80,
    n88: MR_N88,
    e0: MR_E0,
    e1: MR_E1,
    e2: MR_E2,
    e3: MR_E3,
    kanji1: MKI_KANJI1,
    kanji2: MR_KANJI2,
  },
};
