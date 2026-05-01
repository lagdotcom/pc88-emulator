import type {
  Bytes,
  Cylinder,
  Head,
  Record,
  SectorIndex,
  SizeCode,
} from "../flavours.js";
import { getLogger } from "../log.js";
import {
  type Density,
  type Disk,
  type DiskMediaType,
  type Sector,
  type SectorID,
  type SectorMatch,
  type SectorStatus,
  type Track,
  WriteProtectedError,
} from "./types.js";

const log = getLogger("disk/d88");

// Format reference: refs/D88 Format.txt (QUASI88 docs, P88SR-derived).
const HEADER_SIZE = 0x2b0;
const TRACK_TABLE_ENTRIES = 164;
const TRACK_TABLE_OFFSET = 0x20;
const NAME_OFFSET = 0x00;
const NAME_LEN = 17;
const WRITE_PROTECT_OFFSET = 0x1a;
const DISK_TYPE_OFFSET = 0x1b;
const DISK_SIZE_OFFSET = 0x1c;

const SECTOR_HEADER_SIZE = 0x10;
const SECTOR_DATA_SIZE_OFFSET = 0x0e;

const WRITE_PROTECT_FLAG = 0x10;

const DISK_TYPE_TO_MEDIA: ReadonlyMap<number, DiskMediaType> = new Map([
  [0x00, "2D"],
  [0x10, "2DD"],
  [0x20, "2HD"],
]);
const MEDIA_TO_DISK_TYPE: ReadonlyMap<DiskMediaType, number> = new Map([
  ["2D", 0x00],
  ["2DD", 0x10],
  ["2HD", 0x20],
]);

const STATUS_FROM_BYTE: ReadonlyMap<number, SectorStatus> = new Map([
  [0x00, "ok"],
  [0x10, "deleted"],
  [0xa0, "id-crc"],
  [0xb0, "data-crc"],
  [0xe0, "no-address-mark"],
  [0xf0, "no-data-mark"],
]);
const STATUS_TO_BYTE: ReadonlyMap<SectorStatus, number> = new Map([
  ["ok", 0x00],
  ["deleted", 0x10],
  ["id-crc", 0xa0],
  ["data-crc", 0xb0],
  ["no-address-mark", 0xe0],
  ["no-data-mark", 0xf0],
]);

const HEADS_PER_DISK = 2;

export class D88ParseError extends Error {
  constructor(msg: string) {
    super(msg);
    this.name = "D88ParseError";
  }
}

interface MutableTrack {
  cylinder: Cylinder;
  head: Head;
  sectors: Sector[];
}

export class D88Disk implements Disk {
  readonly format = "D88";
  readonly mediaType: DiskMediaType;
  readonly cylinders: number;
  readonly heads = HEADS_PER_DISK;
  name: string;
  writeProtected: boolean;

  // Sparse: index = c * 2 + h. `undefined` slot = unformatted track.
  private tracks: (MutableTrack | undefined)[];

  constructor(opts: {
    name: string;
    mediaType: DiskMediaType;
    cylinders: number;
    writeProtected: boolean;
    tracks: (MutableTrack | undefined)[];
  }) {
    this.name = opts.name;
    this.mediaType = opts.mediaType;
    this.cylinders = opts.cylinders;
    this.writeProtected = opts.writeProtected;
    this.tracks = opts.tracks;
  }

  getTrack(c: Cylinder, h: Head): Track | undefined {
    return this.tracks[trackIndex(c, h)];
  }

  findSector(
    c: Cylinder,
    h: Head,
    r: Record,
    n: SizeCode,
    startAt: SectorIndex = 0,
  ): SectorMatch | undefined {
    const track = this.tracks[trackIndex(c, h)];
    if (!track) return undefined;
    const len = track.sectors.length;
    if (len === 0) return undefined;
    const start = ((startAt % len) + len) % len;
    for (let off = 0; off < len; off++) {
      const idx = (start + off) % len;
      const s = track.sectors[idx]!;
      if (s.id.c === c && s.id.h === h && s.id.r === r && s.id.n === n) {
        return { sector: s, index: idx as SectorIndex };
      }
    }
    return undefined;
  }

  writeSector(c: Cylinder, h: Head, index: SectorIndex, data: Uint8Array): void {
    if (this.writeProtected) throw new WriteProtectedError();
    const track = this.tracks[trackIndex(c, h)];
    if (!track) throw new Error(`writeSector on unformatted track c=${c} h=${h}`);
    const existing = track.sectors[index];
    if (!existing) throw new Error(`writeSector index ${index} out of range`);
    track.sectors[index] = {
      id: existing.id,
      density: existing.density,
      status: existing.status,
      deleted: existing.deleted,
      data: new Uint8Array(data),
    };
  }

