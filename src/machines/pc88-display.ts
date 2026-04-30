import type { μPD3301 } from "../chips/io/μPD3301.js";
import type { μPD8257 } from "../chips/io/μPD8257.js";
import type { Chars, Pixels, u16 } from "../flavours.js";
import type { PC88Graphics } from "./pc88-graphics.js";
import type { PC88MemoryMap } from "./pc88-memory.js";

export interface TextFrame {
  readonly chars: Uint8Array; // length cols * rows
  readonly attrs: Uint8Array; // same shape; attribute bytes from TVRAM
  readonly cursor: { row: Chars; col: Chars } | null;
  readonly cols: Chars;
  readonly rows: Chars;
}

export interface PixelFrame {
  readonly width: Pixels;
  readonly height: Pixels;
  readonly rgba: Uint8ClampedArray;
}

export interface PC88Display {
  // Text grid the CRTC + DMAC are configured to display. Available now.
  getTextFrame(): TextFrame;
  // Future: pixel framebuffer for graphics planes + text overlay.
  // Returns null until the graphics-rendering branch lands so
  // downstream callers can adopt the API today.
  getPixelFrame(): PixelFrame | null;
  // Convenience: text frame projected to a printable string with row
  // breaks. Used by the CLI runner and the synthetic-ROM tests.
  toASCIIDump(): string;
  // Raw whole-TVRAM dump for debugging — ignores CRTC + DMAC config
  // and emits a classic hex+ASCII dump (16 bytes per line, 256
  // lines for the full 4 KB region) addressed in absolute CPU
  // memory (so 0xF000 is row 0). Useful for spotting what the BIOS
  // is using TVRAM for outside the visible area.
  rawTVRAMDump(): string;
}

// PC-8801 mkI TVRAM layout per row, confirmed empirically against
// the DMAC channel 2 byte count BASIC programs (0x0960 = 2400 = 20
// rows × 120 bytes) and the location of "BASIC" in TVRAM (chars at
// even offsets, attrs at odd):
//
//   bytes  0..79  : 40 visible cells × 2 bytes (char + attribute)
//   bytes 80..119 : 20 attribute pair slots × 2 bytes (column, attr)
//
// PC-88 always uses "attribute mode" where each visible cell is
// stored as a (char, attribute) pair at consecutive byte offsets.
// The CRTC's `chars-per-row` parameter is the *byte length* of the
// cell run, so visible-cells = charsPerRow / 2. The trailing
// attribute-pair area gives skip-zone attribute changes within a
// row (for runs of cells that share the same colour/etc.); we
// don't resolve those to per-cell attributes yet — that's a
// renderer job.
//
// The DMAC channel 2 source register tells us where the visible
// region starts inside TVRAM (0xF300 on N-BASIC boot, not 0xF000).
const CELL_BYTES = 2;
const ATTR_OFFSET = 1;
// Number of attribute-pair-area bytes per row (independent of how
// many of those pairs are actually "active" — the BIOS reserves
// the whole area regardless).
const ATTR_AREA_BYTES = 40;
// Hex-dump line width for rawTvramDump.
const HEX_DUMP_WIDTH = 16;
// CPU-side base address of TVRAM, shown in the first column of the
// hex dump so addresses match what a Z80 disassembler would print.
const TVRAM_BASE = 0xf000;

export class PC88TextDisplay implements PC88Display {
  constructor(
    private readonly memory: PC88MemoryMap,
    private readonly crtc: μPD3301,
    private readonly dmac: μPD8257,
    private readonly gfx: PC88Graphics,
  ) {}

