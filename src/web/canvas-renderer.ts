// Pixel-blit renderer. The emulator worker ships a fully-composited
// RGBA frame each tick (graphics planes + font ROM glyph overlay +
// per-cell attributes from getPixelFrame()); we just putImageData
// it onto a canvas sized to the frame's natural resolution and let
// CSS scale it (image-rendering: pixelated keeps the look crisp).
//
// Replaces the earlier monospace-font text-only path: that path
// bypassed the actual font ROM, ignored graphics, and didn't honour
// reverse / colour attributes. The new pipeline matches what
// `yarn pc88 --screenshot` produces for the CLI.

const DEFAULT_W = 640;
const DEFAULT_H = 200;

export class CanvasPixelRenderer {
  private readonly ctx: CanvasRenderingContext2D;
  private width = 0;
  private height = 0;

  constructor(private readonly canvas: HTMLCanvasElement) {
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("2d canvas context unavailable");
    this.ctx = ctx;
    this.resize(DEFAULT_W, DEFAULT_H);
    this.clear();
  }

  private resize(width: number, height: number): void {
    if (width === this.width && height === this.height) return;
    this.width = width;
    this.height = height;
    this.canvas.width = width;
    this.canvas.height = height;
  }

  private clear(): void {
    this.ctx.fillStyle = "#000";
    this.ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);
  }

  render(pixels: Uint8ClampedArray, width: number, height: number): void {
    if (width === 0 || height === 0 || pixels.length === 0) {
      // Display not yet active. Leave the previous frame visible so
      // the user's first impression of "boot is happening" is the
      // banner appearing rather than a black flash mid-init.
      return;
    }
    this.resize(width, height);
    if (pixels.length !== width * height * 4) return;
    // ImageData's constructor needs Uint8ClampedArray<ArrayBuffer>;
    // when the array came through postMessage its underlying buffer
    // is typed ArrayBufferLike. Re-create the view so the type
    // narrows back to ArrayBuffer.
    const view = new Uint8ClampedArray(pixels.buffer as ArrayBuffer);
    const img = new ImageData(view, width, height);
    this.ctx.putImageData(img, 0, 0);
  }
}
