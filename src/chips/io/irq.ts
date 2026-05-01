import logLib from "log";

import type { IOBus } from "../../core/IOBus.js";
import type { u8 } from "../../flavours.js";

const log = logLib.get("irq");

// PC-88 maskable-interrupt control. Two registers:
//   0xE4  priority/level — selects interrupt source priority
//   0xE6  mask            — per-bit enable (1 = source can fire)
//
// Bit assignments on 0xE6 (per NEC mkII technical manual, MAME's
// pc8801.cpp `irq_mask_w`, and the μPD8214 priority-encoder wiring;
// mkI honours the same layout for the bits it has):
//   bit 0 — RTC tick     (priority 0 → IM 2 vector 0x00)
//   bit 1 — SOUND        (priority 1 → IM 2 vector 0x02; OPN/OPNA on SR+)
//   bit 2 — VBL          (priority 2 → IM 2 vector 0x04)
//   bit 3 — USART RxRdy  (priority 3 → IM 2 vector 0x06)
//   bit 4 — USART TxRdy  (priority 4 → IM 2 vector 0x08; "AUX/DISK" on later models)
//   bits 5-7 — reserved / model-specific
//
// N88-BASIC programs mask=0x03 early (RTC + SOUND only) and only
// enables VBL after it has populated the IM 2 jump table at I:0x00 —
// running the previous "bit 0 = VBL" wiring caused VBL pulses to be
// accepted while the table was still zeroed, jumping to 0x0000 and
// soft-resetting mid-banner.
//
// Reset state: real silicon comes up with the mask register cleared
// (all interrupts disabled) and BASIC ROM enables what it needs. We
// default to "all enabled" because that matches what the existing
// pc88-irq test expects, and the BIOS overwrites the mask with its
// own value within the first few hundred ops anyway.

// Per-bit enables for the mask register at 0xE6. A bit set to 1
// means that source can fire; cleared means masked.
export const IRQ_MASK = {
  RTC: 1 << 0, // 600 Hz real-time-clock tick
  SOUND: 1 << 1, // OPN / OPNA timer (SR+; idle on mkI)
  VBL: 1 << 2, // vertical blank
  RXRDY: 1 << 3, // USART RxRdy
  TXRDY: 1 << 4, // USART TxRdy / disk-IF AUX on later models
} as const;

export interface IrqSnapshot {
  mask: u8;
  priority: u8;
  programmed: boolean;
}

export class IrqController {
  mask: u8 = 0xff;
  priority: u8 = 0xff;
  // Set to true when the BIOS has explicitly programmed the mask. Used
  // by diagnostics to distinguish "default still in force" from
  // "ROM said all sources enabled".
  programmed = false;

  snapshot(): IrqSnapshot {
    return {
      mask: this.mask,
      priority: this.priority,
      programmed: this.programmed,
    };
  }

  fromSnapshot(s: IrqSnapshot): void {
    this.mask = s.mask;
    this.priority = s.priority;
    this.programmed = s.programmed;
  }

  vblMasked(): boolean {
    return (this.mask & IRQ_MASK.VBL) === 0;
  }

  register(bus: IOBus): void {
    bus.register(0xe4, {
      name: "irq/priority",
      read: () => this.priority,
      write: (_p, v) => {
        this.priority = v;
        // The priority/level register is latched but not consulted
        // anywhere — IM 2 priority resolution isn't modelled yet.
        log.warn(`priority := 0x${v.toString(16)} (stub)`);
      },
    });
    bus.register(0xe6, {
      name: "irq/mask",
      read: () => this.mask,
      write: (_p, v) => {
        this.mask = v;
        this.programmed = true;
        log.info(`mask := 0x${v.toString(16)}`);
      },
    });
  }
}
