import type { FloppyDrive } from "../../disk/drive.js";
import type {
  Cylinder,
  Head,
  Record,
  SectorIndex,
  SizeCode,
  u8,
} from "../../flavours.js";
import type { IOBus } from "../../core/IOBus.js";
import { getLogger } from "../../log.js";
import { byte } from "../../tools.js";

const log = getLogger("fdc");

// μPD765a FDC. PC-88 mkII+ wires this on the FDC sub-CPU's I/O bus
// at 0xFA (Main Status Register, read-only) and 0xFB (Data Register,
// read/write). The chip has four phases — idle / command / execution
// / result — plus byte-stream sub-states for data transfer. See
// refs and MAME's upd765.cpp for the cross-reference.

// Main Status Register bits.
export const MSR = {
  RQM: 1 << 7, // Request for master — data register ready
  DIO: 1 << 6, // Direction: 1 = FDC → CPU, 0 = CPU → FDC
  NDM: 1 << 5, // Non-DMA mode
  CB: 1 << 4, // Command busy (any active command)
  D3B: 1 << 3,
  D2B: 1 << 2,
  D1B: 1 << 1,
  D0B: 1 << 0,
} as const;

// ST0 bits.
export const ST0 = {
  IC_NORMAL: 0 << 6,
  IC_ABNORMAL: 1 << 6,
  IC_INVALID_CMD: 2 << 6,
  IC_ABNORMAL_POLL: 3 << 6,
  IC_MASK: 3 << 6,
  SE: 1 << 5, // Seek end
  EC: 1 << 4, // Equipment check
  NR: 1 << 3, // Not ready
  HD: 1 << 2, // Head address
  US1: 1 << 1,
  US0: 1 << 0,
} as const;

// ST1 bits.
export const ST1 = {
  EN: 1 << 7, // End of cylinder (sector R > EOT after read)
  DE: 1 << 5, // Data error (CRC)
  OR: 1 << 4, // Overrun
  ND: 1 << 2, // No data — sector ID not found
  NW: 1 << 1, // Not writable
  MA: 1 << 0, // Missing address mark
} as const;

// ST2 bits.
export const ST2 = {
  CM: 1 << 6, // Control mark — sector had deleted DAM and SK was clear
  DD: 1 << 5, // Data error in data field
  WC: 1 << 4, // Wrong cylinder (ID's C did not match seek target)
  BC: 1 << 3, // Bad cylinder (ID's C = 0xFF)
  SN: 1 << 2, // Scan not satisfied
  SH: 1 << 1, // Scan equal hit
  MD: 1 << 0, // Missing data address mark
} as const;

// ST3 bits.
export const ST3 = {
  FT: 1 << 7, // Fault
  WP: 1 << 6, // Write protected
  RY: 1 << 5, // Ready (drive selected, motor on, disk inserted)
  T0: 1 << 4, // Track 0 sensor
  TS: 1 << 3, // Two-sided drive
  HD: 1 << 2,
  US1: 1 << 1,
  US0: 1 << 0,
} as const;

// Command opcodes. The high 3 bits of READ DATA / WRITE DATA / READ
// TRACK / FORMAT TRACK encode MT / MF / SK flags; mask with 0x1F to
// extract the command code itself.
export const CMD = {
  SPECIFY: 0x03,
  SENSE_DRIVE_STATUS: 0x04,
  RECALIBRATE: 0x07,
  SENSE_INTERRUPT_STATUS: 0x08,
  SEEK: 0x0f,
  READ_ID: 0x0a,
  READ_DATA: 0x06,
  WRITE_DATA: 0x05,
  FORMAT_TRACK: 0x0d,
  CMD_MASK: 0x1f,
  // Flag bits in the first byte for readable / writable commands.
  MT: 1 << 7, // Multi-track (continue onto next head)
  MF: 1 << 6, // MFM (vs FM)
  SK: 1 << 5, // Skip deleted-DAM sectors
} as const;

// Number of parameter bytes following the first byte (which carries
// the opcode + flags). Commands whose parameter count depends on the
// flags handle themselves.
const PARAM_COUNT: { [code: number]: number } = {
  [CMD.SPECIFY]: 2,
  [CMD.SENSE_DRIVE_STATUS]: 1,
  [CMD.RECALIBRATE]: 1,
  [CMD.SENSE_INTERRUPT_STATUS]: 0,
  [CMD.SEEK]: 2,
  [CMD.READ_ID]: 1,
  [CMD.READ_DATA]: 8,
  [CMD.WRITE_DATA]: 8,
  [CMD.FORMAT_TRACK]: 5,
};

