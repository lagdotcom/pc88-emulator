import type { SystemController } from "../chips/io/sysctrl.js";
import type { μPD3301 } from "../chips/io/μPD3301.js";
import type { μPD8257 } from "../chips/io/μPD8257.js";
import type { Chars, Pixels, u16 } from "../flavours.js";
import type { DisplayRegisters } from "./display-regs.js";
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

// PC-88 TVRAM layout per row, per MAME's upd3301_device::dack_w:
//
//   bytes 0..(H-1):              H single-byte chars (1 byte per cell)
//   bytes H..(H + 2*A - 1):      A (column, attr) pairs (2 bytes each)
//   trailing:                    padding up to row stride
//
// where H = `crtc.charsPerRow` (= 80 in PC-8801 BASIC) and A =
// `crtc.attrPairsPerRow` (= up to 20). The BIOS programs DMAC
// channel 2 to stream `H + 2*A` bytes per row (40 attr pairs + 80
// chars = 120 bytes when A=20, matching the observed 0x960 / 20
// rows = 120 bytes/row count).
//
// Each cell is ONE byte. There is no 2-byte interleaved char/attr
// stride. Per-cell attributes are resolved by walking the (column,
// attr) pairs in the trailing area — that's a renderer job we
// don't yet do; for headless TVRAM dumping we just expose the
// chars and an empty attrs array.
//
// N-BASIC stores its banner as "char,0x00,char,0x00,..." which
// looks like a 2-byte cell layout but is actually 80 chars per row
// where every other byte is NUL — wasteful, but correct under
// MAME's model.
//
// The DMAC channel 2 source register tells us where the visible
// region starts inside TVRAM (0xF300 on N-BASIC boot, 0xF3C8 on
// N88-BASIC).
//
// Total bytes per row that we read for layout purposes — H chars
// plus the full 40-byte attr-pair area (20 slots × 2 bytes), which
// the BIOS reserves regardless of how many slots are active.
const ATTR_AREA_BYTES = 40;
// Hex-dump line width for rawTvramDump.
const HEX_DUMP_WIDTH = 16;
// CPU-side base address of TVRAM, shown in the first column of the
// hex dump so addresses match what a Z80 disassembler would print.
const TVRAM_BASE = 0xf000;

// PC-88 digital 8-colour palette. The 3 GVRAM plane bits combine
// into an index 0..7 with plane 0 = blue, plane 1 = red, plane 2 =
// green (so c = (g<<2) | (r<<1) | b). Pre-SR variants are hardwired
// to this; SR+ in analogue-palette mode replaces it with a
// programmable lookup at port 0x54-0x5B.
export const DIGITAL_PALETTE: ReadonlyArray<readonly [number, number, number]> = [
  [0x00, 0x00, 0x00], // 0 black
  [0x00, 0x00, 0xff], // 1 blue
  [0xff, 0x00, 0x00], // 2 red
  [0xff, 0x00, 0xff], // 3 magenta
  [0x00, 0xff, 0x00], // 4 green
  [0x00, 0xff, 0xff], // 5 cyan
  [0xff, 0xff, 0x00], // 6 yellow
  [0xff, 0xff, 0xff], // 7 white
];

export class PC88TextDisplay implements PC88Display {
  constructor(
    private readonly memory: PC88MemoryMap,
    private readonly crtc: μPD3301,
    private readonly dmac: μPD8257,
    private readonly sysctrl: SystemController,
    private readonly displayRegs: DisplayRegisters,
  ) {}

  // Build a TextFrame from the CRTC + DMAC live config: rows / cols
  // come from the CRTC SET MODE block, the start address from DMAC
  // channel 2, and only that contiguous range is laid out. If the
  // CRTC hasn't been programmed yet (boot before BASIC issues SET
  // MODE) returns an empty frame; callers can fall back to
  // rawTvramDump() for diagnostic context.
  getTextFrame(): TextFrame {
    // The CRTC programs charsPerRow as the *byte* count of the cell
    // run (typically 80 for PC-8801 BASIC). The system-register
    // bit COLS_80 then chooses the cell stride: 80-col mode uses
    // 1 byte per cell (= cellRunBytes / 1 = 80 visible cols),
    // 40-col mode uses 2 bytes per cell (= cellRunBytes / 2 = 40
    // visible cols, with the second byte being a per-cell attr).
    const cellRunBytes = this.crtc.charsPerRow || 0;
    const cellSize = this.sysctrl.cols80 ? 1 : 2;
    const cols = (cellRunBytes / cellSize) | 0;
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
    // Per-row stride: char run (cellRunBytes) + the 40-byte
    // attribute-pair area. Matches the DMAC count BASIC programs
    // (0x0960 = 20 × 120) regardless of cell stride.
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
        const cellBase = (rowBase + col * cellSize) & mask;
        chars[row * cols + col] = tvram[cellBase] ?? 0;
        if (cellSize === 2) {
          attrs[row * cols + col] = tvram[(cellBase + 1) & mask] ?? 0;
        }
      }
    }
    return { chars, attrs, cursor: null, cols, rows };
  }

  // 640x200 frame composited from the three 16 KB GVRAM planes. Each
  // GVRAM plane stores one bit per pixel (MSB-first within a byte);
  // the three plane bits combine into a 0..7 colour index that maps
  // through the 8-colour digital palette below. Pixels where no plane
  // bit is set fall through to the bgColor latched at port 0x52.
  //
  // Layer mask honoured: a plane whose `showGVRAMn` is false is read
  // as all zeros (effectively hidden). Analogue palette (SR+ via
  // PMODE bit) and 400-line mode (V2) aren't covered yet — both
  // produce different bytes-per-row layouts.
  getPixelFrame(): PixelFrame | null {
    const width = (640 as Pixels);
    const height = (200 as Pixels);
    const bytesPerRow = 80;
    const planes = this.memory.gvram;
    const showG0 = this.displayRegs.showGVRAM0;
    const showG1 = this.displayRegs.showGVRAM1;
    const showG2 = this.displayRegs.showGVRAM2;
    const bgRgb = DIGITAL_PALETTE[this.displayRegs.bgColor & 0x07]!;
    const rgba = new Uint8ClampedArray(width * height * 4);

    for (let y = 0; y < height; y++) {
      const rowOff = y * bytesPerRow;
      for (let xByte = 0; xByte < bytesPerRow; xByte++) {
        const off = rowOff + xByte;
        const b0 = showG0 ? planes[0]![off]! : 0;
        const b1 = showG1 ? planes[1]![off]! : 0;
        const b2 = showG2 ? planes[2]![off]! : 0;
        for (let bit = 0; bit < 8; bit++) {
          const mask = 0x80 >> bit;
          const idx =
            ((b0 & mask) ? 1 : 0) |
            ((b1 & mask) ? 2 : 0) |
            ((b2 & mask) ? 4 : 0);
          const rgb = idx === 0 ? bgRgb : DIGITAL_PALETTE[idx]!;
          const i = (y * width + xByte * 8 + bit) * 4;
          rgba[i] = rgb[0];
          rgba[i + 1] = rgb[1];
          rgba[i + 2] = rgb[2];
          rgba[i + 3] = 255;
        }
      }
    }
    return { width, height, rgba };
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
