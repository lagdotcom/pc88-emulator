import type { IOBus } from "../../core/IOBus.js";
import { makeSector } from "../../disk/d88.js";
import type { FloppyDrive } from "../../disk/drive.js";
import type { Sector } from "../../disk/types.js";
import type {
  Cylinder,
  Head,
  Record,
  SectorIndex,
  SizeCode,
  u8,
} from "../../flavours.js";
import { getLogger } from "../../log.js";
import { asU8, byte } from "../../tools.js";

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

// Command opcodes. Mask the first byte with `CMD_MASK` to extract the
// opcode; the high bits carry MT/MF/SK flags on the readable /
// writable family.
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
} as const;

export const CMD_MASK = 0x1f;

// Flag bits riding in the high three bits of the command byte.
export const CMD_FLAGS = {
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

// Structured trace events for the FDC. Hooked via `tracer`. The
// printer can reconstruct a per-command summary line from
// `cmd-start` + `param`* + `execute` + `result`* + `irq`. We
// intentionally don't fire events for every data-read / data-write
// byte during a sector transfer — those would flood. Subscribers
// that care about the data stream can hook the chip's data buffer
// directly.
export type FDCTraceEvent =
  | {
      kind: "cmd-start";
      cmd: u8;
      name: string;
      expectedParams: number;
    }
  | { kind: "param"; index: number; value: u8 }
  | {
      kind: "execute";
      cmd: u8;
      name: string;
      drive: number;
      head: u8;
    }
  | { kind: "result"; bytes: number[] }
  | { kind: "irq" };

const CMD_NAMES: { readonly [code: number]: string } = {
  [0x03]: "SPECIFY",
  [0x04]: "SENSE_DRIVE_STATUS",
  [0x07]: "RECALIBRATE",
  [0x08]: "SENSE_INTERRUPT_STATUS",
  [0x0f]: "SEEK",
  [0x0a]: "READ_ID",
  [0x06]: "READ_DATA",
  [0x05]: "WRITE_DATA",
  [0x0d]: "FORMAT_TRACK",
};

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
  readonly seekFlag: boolean[];
  readonly srt: u8;
  readonly hut: u8;
  readonly hlt: u8;
  readonly nonDma: boolean;
  readonly irqAsserted: boolean;
}

export class μPD765a {
  private phase: Phase = "idle";
  private command: u8 = 0;
  private paramBytes: u8[] = [];
  private paramsExpected = 0;
  private resultBytes: u8[] = [];
  private resultIndex = 0;

  private dataBuffer: Uint8Array | null = null;
  private dataIndex = 0;
  private targetEOT: u8 = 0;
  private targetN: SizeCode = 0 as SizeCode;
  private targetH: Head = 0 as Head;
  private currentR: Record = 0 as Record;
  private currentSectorIdx: SectorIndex = 0 as SectorIndex;

  // FORMAT TRACK accumulators. The CPU streams 4 bytes (C, H, R, N)
  // per sector; on the last byte we synthesise a Sector filled with
  // `formatFillByte` and push to `formatSectors`. After all sectors
  // are received the track is committed via FloppyDrive.formatCurrentTrack.
  private formatIdBuffer: u8[] = [];
  private formatSectors: Sector[] = [];
  private formatSectorsRemaining = 0;
  private formatFillByte: u8 = 0;

  private drives: (FloppyDrive | null)[] = [null, null];
  private pcn: u8[] = [0, 0];
  // SE bit pending per drive — surfaced (and cleared) by
  // SENSE_INTERRUPT_STATUS after SEEK / RECALIBRATE.
  private seekFlag: boolean[] = [false, false];
  private selectedDrive = 0;
  private selectedHead: u8 = 0;

  // SPECIFY-programmed timings, latched but not enforced.
  private srt: u8 = 0;
  private hut: u8 = 0;
  private hlt: u8 = 0;
  private nonDma = true;

  private irqAsserted = false;

  // INT goes high when a command completes (entering result phase or
  // finishing data transfer). CPU clears by draining the result or by
  // issuing SENSE_INTERRUPT_STATUS.
  onInterrupt: (() => void) | null = null;

