import logLib from "log";

import type { u8 } from "../../flavours.js";
import type { IOBus } from "../../core/IOBus.js";

const log = logLib.get("irq");

// PC-88 maskable-interrupt control. Two registers:
//   0xE4  priority/level — selects interrupt source priority
//   0xE6  mask            — per-bit enable (1 = source can fire)
//
// Bit assignments on 0xE6 (per NEC mkII technical manual; mkI honours
// the same layout for the bits it has):
//   bit 0 — VBL          (this is the only one wired this branch)
//   bit 1 — RxRdy USART
//   bit 2 — RTC tick
//   bit 3 — TxRdy USART
//   bit 4 — disk/sub-CPU
//   bits 5-7 — reserved / model-specific
//
// Reset state: real silicon comes up with the mask register cleared
// (all interrupts disabled) and BASIC ROM enables what it needs. We
// default to "all enabled" because that matches what the existing
// pc88-irq test expects, and the BIOS overwrites the mask with its
// own value within the first few hundred ops anyway.
export class IrqController {
  mask: u8 = 0xff;
  priority: u8 = 0xff;
  // Set to true when the BIOS has explicitly programmed the mask. Used
  // by diagnostics to distinguish "default still in force" from
  // "ROM said all sources enabled".
  programmed = false;

  vblMasked(): boolean {
    return (this.mask & 0x01) === 0;
  }

  register(bus: IOBus): void {
    bus.register(0xe4, {
      name: "irq/priority",
      read: () => this.priority,
      write: (_p, v) => {
        this.priority = v;
        log.debug(`priority := 0x${v.toString(16)}`);
      },
    });
    bus.register(0xe6, {
      name: "irq/mask",
      read: () => this.mask,
      write: (_p, v) => {
        this.mask = v;
        this.programmed = true;
        log.debug(`mask := 0x${v.toString(16)}`);
      },
    });
  }
}
