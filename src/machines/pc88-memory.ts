import logLib from "log";

import type { MemoryProvider } from "../core/MemoryBus.js";
import type { u8 } from "../flavours.js";

const log = logLib.get("pc88-memory");

const PAGE_SHIFT = 12; // 4 KB pages
const PAGE_SIZE = 1 << PAGE_SHIFT;
const PAGE_MASK = PAGE_SIZE - 1;
const PAGE_COUNT = 0x10000 >> PAGE_SHIFT;

// Loaded image of one ROM. We don't try to slice the underlying bytes
// into per-page sub-arrays here; the map does that on every refresh.
export interface LoadedRoms {
  readonly n80: Uint8Array; // 32 KB
  readonly n88: Uint8Array; // 32 KB
  readonly e0: Uint8Array; //   8 KB
}

export type BasicMode = "n80" | "n88";

// PC-88 memory layout, paged at 4 KB granularity. Reads dispatch
// through `readPages[addr >> 12][addr & 0xfff]` — one indirection,
// indexed Uint8Array load. Writes through `writePages` similarly.
//
// Bank-switching writes `n80`/`n88`/etc. into the state fields below
// and call `refreshPages()` once; subsequent reads/writes pick up the
// new layout with no per-access conditional logic.
//
// Slots that don't physically exist on mkI (no FDC, no extra
// extension ROMs) are not modelled here — the layout below is the
// minimum needed to land BASIC at 0x0000 and let the ROM toggle into
// VRAM windows at 0xC000+.
export class PC88MemoryMap implements MemoryProvider {
  readonly name = "pc88-mem";
  readonly start = 0;
  readonly end = 0x10000;

  // 64 KB of main RAM. Always present; pages 8–11 (0x8000–0xBFFF) are
  // always backed by it. Pages 0–7 and 12–15 may shadow it.
  readonly mainRam = new Uint8Array(0x10000);

  // Text VRAM (4 KB at 0xF000–0xFFFF when VRAM window is enabled).
  readonly tvram = new Uint8Array(0x1000);

  // 3 graphics planes, 16 KB each (0xC000–0xFFFF when VRAM window is
  // enabled and the plane is selected). Only one plane is mapped at a
  // time on the main bus.
  readonly gvram: [Uint8Array, Uint8Array, Uint8Array] = [
    new Uint8Array(0x4000),
    new Uint8Array(0x4000),
    new Uint8Array(0x4000),
  ];

  // Bank state. Mutate via the public setters below; each setter calls
  // refreshPages() so that read/write pick up the new mapping.
  private _basicRomEnabled = true;
  private _basicMode: BasicMode = "n80";
  private _e0RomEnabled = false;
  private _vramEnabled = false;
  private _gvramPlane: 0 | 1 | 2 = 0;
  private _tvramEnabled = false;

  // 4 KB scratch that catches writes that target ROM. Anything written
  // here is silently lost; reads from it return zero.
  private readonly discard = new Uint8Array(PAGE_SIZE);

  readonly readPages: Uint8Array[] = new Array(PAGE_COUNT);
  readonly writePages: Uint8Array[] = new Array(PAGE_COUNT);

  constructor(private readonly roms: LoadedRoms) {
    this.refreshPages();
  }

  read(offset: number): u8 {
    return this.readPages[offset >> PAGE_SHIFT]![offset & PAGE_MASK]!;
  }

  write(offset: number, value: u8): void {
    this.writePages[offset >> PAGE_SHIFT]![offset & PAGE_MASK] = value;
  }

  setBasicRomEnabled(enabled: boolean): void {
    if (this._basicRomEnabled === enabled) return;
    this._basicRomEnabled = enabled;
    this.refreshPages();
  }

  setBasicMode(mode: BasicMode): void {
    if (this._basicMode === mode) return;
    this._basicMode = mode;
    this.refreshPages();
  }

