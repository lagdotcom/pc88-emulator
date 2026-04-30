import { makeROM, type PC88Config } from "../config.js";
import { MKI_KANJI1 } from "./mk1.js";
import { MR_KANJI2 } from "./mk2mr.js";

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
export const MH_DISK = makeROM(
  "mh-disk",
  2,
  "890b304e719974e53ff0d4d99c878d96",
);
export const MH_N80 = makeROM("mh-n80", 32, "93cd1d78b7b9c50b80041ed330332ece");
export const MH_N88 = makeROM("mh-n88", 32, "aa86b1bfaa88c2f92c8b3b450907ed0f");
const MH_E0 = makeROM("mh-e0", 8, "7d8febc688590d03708f45fac54de7dd");
export const MH_E1 = makeROM("mh-e1", 8, "a8e298da7ac947669bcb1ff25cee0a83");
const MH_E2 = makeROM("mh-e2", 8, "800e173d37789b5a954b8fbbc86993cb");
export const MH_E3 = makeROM("mh-e3", 8, "e1791f8154f1cdf22b576a1a365b6e1f");

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
    disk: MH_DISK,
    n80: MH_N80,
    n88: MH_N88,
    e0: MH_E0,
    e1: MH_E1,
    e2: MH_E2,
    e3: MH_E3,
    kanji1: MKI_KANJI1,
    kanji2: MR_KANJI2,
  },
};
