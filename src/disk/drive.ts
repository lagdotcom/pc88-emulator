import type {
  Cylinder,
  Head,
  Record,
  SectorIndex,
  SizeCode,
} from "../flavours.js";
import {
  type Disk,
  type Sector,
  type SectorID,
  WriteProtectedError,
} from "./types.js";

const DEFAULT_MAX_CYLINDER = 82;

export interface FloppyDriveSnapshot {
  readonly motorOn: boolean;
  readonly cylinder: Cylinder;
  readonly rotation: SectorIndex;
  readonly hasDisk: boolean;
}

export interface ScanResult {
  readonly sector: Sector;
  readonly index: SectorIndex;
  readonly indexHolePassed: boolean;
}

export interface ReadIDResult {
  readonly id: SectorID;
  readonly index: SectorIndex;
}

// FloppyDrive holds physical drive state — what's spinning, where the
// head is, how far around the rotation we are. The FDC will own
// `FloppyDrive[N]`; it never touches `Disk` directly. Step rate, motor
// spin-up, and rotational latency belong to the FDC's timing model;
// the drive only tracks position.
export class FloppyDrive {
  private disk: Disk | undefined;
  motorOn = false;
  cylinder: Cylinder = 0 as Cylinder;
  rotation: SectorIndex = 0 as SectorIndex;
  readonly maxCylinder: Cylinder;

  constructor(opts: { maxCylinder?: Cylinder } = {}) {
    this.maxCylinder = opts.maxCylinder ?? (DEFAULT_MAX_CYLINDER as Cylinder);
  }

  insert(disk: Disk): void {
    this.disk = disk;
    this.rotation = 0 as SectorIndex;
  }

  eject(): Disk | undefined {
    const out = this.disk;
    this.disk = undefined;
    this.rotation = 0 as SectorIndex;
    return out;
  }

  hasDisk(): boolean {
    return this.disk !== undefined;
  }

  // FDC drive-not-ready check. Real hardware needs both a disk and an
  // already-spun-up motor; the FDC's READY signal gates every
  // data-transfer command on this.
  isReady(): boolean {
    return this.disk !== undefined && this.motorOn;
  }

  isWriteProtected(): boolean {
    return this.disk?.writeProtected ?? false;
  }

  isAtTrack0(): boolean {
    return this.cylinder === 0;
  }

  // Step head one cylinder in (+1) or out (-1). Real μPD-class drives
  // physically clamp at track 0 (TRK0 sensor) and at the mechanical
  // stop past the last track; we clamp identically and let the FDC
  // poll `isAtTrack0()` for its RECALIBRATE termination.
  step(direction: -1 | 1): void {
    const next = this.cylinder + direction;
    if (next < 0) {
      this.cylinder = 0 as Cylinder;
      return;
    }
    if (next > this.maxCylinder) {
      this.cylinder = this.maxCylinder;
      return;
    }
    this.cylinder = next as Cylinder;
  }

  // FDC RECALIBRATE: step out until TRK0 asserts, capped at 77 steps
  // on real silicon. We do it in one move because callers don't
  // observe intermediate states; the FDC's timing layer schedules the
  // 77 step pulses.
  recalibrate(): void {
    this.cylinder = 0 as Cylinder;
  }

  // Scan physical sectors at the current cylinder + given head,
  // starting at the rotation cursor, for one matching {r, n}. On a
  // hit, advance the cursor *past* the matched sector so a chained
  // read picks up the next-physical sector. Reports `indexHolePassed`
  // so the FDC can implement the "two-rotation no-data timeout".
  scanForSector(h: Head, r: Record, n: SizeCode): ScanResult | undefined {
    if (!this.disk) return undefined;
    const track = this.disk.getTrack(this.cylinder, h);
    if (!track || track.sectors.length === 0) return undefined;
    const len = track.sectors.length;
    const start = ((this.rotation % len) + len) % len;
    for (let off = 0; off < len; off++) {
      const idx = (start + off) % len;
      const s = track.sectors[idx]!;
      if (s.id.r === r && s.id.n === n) {
        const next = (idx + 1) % len;
        const indexHolePassed = next <= start && off > 0;
        this.rotation = next as SectorIndex;
        return { sector: s, index: idx as SectorIndex, indexHolePassed };
      }
    }
    return undefined;
  }

  // FDC READ ID: return whichever sector ID passes the head next, then
  // advance the cursor past it. Always succeeds on a formatted track.
  readNextSectorID(h: Head): ReadIDResult | undefined {
    if (!this.disk) return undefined;
    const track = this.disk.getTrack(this.cylinder, h);
    if (!track || track.sectors.length === 0) return undefined;
    const len = track.sectors.length;
    const idx = ((this.rotation % len) + len) % len;
    const s = track.sectors[idx]!;
    this.rotation = ((idx + 1) % len) as SectorIndex;
    return { id: s.id, index: idx as SectorIndex };
  }

  writeSector(h: Head, index: SectorIndex, data: Uint8Array): void {
    if (!this.disk) throw new Error("writeSector: no disk inserted");
    if (this.disk.writeProtected) throw new WriteProtectedError();
    this.disk.writeSector(this.cylinder, h, index, data);
  }

  formatCurrentTrack(h: Head, sectors: ReadonlyArray<Sector>): void {
    if (!this.disk) throw new Error("formatCurrentTrack: no disk inserted");
    if (this.disk.writeProtected) throw new WriteProtectedError();
    this.disk.formatTrack(this.cylinder, h, sectors);
    this.rotation = 0 as SectorIndex;
  }

  snapshot(): FloppyDriveSnapshot {
    return {
      motorOn: this.motorOn,
      cylinder: this.cylinder,
      rotation: this.rotation,
      hasDisk: this.disk !== undefined,
    };
  }

  // The disk image itself is not part of the snapshot — it's huge and
  // is reattached by the savestate loader the same way TVRAM /
  // mainRam are. `hasDisk` is informational so a load can validate
  // that a disk was reattached when the snapshot expected one.
  fromSnapshot(s: FloppyDriveSnapshot): void {
    this.motorOn = s.motorOn;
    this.cylinder = s.cylinder;
    this.rotation = s.rotation;
  }
}
