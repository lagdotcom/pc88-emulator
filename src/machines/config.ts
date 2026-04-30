import type { Kilobytes, MD5Sum, ROMID, u8 } from "../flavours.js";

export interface PC88Config {
  readonly model: PC88Model;
  readonly nicknames: string[];
  readonly cpu: CPUConfig;
  readonly memory: MemoryConfig;
  readonly video: VideoConfig;
  readonly sound: SoundConfig;
  readonly disk: DiskConfig;
  readonly roms: ROMManifest;
  readonly dipSwitches: DIPSwitchState;
}

// Raw bytes returned by the BIOS reads of ports 0x30 and 0x31 — the
// physical DIP-switch state. Bit assignments are per the NEC mkI/mkII
// hardware manual:
//
//   port30:
//     bit 0    1 = 80 cols, 0 = 40 cols
//     bit 1    1 = mono, 0 = colour          (BIOS bit invert)
//     bit 2    serial carrier mark/space
//     bit 3    cassette motor on/off
//     bits 4-5 USART rate (0=CMT600, 1=CMT1200, 2/3=RS-232C)
//     bits 6-7 model-specific
//
//   port31:
//     bit 0    1 = 200 lines, 0 = 400 lines (V1/V2 mode)
//     bit 1    1 = boot from RAM, 0 = boot from ROM
//     bit 2    1 = N-BASIC, 0 = N88-BASIC
//     bit 3    graphics enable
//     bit 4    high-resolution colour
//     bit 5    high-res mode
//     bits 6-7 model-specific
//
// Per-variant defaults live on each PC88Config in src/machines/variants/.
// SystemController consumes them via `register()` and surfaces them to
// the CPU via port reads — it does not re-encode them from named
// fields, so adding a new bit is a one-line change here.
export interface DIPSwitchState {
  readonly port30: u8;
  readonly port31: u8;
}

export type PC88Model =
  | "PC-8801"
  | "PC-8801 mkII"
  | "PC-8801 mkII SR"
  | "PC-8801 mkII TR"
  | "PC-8801 mkII FR"
  | "PC-8801 mkII MR"
  | "PC-8801 FH"
  | "PC-8801 MH"
  | "PC-88 VA"
  | "PC-8801 FA"
  | "PC-8801 MA"
  | "PC-88 VA2"
  | "PC-88 VA3"
  | "PC-8801 FE"
  | "PC-8801 MA2"
  | "PC-8801 FE2"
  | "PC-8801 MC";

export interface CPUConfig {
  readonly main: "μPD780C-1" | "μPD70008AC-8" | "μPD9002";
  readonly sub: "μPD780C-1" | "μPD70008AC-8" | "μPD9002";
  readonly highSpeedMode: boolean;
}

export interface MemoryConfig {
  readonly mainRam: Kilobytes;
  readonly textVram: Kilobytes;
  readonly graphicsVramPlanes: number;
  readonly graphicsVramPerPlane: Kilobytes;
  readonly hasExtendedRam: boolean;
}

export interface VideoConfig {
  readonly modes: VideoMode[];
  readonly hasAnaloguePalette: boolean;
  readonly hasKanjiRom: boolean;
}

export type VideoMode = "N" | "V1" | "V2" | "V3";

export interface SoundConfig {
  readonly psg: "beeper" | "AY-3-8910" | "YM2203" | "YM2608";
}

export interface DiskConfig {
  readonly count: 0 | 1 | 2;
  readonly model: "μPD765a";
  readonly hasSubCpu: boolean;
}

export interface ROMManifest {
  readonly disk?: ROMDescriptor;
  readonly font?: ROMDescriptor;
  readonly n80: ROMDescriptor;
  readonly n88: ROMDescriptor;
  readonly e0: ROMDescriptor;
  readonly e1?: ROMDescriptor;
  readonly e2?: ROMDescriptor;
  readonly e3?: ROMDescriptor;
  readonly kanji1?: ROMDescriptor;
  readonly kanji2?: ROMDescriptor;
  readonly jisho?: ROMDescriptor;
  readonly cdBios?: ROMDescriptor;
}

export interface ROMDescriptor {
  readonly id: ROMID;
  readonly size: Kilobytes;
  readonly md5: MD5Sum;
  readonly required: boolean;
}

export const makeROM = (
  id: ROMID,
  size: Kilobytes,
  md5: MD5Sum,
  required = true,
): ROMDescriptor => ({ id, size, md5, required });
