import type { Kilobytes } from "../flavours.js";

export interface PC88Config {
  readonly model: PC88Model;
  readonly cpu: CPUConfig;
  readonly memory: MemoryConfig;
  readonly video: VideoConfig;
  readonly sound: SoundConfig;
  readonly disk: DiskConfig;
  readonly roms: ROMManifest;
  readonly dipSwitches?: DipSwitchState;
}

// Placeholder until per-variant DIP-switch defaults are defined.
// Concrete shape (memory expansion, terminal mode, baud rate, etc.)
// belongs to whichever code first reads it.
export type DipSwitchState = Record<string, never>;

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
  readonly id: string;
  readonly size: Kilobytes;
  readonly md5: string;
  readonly required: boolean;
}

export const makeROM = (
  id: string,
  size: Kilobytes,
  md5: string,
  required = true,
): ROMDescriptor => ({ id, size, md5, required });