  setE0RomEnabled(enabled: boolean): void {
    if (this._e0RomEnabled === enabled) return;
    this._e0RomEnabled = enabled;
    this.refreshPages();
  }

  setVramEnabled(enabled: boolean): void {
    if (this._vramEnabled === enabled) return;
    this._vramEnabled = enabled;
    this.refreshPages();
  }

  setTvramEnabled(enabled: boolean): void {
    if (this._tvramEnabled === enabled) return;
    this._tvramEnabled = enabled;
    this.refreshPages();
  }

  setGvramPlane(plane: 0 | 1 | 2): void {
    if (this._gvramPlane === plane) return;
    this._gvramPlane = plane;
    this.refreshPages();
  }

  get basicRomEnabled(): boolean {
    return this._basicRomEnabled;
  }
  get basicMode(): BasicMode {
    return this._basicMode;
  }
  get vramEnabled(): boolean {
    return this._vramEnabled;
  }
  get tvramEnabled(): boolean {
    return this._tvramEnabled;
  }

  // Recompute every page pointer from current bank state. Cheap enough
  // to call on every bank-select write.
  refreshPages(): void {
    const ram = this.mainRam;

    // 0x0000-0x5FFF: BASIC ROM (n80 or n88) when enabled, else RAM.
    // 0x6000-0x7FFF: E0 extension ROM if enabled, else continues the
    //                BASIC ROM, else RAM.
    const basicRom = this._basicMode === "n80" ? this.roms.n80 : this.roms.n88;
    if (this._basicRomEnabled) {
      this.mapRomPages(0, 6, basicRom, 0);
      if (this._e0RomEnabled) {
        this.mapRomPages(6, 8, this.roms.e0, 0);
      } else {
        this.mapRomPages(6, 8, basicRom, 6 * PAGE_SIZE);
      }
    } else {
      for (let p = 0; p < 8; p++) this.mapRamPage(p, ram, p * PAGE_SIZE);
    }

    // 0x8000-0xBFFF: always main RAM.
    for (let p = 8; p < 12; p++) this.mapRamPage(p, ram, p * PAGE_SIZE);

    // 0xC000-0xEFFF: GVRAM plane when VRAM window enabled, else RAM.
    // 0xF000-0xFFFF: TVRAM when window enabled, else RAM.
    if (this._vramEnabled) {
      const gv = this.gvram[this._gvramPlane];
      for (let p = 12; p < 15; p++) {
        this.mapRamPage(p, gv, (p - 12) * PAGE_SIZE);
      }
    } else {
      for (let p = 12; p < 15; p++) this.mapRamPage(p, ram, p * PAGE_SIZE);
    }

    // TVRAM is independently togglable on real hardware (driven by
    // CRTC + 8255 PPI). Mirror that for the 0xF000 page.
    if (this._tvramEnabled) {
      this.mapRamPage(15, this.tvram, 0);
    } else {
      this.mapRamPage(15, ram, 15 * PAGE_SIZE);
    }
  }

  private mapRomPages(
    fromPage: number,
    toPage: number,
    rom: Uint8Array,
    romOffset: number,
  ): void {
    for (let p = fromPage; p < toPage; p++) {
      const off = romOffset + (p - fromPage) * PAGE_SIZE;
      if (off + PAGE_SIZE > rom.length) {
        // ROM is too short for this slot; zero-fill the rest.
        log.warn(
          `ROM short at page ${p}: rom length ${rom.length}, want ${off + PAGE_SIZE}`,
        );
        this.readPages[p] = new Uint8Array(PAGE_SIZE);
      } else {
        this.readPages[p] = rom.subarray(off, off + PAGE_SIZE);
      }
      this.writePages[p] = this.discard;
    }
  }

  private mapRamPage(page: number, backing: Uint8Array, offset: number): void {
    const slice = backing.subarray(offset, offset + PAGE_SIZE);
    this.readPages[page] = slice;
    this.writePages[page] = slice;
  }
}