type Phase = "idle" | "command" | "execution" | "result" | "data-read" | "data-write";

export interface FDCSnapshot {
  readonly phase: Phase;
  readonly command: u8;
  readonly paramBytes: number[];
  readonly paramsExpected: number;
  readonly resultBytes: number[];
  readonly resultIndex: number;
  readonly dataIndex: number;
  readonly selectedDrive: number;
  readonly selectedHead: u8;
  readonly pcn: number[];
  readonly lastST0: u8;
  readonly seekFlag: boolean[];
  readonly srt: u8;
  readonly hut: u8;
  readonly hlt: u8;
  readonly nonDma: boolean;
  readonly irqAsserted: boolean;
}

export class μPD765a {
  // Phase + per-phase state.
  private phase: Phase = "idle";
  private command: u8 = 0;
  private paramBytes: u8[] = [];
  private paramsExpected = 0;
  private resultBytes: u8[] = [];
  private resultIndex = 0;

  // Data-transfer state for READ DATA / WRITE DATA.
  private dataBuffer: Uint8Array | null = null;
  private dataIndex = 0;
  private targetEOT: u8 = 0;
  private targetN: SizeCode = 0 as SizeCode;
  private targetH: Head = 0 as Head;
  private currentR: Record = 0 as Record;
  private currentSectorIdx: SectorIndex = 0 as SectorIndex;

  // Drive state (per drive, indexed 0..1).
  private drives: (FloppyDrive | null)[] = [null, null];
  private pcn: u8[] = [0, 0]; // Present cylinder number per drive.
  private seekFlag: boolean[] = [false, false]; // SE bit pending for SENSE INT.
  private selectedDrive = 0;
  private selectedHead: u8 = 0;

  // SPECIFY-programmed timings (latched, not enforced).
  private srt: u8 = 0; // Step rate time
  private hut: u8 = 0; // Head unload time
  private hlt: u8 = 0; // Head load time
  private nonDma = true;

  private lastST0: u8 = 0;
  private irqAsserted = false;

  // Hooks for the surrounding system. INT goes high when a command
  // completes (entering result phase or finishing a data transfer);
  // CPU clears it by reading the result or by SENSE_INTERRUPT_STATUS.
  onInterrupt: (() => void) | null = null;

  attachDrive(index: number, drive: FloppyDrive): void {
    if (index < 0 || index > 1)
      throw new Error(`FDC drive index ${index} out of range`);
    this.drives[index] = drive;
  }

  register(bus: IOBus, basePort = 0xfa): void {
    bus.register(basePort, {
      name: "fdc/msr",
      read: () => this.readMSR(),
    });
    bus.register(basePort + 1, {
      name: "fdc/data",
      read: () => this.readDataReg(),
      write: (_p, value) => this.writeDataReg(value),
    });
  }

  // Main Status Register is computed on each read from current phase
  // + state. RQM is always 1 in this simple model (we never stall the
  // CPU for media timing).
  readMSR(): u8 {
    let msr: u8 = MSR.RQM;
    if (this.nonDma) msr |= MSR.NDM;
    if (this.phase === "result" || this.phase === "data-read") msr |= MSR.DIO;
    if (this.phase !== "idle") msr |= MSR.CB;
    return msr;
  }

  readDataReg(): u8 {
    if (this.phase === "result") {
      const v = this.resultBytes[this.resultIndex]!;
      this.resultIndex++;
      if (this.resultIndex >= this.resultBytes.length) {
        this.phase = "idle";
        this.resultBytes = [];
        this.resultIndex = 0;
        // INT stays low after result has been fully drained.
        this.irqAsserted = false;
      }
      return v;
    }
    if (this.phase === "data-read") {
      const v = this.dataBuffer![this.dataIndex]!;
      this.dataIndex++;
      if (this.dataIndex >= this.dataBuffer!.length) {
        this.advanceReadDataSector();
      }
      return v;
    }
    log.warn(`data read in phase ${this.phase} (idle / no command active)`);
    return 0xff;
  }

  writeDataReg(value: u8): void {
    if (this.phase === "idle") {
      this.startCommand(value);
      return;
    }
    if (this.phase === "command") {
      this.paramBytes.push(value);
      if (this.paramBytes.length >= this.paramsExpected) {
        this.phase = "execution";
        this.executeCommand();
      }
      return;
    }
    if (this.phase === "data-write") {
      // Reserved for WRITE DATA / FORMAT TRACK; tier 2.
      log.warn(`data-write phase byte 0x${byte(value)} (TODO: write commands)`);
      return;
    }
    log.warn(`unexpected data write 0x${byte(value)} in phase ${this.phase}`);
  }

