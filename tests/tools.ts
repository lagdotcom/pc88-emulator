import type { MemoryProvider } from "../src/core/MemoryBus.js";
import { D88Disk, makeSector } from "../src/disk/d88.js";
import type { Sector } from "../src/disk/types.js";
import type {
  Cylinder,
  Head,
  Hours,
  Minutes,
  Record,
  SectorIndex,
  Seconds,
  SizeCode,
  u8,
  u16,
} from "../src/flavours.js";
import { PC88Key } from "../src/machines/pc88-input.js";

export function filledROM(size: number, fill: u8) {
  return new Uint8Array(size).fill(fill);
}

export class RAM64k implements MemoryProvider {
  name = "ram";
  start = 0;
  end = 0x10000;
  bytes = new Uint8Array(0x10000);
  read(o: u16) {
    return this.bytes[o]!;
  }
  write(o: u16, v: u8) {
    this.bytes[o] = v;
  }
}

export class TestIO {
  name = "io";
  inputs = new Map<u16, u8[]>();
  reads: [u16, u8][] = [];
  writes: [u16, u8][] = [];

  enqueueInput(port: u16, value: u8): void {
    let q = this.inputs.get(port);
    if (!q) {
      q = [];
      this.inputs.set(port, q);
    }
    q.push(value);
  }

  read = (port: u16): u8 => {
    const q = this.inputs.get(port);
    const value = q?.shift() ?? 0xff;
    this.reads.push([port, value]);
    return value;
  };

  write = (port: u16, value: u8): void => {
    this.writes.push([port, value]);
  };
}

// Brand-cast helpers for hand-built disk fixtures. The values are
// plain numbers in the test source; the casts make them carry the
// right phantom type at the call site without polluting every line.
export const C = (n: number) => n as Cylinder;
export const H = (n: number) => n as Head;
export const R = (n: number) => n as Record;
export const N = (n: number) => n as SizeCode;
export const S = (n: number) => n as SectorIndex;

// Reproducible 0..255-range data for a sector, seeded so different
// (c,h,r) triples don't accidentally produce the same bytes.
export function fillSectorData(seed: number, len: number): Uint8Array {
  const out = new Uint8Array(len);
  for (let i = 0; i < len; i++) out[i] = (seed + i) & 0xff;
  return out;
}

// Build a small in-memory D88 disk: `cylinders` × 2 heads, each track
// with `sectorsPerTrack` 256-byte MFM sectors. Per-sector data uses a
// distinct seed so failures point at the wrong sector.
export function buildTestDisk(
  opts: {
    cylinders?: number;
    sectorsPerTrack?: number;
    name?: string;
    writeProtected?: boolean;
  } = {},
): D88Disk {
  const cylinders = opts.cylinders ?? 3;
  const sectorsPerTrack = opts.sectorsPerTrack ?? 4;
  const tracks: ({ cylinder: Cylinder; head: Head; sectors: Sector[] } | undefined)[] = [];
  for (let c = 0; c < cylinders; c++) {
    for (let h = 0; h < 2; h++) {
      const sectors: Sector[] = [];
      for (let r = 1; r <= sectorsPerTrack; r++) {
        sectors.push(
          makeSector(C(c), H(h), R(r), N(1), fillSectorData(c * 100 + h * 10 + r, 256)),
        );
      }
      tracks[c * 2 + h] = { cylinder: C(c), head: H(h), sectors };
    }
  }
  return new D88Disk({
    name: opts.name ?? "TESTDISK",
    mediaType: "2D",
    cylinders,
    writeProtected: opts.writeProtected ?? false,
    tracks,
  });
}

// 6-byte sub-CPU stub program: read incoming PPI byte, increment,
// write back, HALT. Used by every test that exercises the sub-CPU
// IPC round-trip without a real disk-board ROM.
export const SUBCPU_ECHO_PLUS_ONE: u8[] = [0xdb, 0xfd, 0x3c, 0xd3, 0xfc, 0x76];

// PC-88 keyboard matrix for ASCII characters. The PC88Key enum packs
// `row * 8 + col` (per its file-level comment) so divmod-by-8 is the
// authoritative row/col extractor. Sourcing the map from the enum
// keeps the matrix layout single-sourced — adding a key in
// pc88-input.ts is enough to make it typeable here.
const rowCol = (k: PC88Key): readonly [number, number] => [k >> 3, k & 7];

const PC88_KEY_MAP: { readonly [c: string]: readonly [number, number] } = {
  "0": rowCol(PC88Key.NUM_0), "1": rowCol(PC88Key.NUM_1),
  "2": rowCol(PC88Key.NUM_2), "3": rowCol(PC88Key.NUM_3),
  "4": rowCol(PC88Key.NUM_4), "5": rowCol(PC88Key.NUM_5),
  "6": rowCol(PC88Key.NUM_6), "7": rowCol(PC88Key.NUM_7),
  "8": rowCol(PC88Key.NUM_8), "9": rowCol(PC88Key.NUM_9),
  " ": rowCol(PC88Key.SPACE),
  a: rowCol(PC88Key.A), b: rowCol(PC88Key.B), c: rowCol(PC88Key.C),
  d: rowCol(PC88Key.D), e: rowCol(PC88Key.E), f: rowCol(PC88Key.F),
  g: rowCol(PC88Key.G), h: rowCol(PC88Key.H), i: rowCol(PC88Key.I),
  j: rowCol(PC88Key.J), k: rowCol(PC88Key.K), l: rowCol(PC88Key.L),
  m: rowCol(PC88Key.M), n: rowCol(PC88Key.N), o: rowCol(PC88Key.O),
  p: rowCol(PC88Key.P), q: rowCol(PC88Key.Q), r: rowCol(PC88Key.R),
  s: rowCol(PC88Key.S), t: rowCol(PC88Key.T), u: rowCol(PC88Key.U),
  v: rowCol(PC88Key.V), w: rowCol(PC88Key.W), x: rowCol(PC88Key.X),
  y: rowCol(PC88Key.Y), z: rowCol(PC88Key.Z),
  "\r": rowCol(PC88Key.RETURN),
};

const PC88_SHIFT_KEY: readonly [number, number] = rowCol(PC88Key.SHIFT);

// Shifted-character map: PC-88 JIS-style layout puts " on SHIFT+2.
// Extend as more shifted chars are needed by tests.
const PC88_SHIFT_MAP: { readonly [c: string]: readonly [number, number] } = {
  '"': PC88_KEY_MAP["2"]!,
};

// Look up a character's matrix coordinates. Returns the unshifted
// key plus a "needs SHIFT held" flag; the caller drives the SHIFT
// row separately.
export function pc88KeyFor(ch: string): {
  row: number;
  col: number;
  shift: boolean;
} {
  const shifted = PC88_SHIFT_MAP[ch];
  if (shifted) return { row: shifted[0], col: shifted[1], shift: true };
  const k = PC88_KEY_MAP[ch];
  if (!k) throw new Error(`pc88KeyFor: no key map for ${JSON.stringify(ch)}`);
  return { row: k[0], col: k[1], shift: false };
}

export const PC88_SHIFT_ROW_COL = PC88_SHIFT_KEY;

export function formatHMS(time: Seconds): string {
  if (!isFinite(time) || time < 0) return "?";
  const h: Hours = Math.floor(time / 3600);
  const m: Minutes = Math.floor((time % 3600) / 60);
  const s: Seconds = Math.floor(time % 60);
  if (h > 0) return `${h}h${m.toString().padStart(2, "0")}m`;
  if (m > 0) return `${m}m${s.toString().padStart(2, "0")}s`;
  return `${s}s`;
}
