import { makeROM, type PC88Config, PORT30, PORT31 } from "../config.js";
import { MKI_DISC, MKI_KANJI1 } from "./mk1.js";

export const SR_N80 = makeROM("sr-n80", 32, "2ff07b8769367321128e03924af668a0");
const SR_N88 = makeROM("sr-n88", 32, "4f984e04a99d56c4cfe36115415d6eb8");
export const SR_E0 = makeROM("sr-e0", 8, "d675a2ca186c6efcd6277b835de4c7e5");
const SR_E1 = makeROM("sr-e1", 8, "e844534dfe5744b381444dbe61ef1b66");
const SR_E2 = makeROM("sr-e2", 8, "6548fa45061274dee1ea8ae1e9e93910");
const SR_E3 = makeROM("sr-e3", 8, "fc4b76a402ba501e6ba6de4b3e8b4273");
const SR_FONT = makeROM("sr-font", 6, "14bc9e267cf0cb56d22d5c470f582d53");
// kanji2 was an optional add-on on stock mkII SR; MAME notes "not on
// stock mkIISR" but loads it anyway. Mark as not-required so an
// SR ROM dump without kanji2 still validates.
export const SR_KANJI2 = makeROM(
  "sr-kanji2",
  128,
  "41d2e2c0c0edfccf76fa1c3e38bc1cf2",
  false,
);

export const MKII_SR: PC88Config = {
  model: "PC-8801 mkII SR",
  nicknames: ["sr", "mkiisr", "mkii_sr", "mkii-sr"],
  releaseYear: 1985,
  cpu: { main: "μPD780C-1", sub: "μPD780C-1", highSpeedMode: false },
  memory: {
    mainRam: 64,
    textVram: 4,
    tvramSeparate: true,
  },
  video: {
    // SR introduces V2 mode (640×200 8-colour analogue) alongside
    // V1 and the legacy N-BASIC mode.
    modes: ["N", "V1", "V2"],
    // First model with the analogue palette + the YM2203 sound
    // chip — pre-SR is digital + beeper.
    hasAnaloguePalette: true,
  },
  sound: { psg: "YM2203" },
  disk: { count: 2, model: "μPD765a", hasSubCpu: true },
  // mkII SR factory defaults: same DIP shape as mkI but bit 5 of
  // port31 indicates V2 mode availability. For first-light we mirror
  // the mkI defaults — refine when an SR-specific boot is wired up.
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
    disk: MKI_DISC,
    font: SR_FONT,
    n80: SR_N80,
    n88: SR_N88,
    e0: SR_E0,
    e1: SR_E1,
    e2: SR_E2,
    e3: SR_E3,
    // kanji1 is the same physical ROM across the entire mkI..MA
    // lineup (CRC=6178bd43 in every MAME ROM_START); reuse the mkI
    // descriptor.
    kanji1: MKI_KANJI1,
    kanji2: SR_KANJI2,
  },
};