  private startCommand(byteValue: u8): void {
    const code = byteValue & CMD.CMD_MASK;
    const paramCount = PARAM_COUNT[code];
    if (paramCount === undefined) {
      // Invalid command: ST0 = 0x80, single byte result.
      this.command = byteValue;
      this.lastST0 = ST0.IC_INVALID_CMD;
      this.resultBytes = [this.lastST0];
      this.resultIndex = 0;
      this.phase = "result";
      this.assertIrq();
      log.warn(`invalid command 0x${byte(byteValue)}`);
      return;
    }
    this.command = byteValue;
    this.paramBytes = [];
    this.paramsExpected = paramCount;
    this.phase = paramCount === 0 ? "execution" : "command";
    if (paramCount === 0) this.executeCommand();
  }

  private executeCommand(): void {
    const code = this.command & CMD.CMD_MASK;
    switch (code) {
      case CMD.SPECIFY:
        this.cmdSpecify();
        break;
      case CMD.SENSE_DRIVE_STATUS:
        this.cmdSenseDriveStatus();
        break;
      case CMD.SENSE_INTERRUPT_STATUS:
        this.cmdSenseInterruptStatus();
        break;
      case CMD.RECALIBRATE:
        this.cmdRecalibrate();
        break;
      case CMD.SEEK:
        this.cmdSeek();
        break;
      case CMD.READ_ID:
        this.cmdReadID();
        break;
      case CMD.READ_DATA:
        this.cmdReadData();
        break;
      default:
        log.warn(`command 0x${byte(this.command)} not implemented yet`);
        this.endWithST0(ST0.IC_INVALID_CMD);
    }
  }

  // 03h SPECIFY — latch SRT/HUT/HLT, no result phase, no IRQ.
  private cmdSpecify(): void {
    this.srt = (this.paramBytes[0]! >>> 4) & 0x0f;
    this.hut = this.paramBytes[0]! & 0x0f;
    this.hlt = (this.paramBytes[1]! >>> 1) & 0x7f;
    this.nonDma = (this.paramBytes[1]! & 0x01) !== 0;
    this.phase = "idle";
  }

  // 04h SENSE DRIVE STATUS — return ST3.
  private cmdSenseDriveStatus(): void {
    const us = this.paramBytes[0]! & 0x03;
    const hd = (this.paramBytes[0]! >>> 2) & 0x01;
    this.selectedDrive = us;
    this.selectedHead = hd as u8;
    let st3: u8 = (us | (hd << 2) | ST3.TS) as u8; // Always two-sided in PC-88.
    const drive = this.drives[us];
    if (drive) {
      if (drive.isReady()) st3 |= ST3.RY;
      if (drive.isWriteProtected()) st3 |= ST3.WP;
      if (drive.isAtTrack0()) st3 |= ST3.T0;
    }
    this.resultBytes = [st3];
    this.resultIndex = 0;
    this.phase = "result";
  }

  // 08h SENSE INTERRUPT STATUS — returns ST0 + PCN. Used after SEEK /
  // RECALIBRATE (which don't have their own result phase) and to
  // poll-clear the IRQ. If no seek is pending and no IRQ is asserted,
  // returns invalid-command ST0 (real silicon's "abnormal termination
  // due to polling without SE" behaviour).
  private cmdSenseInterruptStatus(): void {
    let drive = -1;
    for (let i = 0; i < this.seekFlag.length; i++) {
      if (this.seekFlag[i]) {
        drive = i;
        break;
      }
    }
    if (drive >= 0) {
      this.seekFlag[drive] = false;
      const st0 = (ST0.SE | (drive & 0x03)) as u8;
      this.resultBytes = [st0, this.pcn[drive]!];
      this.resultIndex = 0;
      this.phase = "result";
      this.lastST0 = st0;
      return;
    }
    if (this.irqAsserted) {
      this.resultBytes = [this.lastST0];
      this.resultIndex = 0;
      this.phase = "result";
      this.irqAsserted = false;
      return;
    }
    // Polling case: no pending IRQ. Return ST0 = invalid command.
    this.resultBytes = [ST0.IC_INVALID_CMD];
    this.resultIndex = 0;
    this.phase = "result";
  }

