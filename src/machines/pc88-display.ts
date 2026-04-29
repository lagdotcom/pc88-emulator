import type { PC88MemoryMap } from "./pc88-memory.js";

// 80×25 text mode is the only one used at boot; later video modes
// (40×25, 80×20 graphics overlay, etc.) get switched on via the CRTC.
// We hard-wire 80×25 here because that's what the BASIC banner lives
// in.
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
  // 25 × 80 text grid pulled from TVRAM. Available now.
  getTextFrame(): TextFrame;
  // Future: pixel framebuffer for graphics planes + text overlay.
  // Returns null until the graphics-rendering branch lands so
  // downstream callers can adopt the API today.
  getPixelFrame(): PixelFrame | null;
  // Convenience: text frame projected to a printable string with row
  // breaks. Used by the CLI runner and the synthetic-ROM tests.
  toAsciiDump(): string;
}

// PC-88 TVRAM at 0xF000–0xFFFF is laid out as 25 rows × 120 bytes:
// the first 80 bytes of each row are character codes, followed by 40
// bytes of attribute information that doesn't quite map cell-by-cell.
// For first-light we just read the character half; attributes come
// across as zeroes until a renderer needs them.
const ROW_STRIDE = 40;
const CHARS_PER_ROW = 40;

export class PC88TextDisplay implements PC88Display {
  constructor(private readonly memory: PC88MemoryMap) {}

  getTextFrame(): TextFrame {
    const tvram = this.memory.tvram;
    const chars = new Uint8Array(TEXT_COLS * TEXT_ROWS);
    const attrs = new Uint8Array(TEXT_COLS * TEXT_ROWS);
    for (let row = 0; row < TEXT_ROWS; row++) {
      const rowBase = row * ROW_STRIDE;
      for (let col = 0; col < CHARS_PER_ROW; col++) {
        chars[row * TEXT_COLS + col] = tvram[rowBase + col] ?? 0;
      }
    }
    return {
      chars,
      attrs,
      cursor: null,
      cols: TEXT_COLS,
      rows: TEXT_ROWS,
    };
  }

  getPixelFrame(): PixelFrame | null {
    return null;
  }

  toAsciiDump(): string {
    const frame = this.getTextFrame();
    const lines: string[] = [];
    for (let row = 0; row < frame.rows; row++) {
      let line = "";
      for (let col = 0; col < frame.cols; col++) {
        const ch = frame.chars[row * frame.cols + col]!;
        // PC-88 text mode uses JIS X 0201 in the lower half; 0x20-0x7E
        // overlap ASCII directly. Treat anything outside that range as
        // a "·" placeholder so the dump stays printable. Real katakana
        // / kanji rendering belongs to a later font-rom branch.
        if (ch >= 0x20 && ch < 0x7f) line += String.fromCharCode(ch);
        else if (ch === 0) line += " ";
        else line += "·";
      }
      lines.push(line.replace(/\s+$/, ""));
    }
    return lines.join("\n");
  }
}
