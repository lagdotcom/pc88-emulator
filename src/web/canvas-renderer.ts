// Canvas-driven text-mode renderer. The emulator worker ships
// `chars` (cols * rows bytes from the CRTC-configured text frame)
// every tick; we paint each cell with the platform's monospace
// font scaled to fit an 8×16 logical cell.
//
// A future CG/kanji-ROM glyph atlas would replace this so katakana
// and the box-drawing range render correctly; for now the JIS X
// 0201 lower half (0x20-0x7E) overlaps ASCII, so native font
// rendering is good enough to read banners and BASIC prompts.

const CELL_W = 8;
const CELL_H = 16;
// 80×20 in BASIC mode; track this here so an unprogrammed CRTC (which
// reports cols=rows=0 on boot before SET MODE) still has a sensible
// canvas to draw on.
const DEFAULT_COLS = 80;
const DEFAULT_ROWS = 20;

const FG = "#4ade80";
const BG = "#000";

export class CanvasTextRenderer {
  private readonly ctx: CanvasRenderingContext2D;
  private cols = 0;
  private rows = 0;

  constructor(private readonly canvas: HTMLCanvasElement) {
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("2d canvas context unavailable");
    this.ctx = ctx;
    this.resize(DEFAULT_COLS, DEFAULT_ROWS);
    this.clear();
  }

  private resize(cols: number, rows: number): void {
    if (cols === this.cols && rows === this.rows) return;
    this.cols = cols;
    this.rows = rows;
    this.canvas.width = cols * CELL_W;
    this.canvas.height = rows * CELL_H;
    // CSS scaling lives in app.css (image-rendering: pixelated +
    // explicit width). Re-apply font after resize because some
    // browsers reset context state.
    this.ctx.font = `${CELL_H}px ui-monospace, Menlo, Consolas, monospace`;
    this.ctx.textBaseline = "top";
  }

  private clear(): void {
    this.ctx.fillStyle = BG;
    this.ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);
  }

  render(chars: Uint8Array, cols: number, rows: number): void {
    if (cols === 0 || rows === 0) {
      // CRTC not yet programmed. Leave the previous frame visible
      // rather than clearing — the user's first impression of "boot
      // is happening" comes from BASIC's banner appearing, not from
      // a black canvas mid-init.
      return;
    }
    this.resize(cols, rows);
    this.clear();
    this.ctx.fillStyle = FG;
    for (let r = 0; r < rows; r++) {
      // Build the row as a single string and draw with one fillText
      // call. Per-cell fillText would be 60 × 80 × 20 = 96k calls/sec;
      // per-row drops that to 1200 calls/sec while still rendering
      // monospace cells aligned to the 8-pixel grid.
      let line = "";
      for (let c = 0; c < cols; c++) {
        const ch = chars[r * cols + c] ?? 0;
        if (ch >= 0x20 && ch < 0x7f) line += String.fromCharCode(ch);
        else if (ch === 0) line += " ";
        else line += ".";
      }
      this.ctx.fillText(line, 0, r * CELL_H);
    }
  }
}