  // 07h RECALIBRATE — step drive to track 0. No result phase; the SE
  // bit + PCN are surfaced via SENSE INTERRUPT STATUS.
  private cmdRecalibrate(): void {
    const us = this.paramBytes[0]! & 0x03;
    this.selectedDrive = us;
    const drive = this.drives[us];
    if (drive) drive.recalibrate();
    this.pcn[us] = 0;
    this.seekFlag[us] = true;
    this.phase = "idle";
    this.assertIrq();
  }

  // 0Fh SEEK — step drive to NCN (new cylinder number). Same result
  // protocol as RECALIBRATE.
  private cmdSeek(): void {
    const us = this.paramBytes[0]! & 0x03;
    const ncn: number = this.paramBytes[1]! & 0xff;
    this.selectedDrive = us;
    const drive = this.drives[us];
    if (drive) {
      const cur = (): number => drive.cylinder as number;
      const dir = ncn > cur() ? 1 : -1;
      while (cur() !== ncn) {
        const before = cur();
        drive.step(dir);
        if (cur() === before) break; // Hit a stop.
      }
      this.pcn[us] = cur() as u8;
    } else {
      this.pcn[us] = ncn as u8;
    }
    this.seekFlag[us] = true;
    this.phase = "idle";
    this.assertIrq();
  }

  // 0Ah READ ID — return the next sector ID under the head as a
  // 7-byte result phase (ST0, ST1, ST2, C, H, R, N).
  private cmdReadID(): void {
    const us = this.paramBytes[0]! & 0x03;
    const hd = (this.paramBytes[0]! >>> 2) & 0x01;
    this.selectedDrive = us;
    this.selectedHead = hd as u8;
    const drive = this.drives[us];
    if (!drive || !drive.isReady()) {
      this.endWithST0(ST0.IC_ABNORMAL | ST0.NR | (hd << 2) | us);
      return;
    }
    const id = drive.readNextSectorID(hd as Head);
    if (!id) {
      this.endRWWithError(
        (ST0.IC_ABNORMAL | (hd << 2) | us) as u8,
        ST1.MA | ST1.ND,
        0,
        drive.cylinder,
        hd as Head,
        0 as Record,
        0 as SizeCode,
      );
      return;
    }
    this.lastST0 = ((hd << 2) | us) as u8;
    this.resultBytes = [
      this.lastST0,
      0,
      0,
      id.id.c & 0xff,
      id.id.h & 0xff,
      id.id.r & 0xff,
      id.id.n & 0xff,
    ];
    this.resultIndex = 0;
    this.phase = "result";
    this.assertIrq();
  }

  // 06h READ DATA — find sector matching {C,H,R,N}, stream its data
  // bytes through the data register, on EOT either advance to the
  // next sector or transition to result phase. Multi-track (MT)
  // continues onto head 1 when head 0 hits EOT.
  private cmdReadData(): void {
    const us = this.paramBytes[0]! & 0x03;
    const hd = (this.paramBytes[0]! >>> 2) & 0x01;
    const c = (this.paramBytes[1]! & 0xff) as Cylinder;
    const h = (this.paramBytes[2]! & 0xff) as Head;
    const r = (this.paramBytes[3]! & 0xff) as Record;
    const n = (this.paramBytes[4]! & 0xff) as SizeCode;
    const eot = this.paramBytes[5]!;
    this.selectedDrive = us;
    this.selectedHead = hd as u8;
    this.targetEOT = eot;
    this.targetN = n;
    this.targetH = h;
    this.currentR = r;

    const drive = this.drives[us];
    if (!drive || !drive.isReady()) {
      this.endWithST0(ST0.IC_ABNORMAL | ST0.NR | (hd << 2) | us);
      return;
    }
    const match = drive.scanForSector(h, r, n);
    if (!match) {
      this.endRWWithError(
        (ST0.IC_ABNORMAL | (hd << 2) | us) as u8,
        ST1.ND,
        0,
        c,
        h,
        r,
        n,
      );
      return;
    }
    if (match.sector.id.c !== c) {
      // Wrong-cylinder protection sector.
      this.endRWWithError(
        (ST0.IC_ABNORMAL | (hd << 2) | us) as u8,
        ST1.ND,
        match.sector.id.c === 0xff ? ST2.WC | ST2.BC : ST2.WC,
        match.sector.id.c as Cylinder,
        h,
        r,
        n,
      );
      return;
    }
    this.dataBuffer = match.sector.data;
    this.dataIndex = 0;
    this.currentSectorIdx = match.index;
    this.phase = "data-read";
    this.assertIrq();
  }

