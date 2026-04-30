import { makeROM, type PC88Config } from "../config.js";
import { MKI_DISC, MKI_KANJI1 } from "./mk1.js";
import { MA_E0, MA_E1, MA_E2, MA_E3 } from "./ma.js";
import { MH_KANJI2, MH_N80 } from "./mh.js";

// PC-8801 MC (1989): MA2 with a built-in CD-ROM drive. The CD-ROM
// I/F lives on its own ports 0x90-0x9F per MAME's `pc8801mc_state`.
//
// We don't yet model the CD-ROM at all — there's a placeholder
// `cdBios` slot in `ROMManifest` for the CD-ROM BIOS image.
const MC_N88 = makeROM("mc-n88", 32, "todo-md5");
const MC_CD_BIOS = makeROM("mc-cdbios", 32, "todo-md5", false);
// MC's jisho is reportedly the same image as MA2's per MAME, but
// without a verified dump we declare a fresh placeholder. If a real
// dump confirms identity, swap to a shared import from `./ma2.js`.
const MC_JISHO = makeROM("mc-jisho", 256, "todo-md5");

export const MC: PC88Config = {
  model: "PC-8801 MC",
  nicknames: ["mc"],
  releaseYear: 1989,
  cpu: { main: "μPD780C-1", sub: "μPD780C-1", highSpeedMode: true },
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
  sound: { psg: "YM2608" },
  disk: { count: 2, model: "μPD765a", hasSubCpu: true },
  dipSwitches: {
    port30: 0b1111_1011,
    port31: 0b1110_1101,
  },
  roms: {
    disk: MKI_DISC,
    n80: MH_N80,
    n88: MC_N88,
    e0: MA_E0,
    e1: MA_E1,
    e2: MA_E2,
    e3: MA_E3,
    kanji1: MKI_KANJI1,
    kanji2: MH_KANJI2,
    jisho: MC_JISHO,
    cdBios: MC_CD_BIOS,
  },
};