  formatTrack(c: Cylinder, h: Head, sectors: ReadonlyArray<Sector>): void {
    if (this.writeProtected) throw new WriteProtectedError();
    const idx = trackIndex(c, h);
    if (sectors.length === 0) {
      this.tracks[idx] = undefined;
      return;
    }
    this.tracks[idx] = {
      cylinder: c,
      head: h,
      sectors: sectors.map(s => ({
        id: s.id,
        density: s.density,
        status: s.status,
        deleted: s.deleted,
        data: new Uint8Array(s.data),
      })),
    };
  }

  toBytes(): Uint8Array {
    const trackBlobs: Uint8Array[] = [];
    const offsets = new Array<number>(TRACK_TABLE_ENTRIES).fill(0);
    let cursor = HEADER_SIZE;
    for (let i = 0; i < TRACK_TABLE_ENTRIES; i++) {
      const t = this.tracks[i];
      if (!t || t.sectors.length === 0) continue;
      offsets[i] = cursor;
      const blob = serialiseTrack(t);
      trackBlobs.push(blob);
      cursor += blob.length;
    }
    const totalSize = cursor;
    const out = new Uint8Array(totalSize);
    const view = new DataView(out.buffer);

    writeAsciiNul(out, NAME_OFFSET, NAME_LEN, this.name);
    out[WRITE_PROTECT_OFFSET] = this.writeProtected ? WRITE_PROTECT_FLAG : 0;
    out[DISK_TYPE_OFFSET] = MEDIA_TO_DISK_TYPE.get(this.mediaType)!;
    view.setUint32(DISK_SIZE_OFFSET, totalSize, true);
    for (let i = 0; i < TRACK_TABLE_ENTRIES; i++) {
      view.setUint32(TRACK_TABLE_OFFSET + i * 4, offsets[i]!, true);
    }
    let writeCursor = HEADER_SIZE;
    for (const blob of trackBlobs) {
      out.set(blob, writeCursor);
      writeCursor += blob.length;
    }
    return out;
  }
}

// Multi-image D88 files concatenate independent images. We parse all
// of them — typically the caller takes [0] for single-disk titles and
// surfaces all of them in a drive picker for multi-disk titles.
export function parseD88(bytes: Uint8Array): D88Disk[] {
  const disks: D88Disk[] = [];
  let cursor = 0;
  while (cursor < bytes.length) {
    const remaining = bytes.length - cursor;
    if (remaining < HEADER_SIZE) {
      if (disks.length === 0)
        throw new D88ParseError(
          `truncated header: ${remaining} bytes left, need ${HEADER_SIZE}`,
        );
      log.warn(`trailing ${remaining} bytes after final image, ignoring`);
      break;
    }
    const view = new DataView(
      bytes.buffer,
      bytes.byteOffset + cursor,
      remaining,
    );
    const declaredSize = view.getUint32(DISK_SIZE_OFFSET, true);
    if (declaredSize < HEADER_SIZE || declaredSize > remaining) {
      throw new D88ParseError(
        `image ${disks.length}: disk_size=${declaredSize} out of range (remaining=${remaining})`,
      );
    }
    const slice = bytes.subarray(cursor, cursor + declaredSize);
    disks.push(parseSingleD88(slice, disks.length));
    cursor += declaredSize;
  }
  return disks;
}

function parseSingleD88(bytes: Uint8Array, imageIndex: number): D88Disk {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const name = readAsciiNul(bytes, NAME_OFFSET, NAME_LEN);
  const writeProtected = bytes[WRITE_PROTECT_OFFSET] === WRITE_PROTECT_FLAG;
  const diskType = bytes[DISK_TYPE_OFFSET]!;
  const mediaType = DISK_TYPE_TO_MEDIA.get(diskType);
  if (!mediaType)
    throw new D88ParseError(
      `image ${imageIndex}: unknown disk_type 0x${diskType.toString(16)}`,
    );

  const tracks: (MutableTrack | undefined)[] = new Array(TRACK_TABLE_ENTRIES);
  let highestPopulated = -1;
  for (let i = 0; i < TRACK_TABLE_ENTRIES; i++) {
    const off = view.getUint32(TRACK_TABLE_OFFSET + i * 4, true);
    if (off === 0) continue;
    if (off < HEADER_SIZE || off >= bytes.length)
      throw new D88ParseError(
        `image ${imageIndex}: track ${i} offset 0x${off.toString(16)} out of range`,
      );
    const cyl = (i >>> 1) as Cylinder;
    const head = (i & 1) as Head;
    tracks[i] = parseTrack(bytes, off, cyl, head, imageIndex, i);
    if (i > highestPopulated) highestPopulated = i;
  }
  const cylinders =
    highestPopulated < 0 ? 0 : Math.floor(highestPopulated / HEADS_PER_DISK) + 1;

  return new D88Disk({
    name,
    mediaType,
    cylinders,
    writeProtected,
    tracks,
  });
}

