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

// PC-88 keyboard matrix for ASCII characters. Coordinates derived
// from `PC88Key` (`row * 8 + col`, counting from `NUMPAD_0 = 0`):
//   row 1 — RETURN at col 7
//   row 2 — AT, A..G        (A at col 1)
//   row 3 — H..O            (H at col 0)
//   row 4 — P..W            (P at col 0)
//   row 5 — X..Z + symbols
//   row 6 — NUM_0..NUM_7
//   row 7 — NUM_8/9 + ; , . / _ :
//   row 8 — modifiers       (SHIFT at col 6, CTRL at col 7)
//   row 9 — STOP, F1..F5, SPACE (col 6), ESC
const PC88_KEY_MAP: { readonly [c: string]: readonly [number, number] } = {
  "0": [6, 0], "1": [6, 1], "2": [6, 2], "3": [6, 3],
  "4": [6, 4], "5": [6, 5], "6": [6, 6], "7": [6, 7],
  "8": [7, 0], "9": [7, 1],
  " ": [9, 6],
  a: [2, 1], b: [2, 2], c: [2, 3], d: [2, 4], e: [2, 5], f: [2, 6], g: [2, 7],
  h: [3, 0], i: [3, 1], j: [3, 2], k: [3, 3], l: [3, 4], m: [3, 5], n: [3, 6], o: [3, 7],
  p: [4, 0], q: [4, 1], r: [4, 2], s: [4, 3], t: [4, 4], u: [4, 5], v: [4, 6], w: [4, 7],
  x: [5, 0], y: [5, 1], z: [5, 2],
  "\r": [1, 7],
};

const PC88_SHIFT_KEY: readonly [number, number] = [8, 6];

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
