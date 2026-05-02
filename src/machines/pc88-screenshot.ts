import { PNG } from "pngjs";

import type { PixelFrame } from "./pc88-display.js";

// PNG encoder for PixelFrame. Lives in a Node-only file because
// pngjs uses node:zlib under the hood — pulling it into
// pc88-display.ts would break the web bundle (the canvas renderer
// goes through `putImageData` directly and doesn't need an
// encoder). The CLI's `--screenshot=PATH` flag and the test that
// round-trips a frame are the only callers.
export function pixelFrameToPNG(frame: PixelFrame): Uint8Array {
  const png = new PNG({ width: frame.width, height: frame.height });
  // pngjs's `data` is RGBA in the same shape as PixelFrame.rgba —
  // a direct copy preserves the alpha lane (always 0xFF here).
  png.data = Buffer.from(
    frame.rgba.buffer,
    frame.rgba.byteOffset,
    frame.rgba.byteLength,
  );
  return PNG.sync.write(png);
}