  // Optional structured trace hook — same pattern as μPD8255.tracer.
  // Null by default; the hot path is one branch when un-hooked.
  tracer: ((event: FDCTraceEvent) => void) | null = null;

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
        this.irqAsserted = false;
      }
      return v;
    }
    if (this.phase === "data-read") {
      const buf = this.dataBuffer!;
      const v = buf[this.dataIndex]!;
      this.dataIndex++;
      if (this.dataIndex >= buf.length) this.advanceReadDataSector();
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
      if (this.tracer) {
        this.tracer({
          kind: "param",
          index: this.paramBytes.length - 1,
          value,
        });
      }
      if (this.paramBytes.length >= this.paramsExpected) {
        this.phase = "execution";
        this.executeCommand();
      }
      return;
    }
    if (this.phase === "data-write") {
      const code = this.command & CMD_MASK;
      if (code === CMD.WRITE_DATA) this.acceptWriteDataByte(value);
      else if (code === CMD.FORMAT_TRACK) this.acceptFormatIDByte(value);
      else log.warn(`data-write byte 0x${byte(value)} for command 0x${byte(this.command)}`);
      return;
    }
    log.warn(`unexpected data write 0x${byte(value)} in phase ${this.phase}`);
  }

  private startCommand(byteValue: u8): void {
    const code = byteValue & CMD_MASK;
    const paramCount = PARAM_COUNT[code];
    if (paramCount === undefined) {
      this.command = byteValue;
      log.warn(`invalid command 0x${byte(byteValue)}`);
      this.endWithST0(ST0.IC_INVALID_CMD);
      return;
    }
    this.command = byteValue;
    this.paramBytes = [];
    this.paramsExpected = paramCount;
    this.phase = paramCount === 0 ? "execution" : "command";
    if (this.tracer) {
      this.tracer({
        kind: "cmd-start",
        cmd: byteValue,
        name: CMD_NAMES[code] ?? `cmd_0x${byte(code)}`,
        expectedParams: paramCount,
      });
    }
    if (paramCount === 0) this.executeCommand();
  }

  private executeCommand(): void {
    const code = this.command & CMD_MASK;
    if (this.tracer) {
      this.tracer({
        kind: "execute",
        cmd: this.command,
        name: CMD_NAMES[code] ?? `cmd_0x${byte(code)}`,
        drive: this.selectedDrive,
        head: this.selectedHead,
      });
    }
    switch (code) {
      case CMD.SPECIFY: this.cmdSpecify(); break;
      case CMD.SENSE_DRIVE_STATUS: this.cmdSenseDriveStatus(); break;
      case CMD.SENSE_INTERRUPT_STATUS: this.cmdSenseInterruptStatus(); break;
      case CMD.RECALIBRATE: this.cmdRecalibrate(); break;
      case CMD.SEEK: this.cmdSeek(); break;
      case CMD.READ_ID: this.cmdReadID(); break;
      case CMD.READ_DATA: this.cmdReadData(); break;
      case CMD.WRITE_DATA: this.cmdWriteData(); break;
      case CMD.FORMAT_TRACK: this.cmdFormatTrack(); break;
      default:
        log.warn(`command 0x${byte(this.command)} not implemented yet`);
        this.endWithST0(ST0.IC_INVALID_CMD);
    }
  }

  // Decode the standard "drive + head" param byte (US bits 1:0, HD
  // bit 2) and latch the result into the chip's selectedDrive /
  // selectedHead. Returns the same values for local use.
  private decodeDriveHead(b: u8): { us: number; hd: u8 } {
    const us = b & 0x03;
    const hd = ((b >>> 2) & 0x01) as u8;
    this.selectedDrive = us;
    this.selectedHead = hd;
    return { us, hd };
  }

  // Compose ST0 from an interrupt-code / extra-flags pair plus the
  // currently-selected drive and head bits. Drives every result-phase
  // ST0 the chip emits except SENSE INT's pure SE word.
  private makeST0(ic: number, extraFlags: number = 0): u8 {
    return asU8(ic | extraFlags | (this.selectedHead << 2) | this.selectedDrive);
  }

  private enterResult(bytes: number[]): void {
    this.resultBytes = bytes.map(asU8);
    this.resultIndex = 0;
    this.phase = "result";
    if (this.tracer) this.tracer({ kind: "result", bytes: bytes.slice() });
  }

  // 03h SPECIFY — latch SRT/HUT/HLT, no result phase, no IRQ.
  private cmdSpecify(): void {
    const p0 = this.paramBytes[0]!;
    const p1 = this.paramBytes[1]!;
    this.srt = ((p0 >>> 4) & 0x0f) as u8;
    this.hut = (p0 & 0x0f) as u8;
    this.hlt = ((p1 >>> 1) & 0x7f) as u8;
    this.nonDma = (p1 & 0x01) !== 0;
    this.phase = "idle";
  }

  // 04h SENSE DRIVE STATUS — return ST3.
  private cmdSenseDriveStatus(): void {
    const { us, hd } = this.decodeDriveHead(this.paramBytes[0]!);
    let st3: u8 = asU8(us | (hd << 2) | ST3.TS); // PC-88 drives are always two-sided.
    const drive = this.drives[us];
    if (drive) {
      if (drive.isReady()) st3 |= ST3.RY;
      if (drive.isWriteProtected()) st3 |= ST3.WP;
      if (drive.isAtTrack0()) st3 |= ST3.T0;
    }
    this.enterResult([st3]);
  }

  // 08h SENSE INTERRUPT STATUS — used after SEEK / RECALIBRATE
  // (which don't have their own result phase). Returns SE | drive +
  // PCN if a seek is pending; otherwise the "polling without SE"
  // abnormal-termination ST0.
  private cmdSenseInterruptStatus(): void {
    const drive = this.seekFlag.findIndex((f) => f);
    if (drive >= 0) {
      this.seekFlag[drive] = false;
      this.enterResult([ST0.SE | (drive & 0x03), this.pcn[drive]!]);
      return;
    }
    this.irqAsserted = false;
    this.enterResult([ST0.IC_INVALID_CMD]);
  }

  // 07h RECALIBRATE — step drive to track 0. No result phase; SE +
  // PCN are surfaced via SENSE INTERRUPT STATUS.
  private cmdRecalibrate(): void {
    const us = this.paramBytes[0]! & 0x03;
    this.selectedDrive = us;
    this.drives[us]?.recalibrate();
    this.pcn[us] = 0;
    this.seekFlag[us] = true;
    this.phase = "idle";
    this.assertIrq();
  }

  // 0Fh SEEK — step drive to NCN. Same result protocol as RECALIBRATE.
  private cmdSeek(): void {
    const us = this.paramBytes[0]! & 0x03;
    const ncn = this.paramBytes[1]! & 0xff;
    this.selectedDrive = us;
    const drive = this.drives[us];
    if (drive) {
      let cylinder: number = drive.cylinder;
      const dir = ncn > cylinder ? 1 : -1;
      while (cylinder !== ncn) {
        drive.step(dir);
        if (drive.cylinder === cylinder) break; // Hit a stop.
        cylinder = drive.cylinder;
      }
      this.pcn[us] = cylinder as u8;
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
    const { us, hd } = this.decodeDriveHead(this.paramBytes[0]!);
    const drive = this.drives[us];
    if (!drive || !drive.isReady()) {
      this.endWithST0(this.makeST0(ST0.IC_ABNORMAL, ST0.NR));
      return;
    }
    const id = drive.readNextSectorID(hd as unknown as Head);
    if (!id) {
      this.enterRWResult(
        this.makeST0(ST0.IC_ABNORMAL),
        ST1.MA | ST1.ND,
        0,
        drive.cylinder,
        hd,
        0,
        0,
      );
      return;
    }
    this.enterRWResult(
      this.makeST0(0),
      0,
      0,
      id.id.c,
      id.id.h,
      id.id.r,
      id.id.n,
    );
  }

  // 06h READ DATA — find sector matching {C,H,R,N}, stream its data
  // bytes through the data register, on EOT either advance to the
  // next sector or transition to result phase. Multi-track (MT)
  // continues onto head 1 when head 0 hits EOT.
  private cmdReadData(): void {
    const { us, hd } = this.decodeDriveHead(this.paramBytes[0]!);
    const c = (this.paramBytes[1]! & 0xff) as Cylinder;
    const h = (this.paramBytes[2]! & 0xff) as Head;
    const r = (this.paramBytes[3]! & 0xff) as Record;
    const n = (this.paramBytes[4]! & 0xff) as SizeCode;
    this.targetEOT = this.paramBytes[5]!;
    this.targetN = n;
    this.targetH = h;
    this.currentR = r;

    const drive = this.drives[us];
    if (!drive || !drive.isReady()) {
      this.endWithST0(this.makeST0(ST0.IC_ABNORMAL, ST0.NR));
      return;
    }
    const match = drive.scanForSector(h, r, n);
    if (!match) {
      this.enterRWResult(this.makeST0(ST0.IC_ABNORMAL), ST1.ND, 0, c, h, r, n);
      return;
    }
    const matchedC = match.sector.id.c;
    if (matchedC !== c) {
      const st2 = matchedC === 0xff ? ST2.WC | ST2.BC : ST2.WC;
      this.enterRWResult(
        this.makeST0(ST0.IC_ABNORMAL),
        ST1.ND,
        st2,
        matchedC,
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
      const mt = (this.command & CMD_FLAGS.MT) !== 0;
      if (mt && this.targetH === 0) {
        this.targetH = 1 as Head;
        this.currentR = 1 as Record;
      } else {
        this.enterRWResult(
          this.makeST0(0),
          ST1.EN,
          0,
          drive.cylinder,
          this.targetH,
          this.currentR,
          this.targetN,
        );
        return;
      }
    } else {
      this.currentR = ((this.currentR + 1) & 0xff) as Record;
    }
    const next = drive.scanForSector(this.targetH, this.currentR, this.targetN);
    if (!next) {
      this.enterRWResult(
        this.makeST0(ST0.IC_ABNORMAL),
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

  // 05h WRITE DATA — find sector matching {C,H,R,N}, accept its data
  // bytes from the CPU through writeDataReg, commit each one back to
  // the disk via FloppyDrive.writeSector, advance R, terminate at
  // EOT (or the multi-track flip). Mirrors cmdReadData but in the
  // CPU→disk direction.
  private cmdWriteData(): void {
    const { us } = this.decodeDriveHead(this.paramBytes[0]!);
    const c = (this.paramBytes[1]! & 0xff) as Cylinder;
    const h = (this.paramBytes[2]! & 0xff) as Head;
    const r = (this.paramBytes[3]! & 0xff) as Record;
    const n = (this.paramBytes[4]! & 0xff) as SizeCode;
    this.targetEOT = this.paramBytes[5]!;
    this.targetN = n;
    this.targetH = h;
    this.currentR = r;

    const drive = this.drives[us];
    if (!drive || !drive.isReady()) {
      this.endWithST0(this.makeST0(ST0.IC_ABNORMAL, ST0.NR));
      return;
    }
    if (drive.isWriteProtected()) {
      this.enterRWResult(this.makeST0(ST0.IC_ABNORMAL), ST1.NW, 0, c, h, r, n);
      return;
    }
    const match = drive.scanForSector(h, r, n);
    if (!match) {
      this.enterRWResult(this.makeST0(ST0.IC_ABNORMAL), ST1.ND, 0, c, h, r, n);
      return;
    }
    const matchedC = match.sector.id.c;
    if (matchedC !== c) {
      const st2 = matchedC === 0xff ? ST2.WC | ST2.BC : ST2.WC;
      this.enterRWResult(this.makeST0(ST0.IC_ABNORMAL), ST1.ND, st2, matchedC, h, r, n);
      return;
    }
    this.dataBuffer = new Uint8Array(128 << n);
    this.dataIndex = 0;
    this.currentSectorIdx = match.index;
    this.phase = "data-write";
  }

  private acceptWriteDataByte(value: u8): void {
    const buf = this.dataBuffer!;
    buf[this.dataIndex] = value;
    this.dataIndex++;
    if (this.dataIndex >= buf.length) this.commitWriteDataSector();
  }

  // One sector's worth of bytes received: write it back and either
  // advance to the next R or terminate. EN flag mirrors cmdReadData's
  // EOT handling; multi-track (MT) crosses to head 1 when head 0
  // hits EOT.
  private commitWriteDataSector(): void {
    const drive = this.drives[this.selectedDrive]!;
    drive.writeSector(this.targetH, this.currentSectorIdx, this.dataBuffer!);

    if (this.currentR >= this.targetEOT) {
      const mt = (this.command & CMD_FLAGS.MT) !== 0;
      if (mt && this.targetH === 0) {
        this.targetH = 1 as Head;
        this.currentR = 1 as Record;
      } else {
        this.enterRWResult(
          this.makeST0(0),
          ST1.EN,
          0,
          drive.cylinder,
          this.targetH,
          this.currentR,
          this.targetN,
        );
        return;
      }
    } else {
      this.currentR = ((this.currentR + 1) & 0xff) as Record;
    }
    const next = drive.scanForSector(this.targetH, this.currentR, this.targetN);
    if (!next) {
      this.enterRWResult(
        this.makeST0(ST0.IC_ABNORMAL),
        ST1.ND,
        0,
        drive.cylinder,
        this.targetH,
        this.currentR,
        this.targetN,
      );
      return;
    }
    this.currentSectorIdx = next.index;
    this.dataBuffer = new Uint8Array(128 << this.targetN);
    this.dataIndex = 0;
  }

  // 0Dh FORMAT TRACK — take 5 params (drive/head, N, SC, GPL, FILL),
  // then read 4*SC bytes from the CPU describing each sector's
  // {C,H,R,N}. After all IDs received, commit a fresh track filled
  // with the FILL byte at every sector's data field.
  private cmdFormatTrack(): void {
    const { us, hd } = this.decodeDriveHead(this.paramBytes[0]!);
    const n = (this.paramBytes[1]! & 0xff) as SizeCode;
    const sc = this.paramBytes[2]! & 0xff;
    this.targetN = n;
    this.targetH = hd as unknown as Head;
    this.formatSectorsRemaining = sc;
    this.formatFillByte = (this.paramBytes[4]! & 0xff) as u8;
    this.formatSectors = [];
    this.formatIdBuffer = [];

    const drive = this.drives[us];
    if (!drive || !drive.isReady()) {
      this.endWithST0(this.makeST0(ST0.IC_ABNORMAL, ST0.NR));
      return;
    }
    if (drive.isWriteProtected()) {
      this.enterRWResult(
        this.makeST0(ST0.IC_ABNORMAL),
        ST1.NW,
        0,
        drive.cylinder,
        hd,
        0,
        n,
      );
      return;
    }
    if (sc === 0) {
      this.commitFormat();
      return;
    }
    this.phase = "data-write";
  }

  private acceptFormatIDByte(value: u8): void {
    this.formatIdBuffer.push(value);
    if (this.formatIdBuffer.length < 4) return;
    const [c, h, r, sectorN] = this.formatIdBuffer;
    this.formatIdBuffer = [];
    const dataLen = 128 << (sectorN! & 0xff);
    const data = new Uint8Array(dataLen).fill(this.formatFillByte);
    this.formatSectors.push(
      makeSector(
        (c! & 0xff) as Cylinder,
        (h! & 0xff) as Head,
        (r! & 0xff) as Record,
        (sectorN! & 0xff) as SizeCode,
        data,
      ),
    );
    this.formatSectorsRemaining--;
    if (this.formatSectorsRemaining <= 0) this.commitFormat();
  }

  private commitFormat(): void {
    const drive = this.drives[this.selectedDrive]!;
    drive.formatCurrentTrack(this.targetH, this.formatSectors);
    // Datasheet says the result-phase C/H/R/N from FORMAT TRACK is
    // "indeterminate"; emulators typically emit the post-format
    // cylinder + head with R/N zeroed.
    this.enterRWResult(
      this.makeST0(0),
      0,
      0,
      drive.cylinder,
      this.targetH,
      0,
      this.targetN,
    );
    this.formatSectors = [];
  }

  // Read/write 7-byte result emit: ST0 / ST1 / ST2 / C / H / R / N.
  // The success path passes drive.cylinder + targetH/currentR/targetN
  // (post-incremented per the datasheet so chained commands continue
  // from where the previous one left off); error paths pass whatever
  // C/H/R/N the lookup was actually attempting.
  private enterRWResult(
    st0: number,
    st1: number,
    st2: number,
    c: number,
    h: number,
    r: number,
    n: number,
  ): void {
    this.enterResult([st0, st1, st2, c, h, r, n]);
    this.dataBuffer = null;
    this.assertIrq();
  }

  private endWithST0(st0: u8): void {
    this.enterResult([st0]);
    this.assertIrq();
  }

  private assertIrq(): void {
    this.irqAsserted = true;
    if (this.tracer) this.tracer({ kind: "irq" });
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
    this.seekFlag = s.seekFlag.slice();
    this.srt = s.srt;
    this.hut = s.hut;
    this.hlt = s.hlt;
    this.nonDma = s.nonDma;
    this.irqAsserted = s.irqAsserted;
    this.dataBuffer = null;
  }
}
