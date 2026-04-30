import logLib from "log";

import type { MemoryProvider } from "../core/MemoryBus.js";
import type { u8, u16 } from "../flavours.js";

const log = logLib.get("pc88-memory");

const PAGE_SHIFT = 12; // 4 KB pages
const PAGE_SIZE = 1 << PAGE_SHIFT;
const PAGE_MASK = PAGE_SIZE - 1;
const PAGE_COUNT = 0x10000 >> PAGE_SHIFT;

// Loaded image of one ROM. The N-BASIC and N88-BASIC images are
// always present; the four E-ROM extension slots and (later) the
// font / kanji ROMs are optional and per-variant. The map falls
// back to the BASIC ROM continuation at 0x6000-0x7FFF when the
// active extension slot has no image loaded.
//
// Optional/required-ness mirrors ROMManifest in machines/config.ts.
// Required slots are non-optional here so PC88Machine consumers
// don't need a runtime "is this ROM loaded?" check — the loader
// has already thrown if a required slot was missing or invalid.
export interface LoadedROMs {
  readonly n80: Uint8Array; // 32 KB
  readonly n88: Uint8Array; // 32 KB
  readonly e0?: Uint8Array; //  8 KB
  readonly e1?: Uint8Array; //  8 KB
  readonly e2?: Uint8Array; //  8 KB
  readonly e3?: Uint8Array; //  8 KB
}