  // Build a TextFrame from the CRTC + DMAC live config: rows / cols
  // come from the CRTC SET MODE block, the start address from DMAC
  // channel 2, and only that contiguous range is laid out. If the
  // CRTC hasn't been programmed yet (boot before BASIC issues SET
  // MODE) returns an empty frame; callers can fall back to
  // rawTvramDump() for diagnostic context.
  getTextFrame(): TextFrame {
    // CRTC charsPerRow is the *byte length* of the cell run per row;
    // each visible cell is 2 bytes (char + attribute). Halve it.
    const cellRunBytes = this.crtc.charsPerRow || 0;
    const cols = cellRunBytes >> 1;
    const rows = this.crtc.rowsPerScreen || 0;
    if (cols === 0 || rows === 0) {
      return {
        chars: new Uint8Array(0),
        attrs: new Uint8Array(0),
        cursor: null,
        cols: 0,
        rows: 0,
      };
    }
    // Per-row stride: cell-run bytes + the trailing 40-byte
    // attribute-pair area. This matches the DMAC count BASIC
    // programs (2400 / 20 rows = 120 bytes/row).
    const stride = cellRunBytes + ATTR_AREA_BYTES;
    // DMAC ch 2 source is the absolute CPU-side address of the first
    // byte. TVRAM lives at 0xF000; subtracting gives the offset into
    // the 4 KB array. If DMAC isn't programmed (returns 0), assume
    // the start of TVRAM — that's where the BIOS lays the screen
    // before reprogramming.
    const dmaSrc = this.dmac.channelAddress(2);
    const tvramOrigin = dmaSrc >= 0xf000 ? dmaSrc - 0xf000 : 0;
    const tvram = this.memory.tvram;
    const mask = tvram.length - 1;
    const chars = new Uint8Array(cols * rows);
    const attrs = new Uint8Array(cols * rows);
    for (let row = 0; row < rows; row++) {
      const rowBase = (tvramOrigin + row * stride) & mask;
      for (let col = 0; col < cols; col++) {
        const cellBase = (rowBase + col * CELL_BYTES) & mask;
        chars[row * cols + col] = tvram[cellBase] ?? 0;
        attrs[row * cols + col] = tvram[(cellBase + ATTR_OFFSET) & mask] ?? 0;
      }
    }
    return { chars, attrs, cursor: null, cols, rows };
  }

  getPixelFrame(): PixelFrame | null {
    return null;
  }

  toASCIIDump(): string {
    const frame = this.getTextFrame();
    if (frame.cols === 0 || frame.rows === 0) {
      return "(CRTC not yet programmed; use rawTvramDump for diagnostic view)";
    }
    return formatGrid(frame.chars, frame.cols, frame.rows);
  }

  rawTVRAMDump(): string {
    return hexDump(this.memory.tvram, TVRAM_BASE);
  }
}

// Classic hex+ASCII dump. Each line is:
//   AAAA  bb bb bb bb bb bb bb bb  bb bb bb bb bb bb bb bb  cccccccccccccccc
// where AAAA is the absolute address (CPU-side, with `base` added),
// 16 bytes are shown in two 8-byte groups, and the ASCII column
// renders printable bytes as-is and non-printables as ".".
function hexDump(bytes: Uint8Array, base: u16): string {
  const lines: string[] = [];
  for (let off = 0; off < bytes.length; off += HEX_DUMP_WIDTH) {
    const addr = (base + off).toString(16).padStart(4, "0");
    let hex = "";
    let ascii = "";
    for (let i = 0; i < HEX_DUMP_WIDTH; i++) {
      const b = bytes[off + i] ?? 0;
      hex += b.toString(16).padStart(2, "0");
      hex += i === 7 ? "  " : i === HEX_DUMP_WIDTH - 1 ? "" : " ";
      ascii += b >= 0x20 && b < 0x7f ? String.fromCharCode(b) : ".";
    }
    lines.push(`${addr}  ${hex}  ${ascii}`);
  }
  return lines.join("\n");
}

function formatGrid(chars: Uint8Array, cols: Chars, rows: Chars): string {
  const lines: string[] = [];
  for (let row = 0; row < rows; row++) {
    let line = "";
    for (let col = 0; col < cols; col++) {
      const ch = chars[row * cols + col]!;
      // PC-88 text mode uses JIS X 0201 in the lower half; 0x20-0x7E
      // overlap ASCII directly. Treat anything outside that range as
      // a "·" placeholder so the dump stays printable. Real katakana /
      // kanji rendering belongs to a later font-rom branch.
      if (ch >= 0x20 && ch < 0x7f) line += String.fromCharCode(ch);
      else if (ch === 0) line += " ";
      else line += "·";
    }
    lines.push(line.replace(/\s+$/, ""));
  }
  return lines.join("\n");
}
