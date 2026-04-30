import type { Kilobytes, MD5Sum, ROMID, u8 } from "../flavours.js";

export interface PC88Config {
  readonly model: PC88Model;
  readonly nicknames: string[];
  // Year of NEC's official release. Sourced from MAME's pc8801.cpp
  // game-table comments where available. Used for diagnostics
  // ("PC-8801 mkII SR — 1985, Z80 4 MHz") and any future
  // "compatibility year" filtering of software.
  readonly releaseYear: number;
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

// Symbolic constants for the DIP-switch (and matching system-register)
// bit positions. Variant configs OR these together to construct the
// `port30` / `port31` bytes; SystemController re-uses them when
// interpreting port writes. Same physical bits in both directions —
// e.g. setting PORT30.COLS_80 in the DIP byte makes port-0x30 reads
// return that bit, which the BIOS interprets as "80-column mode".
//
// Active-high in this convention: a 1 bit means the named state. For
// fields that don't have a clean "on/off" sense (USART rate, screen-
// output mode), the constant is the bit *pattern* and a `_MASK`
// companion gives the field's full bit window.
//
// All values match MAME's pc8801.cpp `port30_w` / `port31_w` block
// comments and the NEC PC-8801 mkII Hardware Manual where it's been
// transcribed.
export const PORT30 = {
  COLS_80: 1 << 0, // 1 = 80 col, 0 = 40 col
  MONO: 1 << 1, // 1 = monochrome, 0 = colour
  CARRIER_MARK: 1 << 2, // 1 = mark, 0 = space
  CASSETTE_MOTOR: 1 << 3, // 1 = on, 0 = off
  USART_MASK: 0b0011_0000, // bits 4-5 — USART rate selector
  USART_CMT600: 0x00,
  USART_CMT1200: 0x10,
  USART_RS232: 0x20, // bit pattern 10 (also matches 11)
  USART_RS232_HIGH: 0x30, // alternate RS-232C; same chip, different wiring
} as const;

export const PORT31 = {
  LINES_200: 1 << 0, // 1 = 200 lines, 0 = 400 lines (V1/V2)
  MMODE_RAM: 1 << 1, // 1 = RAM at 0x0000-0x7FFF, 0 = ROM
  RMODE_N80: 1 << 2, // 1 = N-BASIC, 0 = N88-BASIC
  GRPH: 1 << 3, // 1 = graphics enabled
  HCOLOR: 1 << 4, // 1 = high-res colour
  HIGHRES: 1 << 5, // 1 = high-res mode
} as const;

// Variant lineup we plan to support. Excludes:
//   - mkII TR (no public ROM dump)
//   - PC-88 VA / VA2 / VA3 (μPD9002 hybrid CPU; needs MAME's
//     pc88va.cpp driver as a reference, not in scope)
//   - PC-8801 MC (CD-ROM interface; out of scope for first-light)
export type PC88Model =
  | "PC-8801"
  | "PC-8801 mkII"
  | "PC-8801 mkII SR"
  | "PC-8801 mkII FR"
  | "PC-8801 mkII MR"
  | "PC-8801 FH"
  | "PC-8801 MH"
  | "PC-8801 FA"
  | "PC-8801 MA"
  | "PC-8801 FE"
  | "PC-8801 MA2"
  | "PC-8801 FE2";

export interface CPUConfig {
  // μPD780C-1: 4 MHz Z80 (mkI through mkII MR)
  // μPD70008AC-8: 4/8 MHz selectable Z80 (FH/MH onwards)
  // The μPD9002 hybrid (Z80/8086) used on the VA family isn't
  // listed here — VA support is out of scope.
  readonly main: "μPD780C-1" | "μPD70008AC-8";
  readonly sub: "μPD780C-1" | "μPD70008AC-8";
  readonly highSpeedMode: boolean;
}

export interface MemoryConfig {
  // Total addressable RAM in KB. 64 on mkI / mkII / SR / FR / FA / FE
  // / FE2 / FH; 192 on MR / MH / MA / MA2 (the latter ship with
  // 64 KB main + 128 KB extended RAM bank-switched via ports
  // 0xE2/0xE3). The "has extended RAM" boolean is derivable from
  // `mainRam > 64`, so it's not a separate field.
  readonly mainRam: Kilobytes;
  readonly textVram: Kilobytes;
  // True iff TVRAM is a physically separate 4 KB chip (SR onwards).
  // On mkI/mkII the "text VRAM" region at 0xF000-0xFFFF is just the
  // upper 4 KB of main RAM — the CRTC reads it via DMAC but the
  // CPU side has no separate buffer, so writes to 0xF000+ also
  // appear in mainRam. SR introduces a separate text VRAM chip so
  // that the CRTC reads it without contending for main-RAM access.
  readonly tvramSeparate: boolean;
  // GVRAM is universally 3 × 16 KB across every PC-8801 variant we
  // model (mkI through MA2). PC88MemoryMap allocates that shape
  // unconditionally; if a future variant ever differs, add specific
  // fields here.
}

export interface VideoConfig {
  readonly modes: VideoMode[];
  // True from mkII SR onwards; mkI and mkII hardwire the 8-colour
  // digital palette. Selectable at runtime via port 0x32 bit 5
  // (PMODE_ANALOG) on the variants that have it.
  readonly hasAnaloguePalette: boolean;
  // (Whether a kanji ROM is fitted is derivable from
  //  `roms.kanji1 !== undefined` — every variant we model has one,
  //  so it isn't a separate field.)
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
