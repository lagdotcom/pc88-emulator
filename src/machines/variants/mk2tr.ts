import { makeROM, type PC88Config } from "../config.js";
import { MKI_DISC, MKI_KANJI1 } from "./mk1.js";
import { SR_E0, SR_KANJI2, SR_N80 } from "./mk2sr.js";

// PC-8801 mkII TR ("Telephone Ready"): mkII SR with a built-in
// modem on the secondary RS-232 channel. MAME doesn't model TR;
// best-effort spec from Wikipedia + community references.
//
// Hardware difference from SR:
//   - Built-in modem chip wired to the channel-1/channel-2 USART
//     pair at 0xC0-0xC3 (likely re-uses the μPD8251 channels we
//     already stub).
//   - DIP-switch bit assignments may differ for the built-in modem
//     enable. Mirror SR for now and note the gap.
//
// Per Wikipedia TR is the "last variant officially marketing N-BASIC
// support"; MR onwards drop N-BASIC from the front-of-box features
// even though the ROM stays in firmware.
//
// ROMs: probably identical to mkII SR (same generation, same BASIC
// version). Reuse SR descriptors where confirmed; the n88 + E1..E3
// may differ on TR but no public dump confirms either way — keep
// placeholders so a real TR dump can fill them in.
const TR_N88 = makeROM("tr-n88", 32, "todo-md5", false);
const TR_E1 = makeROM("tr-e1", 8, "todo-md5", false);
const TR_E2 = makeROM("tr-e2", 8, "todo-md5", false);
const TR_E3 = makeROM("tr-e3", 8, "todo-md5", false);

export const MKII_TR: PC88Config = {
  model: "PC-8801 mkII TR",
  nicknames: ["tr", "mkiitr", "mkii_tr", "mkii-tr"],
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
    n80: SR_N80,
    n88: TR_N88,
    e0: SR_E0,
    e1: TR_E1,
    e2: TR_E2,
    e3: TR_E3,
    kanji1: MKI_KANJI1,
    kanji2: SR_KANJI2,
  },
};