function parseTrack(
  bytes: Uint8Array,
  startOffset: number,
  cylinder: Cylinder,
  head: Head,
  imageIndex: number,
  trackIdx: number,
): MutableTrack {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const sectors: Sector[] = [];
  let off = startOffset;
  let declaredCount: number | undefined;
  while (true) {
    if (off + SECTOR_HEADER_SIZE > bytes.length)
      throw new D88ParseError(
        `image ${imageIndex} track ${trackIdx}: sector header runs past EOF at 0x${off.toString(16)}`,
      );
    const c = bytes[off]! as Cylinder;
    const h = bytes[off + 1]! as Head;
    const r = bytes[off + 2]! as Record;
    const n = bytes[off + 3]! as SizeCode;
    const numInTrack = view.getUint16(off + 4, true);
    const densityByte = bytes[off + 6]!;
    const deletedByte = bytes[off + 7]!;
    const statusByte = bytes[off + 8]!;
    const dataLen = view.getUint16(off + SECTOR_DATA_SIZE_OFFSET, true);
    const dataStart = off + SECTOR_HEADER_SIZE;
    const dataEnd = dataStart + dataLen;
    if (dataEnd > bytes.length)
      throw new D88ParseError(
        `image ${imageIndex} track ${trackIdx}: sector data runs past EOF at 0x${dataStart.toString(16)}`,
      );

    if (declaredCount === undefined) {
      declaredCount = numInTrack;
    } else if (numInTrack !== declaredCount) {
      log.warn(
        `image ${imageIndex} track ${trackIdx}: sector ${sectors.length} reports count=${numInTrack}, expected ${declaredCount}`,
      );
    }

    const density: Density = densityByte === 0x40 ? "FM" : "MFM";
    const deleted = deletedByte === 0x10;
    const status = STATUS_FROM_BYTE.get(statusByte) ?? "ok";
    if (!STATUS_FROM_BYTE.has(statusByte))
      log.warn(
        `image ${imageIndex} track ${trackIdx}: unknown status 0x${statusByte.toString(16)} at sector ${sectors.length}, treating as ok`,
      );

    sectors.push({
      id: { c, h, r, n },
      density,
      status,
      deleted: deleted || status === "deleted",
      data: bytes.slice(dataStart, dataEnd),
    });

    off = dataEnd;
    if (sectors.length >= (declaredCount ?? 0)) break;
  }
  return { cylinder, head, sectors };
}

function serialiseTrack(track: MutableTrack): Uint8Array {
  let total: Bytes = 0 as Bytes;
  for (const s of track.sectors) total = (total + SECTOR_HEADER_SIZE + s.data.length) as Bytes;
  const out = new Uint8Array(total);
  const view = new DataView(out.buffer);
  let off = 0;
  for (const s of track.sectors) {
    out[off] = s.id.c;
    out[off + 1] = s.id.h;
    out[off + 2] = s.id.r;
    out[off + 3] = s.id.n;
    view.setUint16(off + 4, track.sectors.length, true);
    out[off + 6] = s.density === "FM" ? 0x40 : 0x00;
    out[off + 7] = s.deleted || s.status === "deleted" ? 0x10 : 0x00;
    out[off + 8] = STATUS_TO_BYTE.get(s.status) ?? 0x00;
    view.setUint16(off + SECTOR_DATA_SIZE_OFFSET, s.data.length, true);
    out.set(s.data, off + SECTOR_HEADER_SIZE);
    off += SECTOR_HEADER_SIZE + s.data.length;
  }
  return out;
}

function trackIndex(c: Cylinder, h: Head): number {
  return c * HEADS_PER_DISK + h;
}

function readAsciiNul(buf: Uint8Array, offset: number, len: number): string {
  let end = offset;
  const stop = offset + len;
  while (end < stop && buf[end] !== 0) end++;
  let out = "";
  for (let i = offset; i < end; i++) out += String.fromCharCode(buf[i]!);
  return out;
}

function writeAsciiNul(
  buf: Uint8Array,
  offset: number,
  len: number,
  value: string,
): void {
  const max = len - 1;
  for (let i = 0; i < max && i < value.length; i++) {
    buf[offset + i] = value.charCodeAt(i) & 0xff;
  }
}

export function makeSector(
  c: Cylinder,
  h: Head,
  r: Record,
  n: SizeCode,
  data: Uint8Array,
  opts: { density?: Density; status?: SectorStatus; deleted?: boolean } = {},
): Sector {
  const id: SectorID = { c, h, r, n };
  return {
    id,
    density: opts.density ?? "MFM",
    status: opts.status ?? "ok",
    deleted: opts.deleted ?? false,
    data,
  };
}
