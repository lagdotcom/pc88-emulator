import type { SystemController } from "../chips/io/sysctrl.js";
import type { μPD3301 } from "../chips/io/μPD3301.js";
import type { μPD8257 } from "../chips/io/μPD8257.js";
import type { Chars, Pixels, u16 } from "../flavours.js";
import type { DisplayRegisters } from "./display-regs.js";
import type { PC88MemoryMap } from "./pc88-memory.js";

export interface TextFrame {
  readonly chars: Uint8Array; // length cols * rows
  // Per-cell packed attribute, computed by walking the row's
  // attribute-pair area: high byte = colour state, low byte =
  // decoration state. See ATTR_* constants below for the bit
  // layout. Default at row start is 0xE800 (white text, no
  // decoration). Length matches `chars`.
  readonly attrs: Uint16Array;
  readonly cursor: { row: Chars; col: Chars } | null;
  readonly cols: Chars;
  readonly rows: Chars;
}

// Text-attribute bit positions in the 16-bit packed attr (high byte
// = colour state, low byte = decoration state). Each attribute byte
// the BIOS writes to the (col, attr) pair area is *either* a colour
// update (bit 3 set: bits 7-5 carry RGB) *or* a decoration update
// (bit 3 clear: bits 5/4/2/1/0 carry flags). The CRTC tracks both
// and combines them per cell. Cross-reference: MAME pc8001.cpp
// draw_text + attr_fetch.
export const ATTR = {
  // Colour state (high byte).
  FG_SHIFT: 13, // (attr >> 13) & 7 → colour 0..7 → DIGITAL_PALETTE
  FG_MASK: 0x7 << 13,
  SEMIGFX: 1 << 12, // semi-graphic char (glyph from TVRAM bits, not font)
  // Decoration state (low byte).
  LOWERLINE: 1 << 5,
  UPPERLINE: 1 << 4,
  REVERSE: 1 << 2,
  BLINK: 1 << 1,
  SECRET: 1 << 0,
  // Default at row start: colour=0xE8 (white + colour-marker), decoration=0x00.
  DEFAULT: (0xe8 << 8) | 0x00,
  // Bit-3 of an incoming attribute byte selects which state to
  // update: set = colour byte, clear = decoration byte.
  TYPE_COLOUR: 1 << 3,
} as const;

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
    // 256-glyph 8x8 font ROM (`char_code * 8` row layout, MSB =
    // leftmost). When loaded, getPixelFrame() overlays text on top
    // of the GVRAM composite. Pass null for graphics-only.
    private readonly fontRom: Uint8Array | null = null,
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
        attrs: new Uint16Array(0),
        cursor: null,
        cols: 0,
        rows: 0,
      };
    }
    // Per-row stride: char run (cellRunBytes) + the 40-byte
    // attribute-pair area. Matches the DMAC count BASIC programs
    // (0x0960 = 20 × 120) regardless of cell stride.
    const stride = cellRunBytes + ATTR_AREA_BYTES;
    const attrPairsPerRow = ATTR_AREA_BYTES >> 1; // 20 (col, attr) pairs.
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
    const attrs = new Uint16Array(cols * rows);
    // Scratch column→attr-byte lookup, reused per row.
    const colToAttr = new Int16Array(cellRunBytes); // -1 = no pair lands here.
    for (let row = 0; row < rows; row++) {
      const rowBase = (tvramOrigin + row * stride) & mask;
      // Walk the attribute-pair area: 20 (col, attr) tuples sitting
      // at offset cellRunBytes within the row. Last pair targeting
      // a given column wins. Pairs whose col is >= cellRunBytes are
      // ignored — the BIOS occasionally fills empty slots with high
      // column numbers instead of zero.
      colToAttr.fill(-1);
      const pairBase = rowBase + cellRunBytes;
      for (let p = 0; p < attrPairsPerRow; p++) {
        const c = tvram[(pairBase + p * 2) & mask]!;
        const a = tvram[(pairBase + p * 2 + 1) & mask]!;
        if (c < cellRunBytes) colToAttr[c] = a;
      }
      // Scan the cell-run columns left-to-right, applying any pair
      // that lands at this column to update the running colour or
      // decoration state. Each visible cell snapshots the current
      // 16-bit packed state.
      let colourState = (ATTR.DEFAULT >> 8) & 0xff;
      let decorationState = ATTR.DEFAULT & 0xff;
      for (let bc = 0; bc < cellRunBytes; bc++) {
        const a = colToAttr[bc]!;
        if (a >= 0) {
          if (a & ATTR.TYPE_COLOUR) colourState = a;
          else decorationState = a;
        }
        // Snapshot only at visible-cell positions: every byte in
        // 80-col mode (cellSize=1), every other byte in 40-col mode
        // (cellSize=2; chars at even, attr-pair area still tracked
        // per byte column so per-line state changes line up with
        // the byte run the BIOS programmed).
        if (bc % cellSize !== 0) continue;
        const visibleCol = bc / cellSize;
        const cellBase = (rowBase + bc) & mask;
        chars[row * cols + visibleCol] = tvram[cellBase] ?? 0;
        attrs[row * cols + visibleCol] =
          ((colourState << 8) | decorationState) & 0xffff;
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
    if (this.fontRom && this.fontRom.length >= 256 * 8) {
      this.overlayText(rgba, width, height);
    }
    return { width, height, rgba };
  }

  // Overlay text glyphs from `fontRom` on top of an RGBA frame. Each
  // glyph is 8x8 (256 chars × 8 bytes); cell width and height are
  // derived from the CRTC's programmed cols/rows. Per-cell attributes
  // come from `frame.attrs` (16-bit packed: colour byte at high,
  // decoration at low). Honours:
  //   - fg colour (bits 15-13 → DIGITAL_PALETTE)
  //   - reverse video (swap fg/bg within the cell box)
  //   - secret/hidden (skip the cell entirely)
  //   - blink (rendered as solid fg in headless capture — no time
  //     component is available; UI renderers should re-blink visually)
  // TODO: upper/lower line + semi-graphics. Cell widths > 8 (40-col
  // mode) double the glyph horizontally; cell heights > 8 leave the
  // bottom rows of the cell blank.
  private overlayText(
    rgba: Uint8ClampedArray,
    width: number,
    height: number,
  ): void {
    const text = this.getTextFrame();
    if (text.cols === 0 || text.rows === 0) return;
    const cellW = (width / text.cols) | 0;
    const cellH = (height / text.rows) | 0;
    if (cellW <= 0 || cellH <= 0) return;
    const stretchX = cellW / 8;
    const font = this.fontRom!;
    const cellBgRgb = DIGITAL_PALETTE[this.displayRegs.bgColor & 0x07]!;

    const setPixel = (x: number, y: number, rgb: readonly [number, number, number]) => {
      const i = (y * width + x) * 4;
      rgba[i] = rgb[0];
      rgba[i + 1] = rgb[1];
      rgba[i + 2] = rgb[2];
    };

    for (let row = 0; row < text.rows; row++) {
      for (let col = 0; col < text.cols; col++) {
        const cellIdx = row * text.cols + col;
        const ch = text.chars[cellIdx]!;
        const attr = text.attrs[cellIdx]!;
        if (attr & ATTR.SECRET) continue;
        const fgIdx = (attr >> ATTR.FG_SHIFT) & 0x07;
        const reverse = (attr & ATTR.REVERSE) !== 0;
        const fgRgb = DIGITAL_PALETTE[fgIdx]!;
        const onRgb = reverse ? cellBgRgb : fgRgb;
        const offRgb = reverse ? fgRgb : null;
        // Reverse video paints the whole cell box in fg first; the
        // glyph then knocks out bg-coloured pixels on top. Without
        // reverse the glyph just adds fg pixels and leaves the
        // underlying graphics layer visible elsewhere.
        if (offRgb) {
          for (let py = 0; py < cellH; py++) {
            const y = row * cellH + py;
            for (let px = 0; px < cellW; px++) {
              setPixel(col * cellW + px, y, offRgb);
            }
          }
        }
        if (ch === 0) continue;
        const glyphBase = ch * 8;
        for (let py = 0; py < 8 && py < cellH; py++) {
          const glyphRow = font[glyphBase + py]!;
          if (glyphRow === 0) continue;
          const y = row * cellH + py;
          for (let gx = 0; gx < 8; gx++) {
            if ((glyphRow & (0x80 >> gx)) === 0) continue;
            const xStart = (col * cellW + gx * stretchX) | 0;
            const xEnd = (col * cellW + (gx + 1) * stretchX) | 0;
            for (let x = xStart; x < xEnd; x++) setPixel(x, y, onRgb);
          }
        }
      }
    }
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

// PNG encoding lives in src/machines/pc88-screenshot.ts (Node-only,
// uses node:zlib). Pulling that here would break the web bundle —
// pc88-display.ts is shared with the browser worker.
