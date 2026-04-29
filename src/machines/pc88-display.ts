import type { μPD3301 } from "../chips/io/μPD3301.js";
import type { μPD8257 } from "../chips/io/μPD8257.js";
import type { PC88MemoryMap } from "./pc88-memory.js";

// Maximum text-mode geometry the mkI CRTC can be programmed to.
// These are the upper-bound buffer dimensions; the actual visible
// rows/cols come from the live CRTC SET MODE state at frame time.
export const TEXT_COLS = 80;
export const TEXT_ROWS = 25;

export interface TextFrame {
  readonly chars: Uint8Array; // length cols * rows
  readonly attrs: Uint8Array; // same shape; attribute bytes from TVRAM
  readonly cursor: { row: number; col: number } | null;
  readonly cols: number;
  readonly rows: number;
}

export interface PixelFrame {
  readonly width: number;
  readonly height: number;
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
  toAsciiDump(): string;
  // Raw whole-TVRAM dump for debugging — ignores CRTC + DMAC config
  // and lays out 25 × 80 cells across the entire 4 KB region. Useful
  // for "what's the BIOS scribbling outside the visible area?".
  rawTvramDump(): string;
}

// PC-8801 mkI TVRAM layout per row, confirmed empirically against the
// DMAC channel 2 byte count BASIC programs (0x0960 = 2400 = 20 rows ×
// 120 bytes):
//   bytes 0..79     : N character codes, contiguous
//   bytes 80..119   : 20 attribute pair slots × 2 bytes (column, attr)
// The actual stride per row equals chars-per-row + 2 × attribute-area
// pairs (40 bytes when the CRTC's attribute area is reserved at full
// size, regardless of the "active pairs" sub-count). We compute it
// from the CRTC SET MODE state at frame time.
//
// The DMAC channel 2 source register tells us where the visible
// region starts inside TVRAM (0xF300 on N-BASIC boot, not 0xF000).
// Earlier versions of this file modelled char + attribute as
// interleaved 2-byte cells (160-byte stride); that was wrong, the
// confusion came from misreading attribute bytes as chars in the raw
// dump.
//
// Default layout used by rawTvramDump (the diagnostic view, when the
// CRTC hasn't been programmed): 25 rows × 120-byte stride, 80 chars
// per row contiguous. Independent of live CRTC config so it doesn't
// disappear when the CRTC is reset.
const RAW_ROW_STRIDE = 120;
const RAW_CHARS_PER_ROW = 80;
// Number of attribute-pair slots reserved per row in the default
// layout (each slot is 2 bytes: column + attribute).
const DEFAULT_ATTR_AREA_BYTES = 40;

export class PC88TextDisplay implements PC88Display {
  constructor(
    private readonly memory: PC88MemoryMap,
    private readonly crtc: μPD3301,
    private readonly dmac: μPD8257,
  ) {}

  // Build a TextFrame from the CRTC + DMAC live config: rows / cols
  // come from the CRTC SET MODE block, the start address from DMAC
  // channel 2, and only that contiguous range is laid out. If the
  // CRTC hasn't been programmed yet (boot before BASIC issues SET
  // MODE) returns an empty frame; callers can fall back to
  // rawTvramDump() for diagnostic context.
  getTextFrame(): TextFrame {
    const cols = this.crtc.charsPerRow || 0;
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
    // Per-row stride: N chars contiguous, followed by the attribute
    // pair area. The CRTC always reserves space for 20 pair slots
    // (40 bytes) on PC-88; attrPairsPerRow is just how many of them
    // are "active" pairs, not the area size. This matches the DMAC
    // count BASIC actually programs (2400 / 20 rows = 120).
    const stride = cols + DEFAULT_ATTR_AREA_BYTES;
    // DMAC ch 2 source is the absolute CPU-side address of the first
    // byte. TVRAM lives at 0xF000; subtracting gives the offset into
    // the 4 KB array. If DMAC isn't programmed (returns 0), assume
    // the start of TVRAM — that's where the BIOS lays the screen
    // before reprogramming.
    const dmaSrc = this.dmac.channelAddress(2);
    const tvramOrigin = dmaSrc >= 0xf000 ? dmaSrc - 0xf000 : 0;
    const tvram = this.memory.tvram;
    const chars = new Uint8Array(cols * rows);
    const attrs = new Uint8Array(cols * rows);
    for (let row = 0; row < rows; row++) {
      const rowBase = (tvramOrigin + row * stride) & (tvram.length - 1);
      for (let col = 0; col < cols; col++) {
        chars[row * cols + col] = tvram[(rowBase + col) & (tvram.length - 1)] ?? 0;
      }
      // Attribute pair area starts after the char run. We don't
      // resolve pairs to per-cell attributes yet — that's a renderer
      // job — but capture the raw bytes so the renderer has them.
      for (let col = 0; col < cols && col < DEFAULT_ATTR_AREA_BYTES; col++) {
        attrs[row * cols + col] =
          tvram[(rowBase + cols + col) & (tvram.length - 1)] ?? 0;
      }
    }
    return { chars, attrs, cursor: null, cols, rows };
  }

  getPixelFrame(): PixelFrame | null {
    return null;
  }

  toAsciiDump(): string {
    const frame = this.getTextFrame();
    if (frame.cols === 0 || frame.rows === 0) {
      return "(CRTC not yet programmed; use rawTvramDump for diagnostic view)";
    }
    return formatGrid(frame.chars, frame.cols, frame.rows);
  }

  rawTvramDump(): string {
    const tvram = this.memory.tvram;
    const chars = new Uint8Array(RAW_CHARS_PER_ROW * TEXT_ROWS);
    for (let row = 0; row < TEXT_ROWS; row++) {
      const rowBase = row * RAW_ROW_STRIDE;
      for (let col = 0; col < RAW_CHARS_PER_ROW; col++) {
        chars[row * RAW_CHARS_PER_ROW + col] = tvram[rowBase + col] ?? 0;
      }
    }
    return formatGrid(chars, RAW_CHARS_PER_ROW, TEXT_ROWS);
  }
}

function formatGrid(chars: Uint8Array, cols: number, rows: number): string {
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
