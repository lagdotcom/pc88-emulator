import type { Cylinder, Head, Record, SectorIndex, SizeCode } from "../flavours.js";

export type DiskMediaType = "2D" | "2DD" | "2HD";

export type Density = "FM" | "MFM";

// D88 stores the FDC result-status byte alongside each sector so that
// a deliberately-corrupt sector (CRC error / missing AM, used by copy
// protections) survives a round-trip through the image. The string
// enum maps onto μPD765 ST1/ST2 bits when the FDC eventually consumes
// them; see refs/D88 Format.txt for the byte values.
export type SectorStatus =
  | "ok"
  | "deleted"
  | "id-crc"
  | "data-crc"
  | "no-address-mark"
  | "no-data-mark";

export interface SectorID {
  readonly c: Cylinder;
  readonly h: Head;
  readonly r: Record;
  readonly n: SizeCode;
}

// `data.length` may differ from `128 << n` — copy protections write
// short or oversized data fields, and the FDC reports whatever the
// physical sector actually held. Never auto-pad or truncate.
export interface Sector {
  readonly id: SectorID;
  readonly density: Density;
  readonly status: SectorStatus;
  readonly deleted: boolean;
  readonly data: Uint8Array;
}

export interface Track {
  readonly cylinder: Cylinder;
  readonly head: Head;
  readonly sectors: ReadonlyArray<Sector>;
}

export interface SectorMatch {
  readonly sector: Sector;
  readonly index: SectorIndex;
}

// Format-agnostic disk image. Implementations (D88Disk, future
// formats) own the in-memory mutation; toBytes() reserialises to the
// implementation's native format so a "save modified disk under a new
// name" flow can write the result straight to a file.
export interface Disk {
  readonly format: string;
  readonly mediaType: DiskMediaType;
  readonly cylinders: number;
  readonly heads: number;
  readonly name: string;
  writeProtected: boolean;

  getTrack(c: Cylinder, h: Head): Track | undefined;

  // Scan physical sectors starting at `startAt` (inclusive, wrapping)
  // for one whose ID matches {c,h,r,n}. Mirrors the FDC's "wait for
  // matching ID gap as the head spins past" loop.
  findSector(
    c: Cylinder,
    h: Head,
    r: Record,
    n: SizeCode,
    startAt?: SectorIndex,
  ): SectorMatch | undefined;

  writeSector(c: Cylinder, h: Head, index: SectorIndex, data: Uint8Array): void;

  formatTrack(c: Cylinder, h: Head, sectors: ReadonlyArray<Sector>): void;

  toBytes(): Uint8Array;
}

export class WriteProtectedError extends Error {
  constructor() {
    super("disk is write-protected");
    this.name = "WriteProtectedError";
  }
}
