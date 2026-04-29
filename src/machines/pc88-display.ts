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

// PC-8801 mkI TVRAM is laid out at 0xF000-0xFFFF as 25 rows × 160
// bytes: each character cell occupies 2 bytes — even offset = char
// code, odd offset = attribute byte (colour, reverse, blink,
// underline). 25 × 160 = 4000 bytes; the trailing 96 bytes of the
// 4 KB region are CRTC scratch / line-attribute state we don't
// model yet. The earlier "stride 120, 80 chars contiguous" theory
// was wrong (no real hardware lays it out that way); reading the
// attribute byte as a char is what produced the "N E C   P C..."
// pattern with NULs between every visible character.
const ROW_STRIDE = 160;
const CHAR_OFFSET = 0; // char byte at row*160 + col*2
const ATTR_OFFSET = 1; // attr byte at row*160 + col*2 + 1

export class PC88TextDisplay implements PC88Display {
  constructor(private readonly memory: PC88MemoryMap) {}

  getTextFrame(): TextFrame {
    const tvram = this.memory.tvram;
    const chars = new Uint8Array(TEXT_COLS * TEXT_ROWS);
    const attrs = new Uint8Array(TEXT_COLS * TEXT_ROWS);
    for (let row = 0; row < TEXT_ROWS; row++) {
      const rowBase = row * ROW_STRIDE;
      for (let col = 0; col < TEXT_COLS; col++) {
        const cellBase = rowBase + col * 2;
        chars[row * TEXT_COLS + col] = tvram[cellBase + CHAR_OFFSET] ?? 0;
        attrs[row * TEXT_COLS + col] = tvram[cellBase + ATTR_OFFSET] ?? 0;
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
