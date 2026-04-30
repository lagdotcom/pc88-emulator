import { makeROM, type PC88Config } from "../config.js";
import { MKI_DISC, MKI_KANJI1 } from "./mk1.js";

// PC-8801 MH (1986): first machine in the FH/MH generation. Adds:
//   - Selectable 4 MHz / 8 MHz Z80 clock (port 0x6E read tells the
//     BIOS which mode is active; FH+ feature)
//   - YM2608 (OPNA) at 0x44-0x47 — replaces YM2203
//   - Built-in 5.25" floppy
//
// MAME's pc8801mh ROM_START loads its own n80/n88/e0-e3 set; the
// kanji ROMs are shared with mkII MR (CRC=376eb677 = m2mr_kanji2.rom).
//
// ROM hashes are TODO until physical dumps are MD5'd locally.
export const MH_N80 = makeROM("mh-n80", 32, "todo-md5");
export const MH_N88 = makeROM("mh-n88", 32, "todo-md5");
export const MH_E0 = makeROM("mh-e0", 8, "todo-md5");
export const MH_E1 = makeROM("mh-e1", 8, "todo-md5");
export const MH_E2 = makeROM("mh-e2", 8, "todo-md5");
export const MH_E3 = makeROM("mh-e3", 8, "todo-md5");
export const MH_KANJI2 = makeROM("mh-kanji2", 128, "todo-md5");

export const MH: PC88Config = {
  model: "PC-8801 MH",
  nicknames: ["mh"],
  releaseYear: 1986,
  cpu: { main: "μPD780C-1", sub: "μPD780C-1", highSpeedMode: true },
  memory: {
    mainRam: 192,
    // MR/MH/MA/MA2 ship with 64 KB main + 128 KB extended
    // RAM (port 0xE2/0xE3 bank-switch). Total addressable 192 KB.
    hasExtendedRam: true,
    textVram: 4,
    tvramSeparate: true,
    graphicsVramPlanes: 3,
    graphicsVramPerPlane: 16,
  },
  video: {
    modes: ["N", "V1", "V2"],
    hasAnaloguePalette: true,
    hasKanjiRom: true,
  },
  // OPNA (YM2608): superset of OPN — adds rhythm + ADPCM channels.
  sound: { psg: "YM2608" },
  disk: { count: 2, model: "μPD765a", hasSubCpu: true },
  dipSwitches: {
    port30: 0b1111_1011,
    port31: 0b1110_1101,
  },
  roms: {
    disk: MKI_DISC,
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
