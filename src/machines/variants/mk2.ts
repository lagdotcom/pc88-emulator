import { makeROM, type PC88Config, PORT30, PORT31 } from "../config.js";

const MKII_N80 = makeROM("mkII-n80", 32, "6f2cd5b887c80a18cf60e6758d195c46");
const MKII_N88 = makeROM("mkII-n88", 32, "16b4f08338382e0fe21b6c244f1b9c96");
const MKII_E0 = makeROM("mkII-e0", 8, "f198cae1050af141dd3c09f0b2c6facf");

export const MKII: PC88Config = {
  model: "PC-8801 mkII",
  nicknames: ["ii", "mkii", "2"],
  releaseYear: 1983,
  cpu: { main: "μPD780C-1", sub: "μPD780C-1", highSpeedMode: false },
  memory: {
    mainRam: 64,
    textVram: 4,
    tvramSeparate: false,
    hasExtendedRam: false,
  },
  video: {
    modes: ["N", "V1"],
    // YM2203 + analogue palette arrive on mkII SR (1985).
    hasAnaloguePalette: false,
    hasKanjiRom: true,
  },
  // mkII shipped with the same beeper as mkI; YM2203 added on SR.
  sound: { psg: "beeper" },
  disk: { count: 2, model: "μPD765a", hasSubCpu: true },
  // mkII factory defaults: same DIP layout as mkI, with disk-boot
  // mode as the typical out-of-the-box configuration. Verify against
  // a real mkII service manual when one is to hand.
  dipSwitches: {
    port30:
      PORT30.COLS_80 |
      PORT30.MONO |
      PORT30.CASSETTE_MOTOR |
      PORT30.USART_RS232_HIGH |
      0xc0, // bits 6-7 model-specific
    port31:
      PORT31.LINES_200 |
      PORT31.RMODE_N80 |
      PORT31.GRPH |
      PORT31.HIGHRES |
      0xc0, // bits 6-7 model-specific
  },
  roms: {
    n80: MKII_N80,
    n88: MKII_N88,
    e0: MKII_E0,
    // TODO which _DISK does it use? could only be MKI I guess...
  },
};
