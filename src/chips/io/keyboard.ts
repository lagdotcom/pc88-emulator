import type { IOBus } from "../../core/IOBus.js";
import type { u8 } from "../../flavours.js";
import { getLogger } from "../../log.js";

const log = getLogger("keyboard");

// PC-88 keyboard matrix scanner. Per MAME's pc8801 driver the keyboard
// occupies CPU I/O ports 0x00..0x0F as 16 read-only "row" ports —
// reading port `0x0n` returns the live state of row `n`. The matrix
// is active-low: a `0` bit means "this column in this row is held";
// idle (no keys held) reads 0xFF.
//
// This isn't a PPI — earlier code conflated it with the sub-CPU's
// 8255 (which lives at 0xFC-0xFF on mkII+). Refactor: separate the
// two. The sub-CPU PPI lives in its own file as `μPD8255` when we
// wire it (matches the μPD3301 / μPD8257 NEC-part-number naming).
//
// We don't model individual key codes yet because no first-light
// boot path needs them; the BIOS samples a few rows during init to
// detect "any key held" / "boot key combination" but only uses
// branches if a key is actually down. Idle 0xFF means "no key held"
// for every row, which is exactly the boot-time state.
//
// `pressKey(row, col)` / `releaseKey(row, col)` is the API a future
// keyboard-input frontend (or test) will drive. row 0..15, col 0..7
// per the PC-88 keyboard matrix layout (see PC-88 Hardware Manual or
// MAME's pc8801_keyboard input definition).
export interface KeyboardSnapshot {
  rows: u8[];
}

export class Keyboard {
  // 16 rows, idle = 0xFF. Mutated by pressKey/releaseKey.
  readonly rows: Uint8Array = new Uint8Array(16).fill(0xff);

  snapshot(): KeyboardSnapshot {
    return { rows: Array.from(this.rows) };
  }

  fromSnapshot(s: KeyboardSnapshot): void {
    for (let i = 0; i < 16; i++) this.rows[i] = s.rows[i] ?? 0xff;
  }

  pressKey(row: number, col: number): void {
    if (row < 0 || row > 15 || col < 0 || col > 7) {
      log.warn(`pressKey out of range: row=${row} col=${col}`);
      return;
    }
    this.rows[row]! &= ~(1 << col);
  }

  releaseKey(row: number, col: number): void {
    if (row < 0 || row > 15 || col < 0 || col > 7) return;
    this.rows[row]! |= 1 << col;
  }

  releaseAll(): void {
    this.rows.fill(0xff);
  }

  register(bus: IOBus): void {
    for (let row = 0; row < 16; row++) {
      bus.register(row, {
        name: `keyboard/row${row}`,
        // Capture row by closure — register() is called once at machine
        // construction so this is fine.
        read: () => this.rows[row]!,
      });
    }
  }
}
