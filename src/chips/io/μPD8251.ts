import type { IOBus } from "../../core/IOBus.js";
import type { u8 } from "../../flavours.js";
import { getLogger } from "../../log.js";

const log = getLogger("usart");

// μPD8251 USART stub. NEC's clone of the Intel 8251A — the same chip
// is used three places on PC-88 / mkII+:
//
//   - 0x20 / 0x21    "channel 0" — cassette tape (CMT) and RS-232C
//                    front-panel; lives on every model from mkI up.
//                    MAME maps with mirror 0x0E so 0x22-0x2F also
//                    decode here, but BIOS init writes only the
//                    base pair.
//   - 0xC0 / 0xC1    "channel 1" RS-232C, mkII+ expansion.
//   - 0xC2 / 0xC3    "channel 2" RS-232C, mkII+ expansion.
//
// We don't model serial behaviour at all — first-light boot just
// pokes mode/command bytes during init and reads status to check
// "TX ready / RX not ready" before giving up. Returning a static
// "TX-empty, no carrier, no RX data" status keeps that init path
// quiet without simulating a real cable.
//
// 8251A register access (per Intel datasheet, repeated in the NEC
// μPD8251A datasheet):
//   even port  data register   (R/W)
//                 W: TX data byte
//                 R: last RX byte
//   odd port   command/status  (R/W)
//                 W: depending on init phase, mode-instruction
//                    word or command-instruction word
//                 R: status byte
// Status byte bit layout (idle / no traffic):
//   bit 7  DSR    Data Set Ready (0 = not asserted)
//   bit 6  SYNDET (sync mode only, 0 elsewhere)
//   bit 5  FE     Framing error (0)
//   bit 4  OE     Overrun error (0)
//   bit 3  PE     Parity error  (0)
//   bit 2  TxE    Transmitter empty (1 = idle)
//   bit 1  RxRDY  Receiver ready (0 = no data)
//   bit 0  TxRDY  Transmitter ready (1 = ready for new byte)
// Idle status = 0b0000_0101 = 0x05.
const IDLE_STATUS: u8 = 0x05;

export interface μPD8251Snapshot {
  channels: { lastMode: u8; lastCommand: u8; lastTx: u8 }[];
}

interface ChannelState {
  lastMode: u8;
  lastCommand: u8;
  lastTx: u8;
  // 8251 init protocol: after a hardware/software reset the next
  // odd-port write is interpreted as a "mode" byte (baud rate,
  // word length, parity, stop bits). Subsequent odd-port writes
  // are "command" bytes (TxEN / RxEN / RTS / DTR / reset / etc.).
  // We track the phase only so logs identify which is which.
  expectingMode: boolean;
}

export class μPD8251 {
  private readonly channels: ChannelState[] = [];

  constructor(public readonly channelCount: number = 1) {
    for (let i = 0; i < channelCount; i++) {
      this.channels.push({
        lastMode: 0,
        lastCommand: 0,
        lastTx: 0,
        expectingMode: true,
      });
    }
  }

  snapshot(): μPD8251Snapshot {
    return {
      channels: this.channels.map((c) => ({
        lastMode: c.lastMode,
        lastCommand: c.lastCommand,
        lastTx: c.lastTx,
      })),
    };
  }

  fromSnapshot(s: μPD8251Snapshot): void {
    for (let i = 0; i < this.channels.length; i++) {
      const c = s.channels[i];
      if (!c) continue;
      this.channels[i]!.lastMode = c.lastMode;
      this.channels[i]!.lastCommand = c.lastCommand;
      this.channels[i]!.lastTx = c.lastTx;
    }
  }

  // Register one channel's pair of ports onto the bus. `dataPort` is
  // the even (data) register; the odd (command/status) sits at
  // `dataPort | 1`. mkI / mkII+ wire the channels at 0x20-0x21 (CMT
  // / RS-232 ch 0), 0xC0-0xC1 (ch 1), 0xC2-0xC3 (ch 2). MAME applies
  // mirror 0x0E to channel 0 so 0x22..0x2F also decode here; we
  // don't bother — BIOS init only touches the base pair.
  registerChannel(bus: IOBus, dataPort: u8, channel = 0): void {
    const ch = this.channels[channel];
    if (!ch) {
      log.warn(`registerChannel: no state for channel ${channel}`);
      return;
    }
    const cmdPort = dataPort | 1;
    bus.register(dataPort, {
      name: `usart${channel}/data`,
      // RX is always idle — no incoming bytes.
      read: () => 0x00,
      write: (_p, v) => {
        ch.lastTx = v;
      },
    });
    bus.register(cmdPort, {
      name: `usart${channel}/cmdstat`,
      read: () => IDLE_STATUS,
      write: (_p, v) => {
        if (ch.expectingMode) {
          ch.lastMode = v;
          ch.expectingMode = false;
          log.warn(`ch${channel} mode = 0x${v.toString(16)} (stub)`);
        } else {
          ch.lastCommand = v;
          // 8251 command byte bit 6 = "internal reset" — flips us
          // back into mode-expecting state, so the BIOS can rewrite
          // the mode without a full hardware reset.
          if ((v & 0x40) !== 0) {
            ch.expectingMode = true;
            log.warn(`ch${channel} reset (next odd write = mode)`);
          } else {
            log.warn(`ch${channel} cmd = 0x${v.toString(16)} (stub)`);
          }
        }
      },
    });
  }
}