export type BasicMode = "n80" | "n88";
export type EROMSlot = 0 | 1 | 2 | 3;

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

  // Text VRAM (4 KB at 0xF000–0xFFFF). On mkI/mkII this is just the
  // upper 4 KB of main RAM — there is no separate physical chip; the
  // CRTC reads the same RAM the CPU writes to. SR onwards has a
  // dedicated 4 KB chip; in that case we allocate a separate buffer.
  // Either way `.tvram` is a Uint8Array view of the right backing
  // store, so callers (display, tests, snapshot) don't care which
  // model is in use.
  readonly tvram: Uint8Array;

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
  private _basicROMEnabled = true;
  private _basicMode: BasicMode = "n80";
  // Active extension-ROM slot (port 0x32, bits 0-1). The selected
  // slot's image is mapped at 0x6000-0x7FFF only when the chip has
  // also been *enabled*; otherwise the page falls through to the
  // BASIC ROM continuation. Reset state is "slot 0, disabled" — the
  // BIOS init path expects BASIC continuation at boot and toggles
  // the enable when it wants an E-ROM in. Earlier code modelled
  // "slot 0 = always-enabled E0" which broke first-light because
  // E0 was mapped at 0x6000 before the BIOS asked for it.
  private _eromSlot: EROMSlot = 0;
  private _eromEnabled = false;
  private _vramEnabled = false;
  private _gvramPlane: 0 | 1 | 2 = 0;

  readonly readPages: Uint8Array[] = new Array(PAGE_COUNT);
  readonly writePages: Uint8Array[] = new Array(PAGE_COUNT);

  constructor(
    private readonly roms: LoadedROMs,
    opts: { tvramSeparate?: boolean } = {},
  ) {
    this.tvram = opts.tvramSeparate
      ? new Uint8Array(0x1000)
      : this.mainRam.subarray(0xf000, 0x10000);
    this.refreshPages();
  }

  read(offset: u16): u8 {
    return this.readPages[offset >> PAGE_SHIFT]![offset & PAGE_MASK]!;
  }

  write(offset: u16, value: u8): void {
    this.writePages[offset >> PAGE_SHIFT]![offset & PAGE_MASK] = value;
  }

  setBasicRomEnabled(enabled: boolean): void {
    if (this._basicROMEnabled === enabled) return;
    this._basicROMEnabled = enabled;
    this.refreshPages();
  }

  setBasicMode(mode: BasicMode): void {
    if (this._basicMode === mode) return;
    this._basicMode = mode;
    this.refreshPages();
  }

  setEROMSlot(slot: EROMSlot): void {
    if (this._eromSlot === slot) return;
    this._eromSlot = slot;
    this.refreshPages();
  }

  setEROMEnabled(enabled: boolean): void {
    if (this._eromEnabled === enabled) return;
    this._eromEnabled = enabled;
    this.refreshPages();
  }

  setVRAMEnabled(enabled: boolean): void {
    if (this._vramEnabled === enabled) return;
    this._vramEnabled = enabled;
    this.refreshPages();
  }

  setGVRAMPlane(plane: 0 | 1 | 2): void {
    if (this._gvramPlane === plane) return;
    this._gvramPlane = plane;
    this.refreshPages();
  }

  get basicROMEnabled(): boolean {
    return this._basicROMEnabled;
  }
  get basicMode(): BasicMode {
    return this._basicMode;
  }
  get eromSlot(): EROMSlot {
    return this._eromSlot;
  }
  get eromEnabled(): boolean {
    return this._eromEnabled;
  }
  get vramEnabled(): boolean {
    return this._vramEnabled;
  }

  // Recompute every page pointer from current bank state. Cheap enough
  // to call on every bank-select write.
  refreshPages(): void {
    const ram = this.mainRam;

    // 0x0000-0x5FFF: BASIC ROM (n80 or n88) when enabled, else RAM.
    // 0x6000-0x7FFF: extension ROM whose slot is selected at port
    //                0x32 bits 0-1, OR the BASIC ROM continuation
    //                if no image is loaded for that slot.
    //
    // Reads come from the ROM image when mapped; writes to those
    // pages go through to main RAM at the same offset (write-through
    // shadowing). Real silicon: the ROM /OE is gated by the bank
    // register but the RAM /WE always tracks the bus, so a Z80 write
    // at 0x1234 lands in RAM[0x1234] regardless of ROM mapping. Once
    // the BIOS unmaps the BASIC ROM at runtime, those previously
    // hidden RAM writes become visible — without write-through the
    // RAM behind the ROM would stay zero forever.
    const basicRom = this._basicMode === "n80" ? this.roms.n80 : this.roms.n88;
    if (this._basicROMEnabled) {
      this.mapROMPages(0, 6, basicRom, 0);

      const erom = this.activeEROMImage();
      if (erom) this.mapROMPages(6, 8, erom, 0);
      else this.mapROMPages(6, 8, basicRom, 6 * PAGE_SIZE);
    } else {
      for (let p = 0; p < 8; p++) this.mapRAMPage(p, ram, p * PAGE_SIZE);
    }

    // 0x8000-0xBFFF: always main RAM.
    for (let p = 8; p < 12; p++) this.mapRAMPage(p, ram, p * PAGE_SIZE);

    // 0xC000-0xEFFF: GVRAM plane when VRAM window enabled, else RAM.
    if (this._vramEnabled) {
      const gv = this.gvram[this._gvramPlane];
      for (let p = 12; p < 15; p++) {
        this.mapRAMPage(p, gv, (p - 12) * PAGE_SIZE);
      }
    } else {
      for (let p = 12; p < 15; p++) this.mapRAMPage(p, ram, p * PAGE_SIZE);
    }

    // TODO TVRAM is only separate on SR onwards.
    // 0xF000-0xFFFF: TVRAM is permanently mapped here on PC-8801 mkI.
    // The CRTC decides whether the contents are displayed, but CPU
    // memory access always sees TVRAM at 0xF000 — there is no banking
    // toggle for this range. Earlier code modelled a `_tvramEnabled`
    // flag and mapped main RAM here as a fallback; that was wrong and
    // caused BIOS writes to vanish into shadow RAM until a guess at
    // a port write happened to flip the flag. Always map TVRAM.
    this.mapRAMPage(15, this.tvram, 0);

    // TODO my memory map doc mentions the 'Text Window'
    //      this is a 1K block whose upper byte is written to [port 0x70]
    //      it maps itself to 0x8000-0x83FF when RMODE=0, MMODE=0
  }

  // Return the loaded ROM image for the currently-selected slot, or
  // undefined if no image is loaded for that slot. Callers fall back
  // to the BASIC ROM continuation when this returns undefined.
  private activeEROMImage() {
    if (!this._eromEnabled) return;

    switch (this._eromSlot) {
      case 0:
        return this.roms.e0;
      case 1:
        return this.roms.e1;
      case 2:
        return this.roms.e2;
      case 3:
        return this.roms.e3;
    }
  }

  private mapROMPages(
    fromPage: number,
    toPage: number,
    rom: Uint8Array,
    romOffset: u16,
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
      // Writes to ROM-mapped pages still hit main RAM at the same
      // CPU-side offset — the RAM is "shadowed" by the ROM but
      // physically present and writable. Once the BIOS disables the
      // ROM, the RAM contents (potentially populated by writes that
      // happened while ROM was mapped) become readable.
      const ramOff = p * PAGE_SIZE;
      this.writePages[p] = this.mainRam.subarray(ramOff, ramOff + PAGE_SIZE);
    }
  }

  private mapRAMPage(page: number, backing: Uint8Array, offset: u16): void {
    const slice = backing.subarray(offset, offset + PAGE_SIZE);
    this.readPages[page] = slice;
    this.writePages[page] = slice;
  }
}
