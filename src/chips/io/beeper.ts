import { getLogger } from "../../log.js";

const log = getLogger("beeper");

// PC-88 mkI beeper. The actual beep is driven by toggling bit 3 of
// port 0x40; sysctrl owns that port and forwards the toggle here.
// First-light just counts toggles for diagnostics; audio synthesis
// belongs to a later branch.
export interface BeeperSnapshot {
  toggles: number;
  lastBit: boolean;
}

export class Beeper {
  toggles = 0;
  private lastBit = false;

  toggle(bit: boolean): void {
    if (bit !== this.lastBit) {
      this.lastBit = bit;
      this.toggles++;
      if (this.toggles === 1) log.info("first beep toggle");
    }
  }

  snapshot(): BeeperSnapshot {
    return { toggles: this.toggles, lastBit: this.lastBit };
  }

  fromSnapshot(s: BeeperSnapshot): void {
    this.toggles = s.toggles;
    this.lastBit = s.lastBit;
  }
}