  // Called when the current sector's data field has been fully
  // streamed to the CPU. Either advance to the next R or terminate.
  private advanceReadDataSector(): void {
    const drive = this.drives[this.selectedDrive]!;
    if (this.currentR >= this.targetEOT) {
      // End-of-track reached. Multi-track flips head + resets R; the
      // single-track case just terminates with EN set.
      const mt = (this.command & CMD.MT) !== 0;
      if (mt && this.targetH === 0) {
        this.targetH = 1 as Head;
        this.currentR = 1 as Record;
      } else {
        this.endRW(
          (this.selectedHead << 2) | this.selectedDrive,
          ST1.EN,
          0,
          drive.cylinder,
        );
        return;
      }
    } else {
      this.currentR = ((this.currentR + 1) & 0xff) as Record;
    }
    const next = drive.scanForSector(
      this.targetH,
      this.currentR,
      this.targetN,
    );
    if (!next) {
      this.endRWWithError(
        (ST0.IC_ABNORMAL | (this.selectedHead << 2) | this.selectedDrive) as u8,
        ST1.ND,
        0,
        drive.cylinder,
        this.targetH,
        this.currentR,
        this.targetN,
      );
      return;
    }
    this.dataBuffer = next.sector.data;
    this.dataIndex = 0;
    this.currentSectorIdx = next.index;
  }

  // Successful read/write termination — final R is post-incremented
  // per the datasheet so a follow-up command can chain. Result bytes
  // are raw u8s; brand types carried in fields are unwrapped here.
  private endRW(st0: number, st1: number, st2: number, cylinder: number): void {
    this.lastST0 = (st0 & 0xff) as u8;
    this.resultBytes = [
      (st0 & 0xff) as u8,
      (st1 & 0xff) as u8,
      (st2 & 0xff) as u8,
      (cylinder & 0xff) as u8,
      (this.targetH & 0xff) as u8,
      (this.currentR & 0xff) as u8,
      (this.targetN & 0xff) as u8,
    ];
    this.resultIndex = 0;
    this.phase = "result";
    this.dataBuffer = null;
    this.assertIrq();
  }

  // Error termination for read/write — same shape as endRW but uses
  // the C/H/R/N from the failed lookup.
  private endRWWithError(
    st0: number,
    st1: number,
    st2: number,
    c: number,
    h: number,
    r: number,
    n: number,
  ): void {
    this.lastST0 = (st0 & 0xff) as u8;
    this.resultBytes = [
      (st0 & 0xff) as u8,
      (st1 & 0xff) as u8,
      (st2 & 0xff) as u8,
      (c & 0xff) as u8,
      (h & 0xff) as u8,
      (r & 0xff) as u8,
      (n & 0xff) as u8,
    ];
    this.resultIndex = 0;
    this.phase = "result";
    this.dataBuffer = null;
    this.assertIrq();
  }

  // Single-byte ST0 result (used by SPECIFY-style errors).
  private endWithST0(st0: u8): void {
    this.lastST0 = st0;
    this.resultBytes = [st0];
    this.resultIndex = 0;
    this.phase = "result";
    this.assertIrq();
  }

  private assertIrq(): void {
    this.irqAsserted = true;
    this.onInterrupt?.();
  }

  snapshot(): FDCSnapshot {
    return {
      phase: this.phase,
      command: this.command,
      paramBytes: this.paramBytes.slice(),
      paramsExpected: this.paramsExpected,
      resultBytes: this.resultBytes.slice(),
      resultIndex: this.resultIndex,
      dataIndex: this.dataIndex,
      selectedDrive: this.selectedDrive,
      selectedHead: this.selectedHead,
      pcn: this.pcn.slice(),
      lastST0: this.lastST0,
      seekFlag: this.seekFlag.slice(),
      srt: this.srt,
      hut: this.hut,
      hlt: this.hlt,
      nonDma: this.nonDma,
      irqAsserted: this.irqAsserted,
    };
  }

  fromSnapshot(s: FDCSnapshot): void {
    this.phase = s.phase;
    this.command = s.command;
    this.paramBytes = s.paramBytes.slice();
    this.paramsExpected = s.paramsExpected;
    this.resultBytes = s.resultBytes.slice();
    this.resultIndex = s.resultIndex;
    this.dataIndex = s.dataIndex;
    this.selectedDrive = s.selectedDrive;
    this.selectedHead = s.selectedHead;
    this.pcn = s.pcn.slice();
    this.lastST0 = s.lastST0;
    this.seekFlag = s.seekFlag.slice();
    this.srt = s.srt;
    this.hut = s.hut;
    this.hlt = s.hlt;
    this.nonDma = s.nonDma;
    this.irqAsserted = s.irqAsserted;
    this.dataBuffer = null;
  }
}
