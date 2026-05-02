# pc88-emulator

A TypeScript emulator for the NEC PC-8801 family. Initial target is the
PC-8801 mkII SR — accurate enough to boot and run simple disk-based
RPGs. Later models (FH/MH/MA/MA2) are planned via the config-driven
machine wiring; the chip layer is shared. The PC-88 VA family
(μPD9002 hybrid CPU + V3 mode) is explicitly out of scope.

## Status

Working:

- Z80 CPU, full documented instruction set including the prefix
  families (CB, ED, DD, FD, DDCB, FDCB).
- MEMPTR (WZ) tracking on every instruction that touches it; Q
  register tracking for SCF/CCF; R register half-increment;
  EI one-instruction grace period; HALT.
- SingleStepTests/z80 harness covering 1604 opcodes via `yarn
  test:z80` (default 25 cases per op, ~20 s). `Z80_SAMPLE=full`
  switches to the full 1,604,000-case run (~72 s, no OOM — cases
  lazy-load per opcode and are released between groups). **All
  pass on both dispatcher paths.** The previously-failing
  INIR/INDR/OTIR/OTDR repeat-iteration undocumented H/PV bits were
  resolved by applying the Banks / MAME `block_io_interrupted_flags`
  formula in `do_io_block_flags`; CPIR/CPDR shared the same
  PC-high-off-by-one and is now also clean at full sample.
- Hand-assembled program-level tests (`yarn test:programs`) covering
  fib, sort, LDIR, CALL/RET stacks, BCD, IX/IY, CPIR, CB on (HL).
- Frank Cringle's zexdoc/zexall via `yarn zex zexdoc` / `yarn zex
  zexall` (or the vitest path `yarn test:zex`) with a CP/M-style
  BDOS trap and percentage-complete + ETA logging.

Not yet built:

- FDC (μPD765a) — both read and write commands shipped
  (`src/chips/io/μPD765a.ts`): SPECIFY, SENSE DRIVE STATUS, SENSE
  INTERRUPT STATUS, RECALIBRATE, SEEK, READ ID, READ DATA, WRITE
  DATA, FORMAT TRACK. The chip exposes its INT line as a callback;
  SubCPU wires it to `cpu.requestIrq`. SCAN family, DMA mode, and
  cycle-accurate timing are still TODO.
- Sub-CPU model (mkII+ has a second Z80 driving the FDC via the
  `μPD8255` PPI at 0xFC-0xFF). The PPI + the SubCPU + integration
  into `PC88Machine` are wired: when a variant has
  `hasSubCpu: true` and a disk ROM, the machine constructs both,
  registers the PPI on the main IOBus at 0xFC-0xFF, and the runner
  schedules the sub for the same cycle delta as the main on every
  step. mkI doesn't trigger the wiring (`hasSubCpu: false`).
- Pixel-accurate CRT controller rendering (the μPD3301 stub
  consumes the SET MODE block correctly but doesn't generate raster).
- Graphics VRAM rendering + analogue palette (palette ports
  0x52-0x5B latch but don't drive a renderer).
- Sound generation. YM2203 (OPN) at 0x44/0x45 is stubbed for SR+
  variants; YM2608 (OPNA) for FH+ uses the same stub. Beeper
  toggles are counted, not played.
- Kanji rendering. The kanji ROM lookup at 0xE8-0xEF latches
  addresses but returns 0xFF for the bitmap (no source ROM image
  loaded yet).
- USART traffic. μPD8251 stubs at 0x20/0xC0/0xC2 latch mode/
  command bytes and return idle status; no actual TX/RX.
- IM 0 / NMI interrupt acceptance — IM 1 + IM 2 + a 60 Hz VBL pump
  work, IM 0 + NMI are TODO.

Working enough for first-light boot:

- mkI machine factory (`PC88Machine` in `src/machines/pc88.ts`) that
  wires the Z80, memory map, and I/O port stubs from `PC88Config`.
- Pre-resolved 256-slot `IOBus` (replaces `MemoryBus` for the I/O
  side; the per-port dispatch is one array load + one call).
- `PC88MemoryMap` with bank-switched 4 KB pages: BASIC ROM (n80/n88),
  E-ROM slot 0..3 at 0x6000-0x7FFF gated on RMODE/MMODE/IEROM,
  TVRAM permanently mapped at 0xF000 (= upper 4 KB of mainRam on
  pre-SR variants, dedicated chip on SR+), GVRAM plane window at
  0xC000.
- Chip modules: `SystemController` (sysctrl gate-array), `Keyboard`
  (16 read-only matrix rows at 0x00-0x0F), `μPD3301` CRTC,
  `μPD8257` DMAC, `μPD8251` USART (3 channels), `KanjiROM` (2
  banks at 0xE8-0xEF), `YM2203` OPN (SR+ only), `Calendar`,
  `Beeper`, `IrqController`, `MiscPorts`, `DisplayRegisters`
  (palette + layer mask + plane select). All stub real silicon
  enough to keep the BIOS init path advancing; unimplemented
  writes log at warn-level with a `(stub)` suffix.
- ROM loader with size + md5 validation against the descriptors in
  `src/machines/variants/`.
- Display capture (`PC88TextDisplay.toASCIIDump()`) so headless tests
  can assert against TVRAM contents. Cell stride is driven by
  `sysctrl.cols80` (port 0x30 bit 0): 1-byte cells in 80-col mode
  (N88-BASIC), 2-byte cells in 40-col mode (N-BASIC).
- Interactive debugger (`yarn pc88 -d` / `--debug`): step / next /
  continue / break / regs / chips / screen / `ss PATH` (save the
  composited frame as PNG) / dis / peek / poke /
  label / portlabel / quit, plus RAM watchpoints
  (`bw <addr> r|w|rw [break|log]`), port watchpoints
  (`bp <port> r|w|rw [break|log]`), a synthesised CALL/RST/IRQ
  call stack (`stack`), a 64-entry PC ring buffer (`trace [count]`,
  auto-printed on watch / break stops to surface JR/JP paths the
  call stack misses), and a `--script=PATH` driver that replays
  debugger commands before handing control to the REPL (omit the
  REPL by ending the script with `quit`). Watches default to
  `break` (stop the run); `log` emits a one-line trace with PC,
  value, and PC-label and keeps running — useful when init touches
  a port hundreds of times but only one of those is the bug.
  Per-ROM, per-variant-RAM, and per-variant port symbol files
  (`syms/<rom-id>.sym`, `syms/<variant>.ram.sym`,
  `syms/<variant>.port.sym`) feed both the debugger disassembly and
  the standalone `yarn dis` tool.
- Standalone `yarn dis` CLI: disassembles any raw ROM file with
  optional `--base=ADDR` mount point, `--syms`/`--ram-syms`/
  `--port-syms` for label substitution, no machine emulation needed.

## Build / run / test

```
yarn dev                 # esbuild watch
yarn build               # tsc -noEmit + esbuild production bundle
yarn test                # vitest (full suite)
yarn test:z80            # SingleStepTests Z80 harness
yarn test:programs       # hand-assembled program tests (fast)
yarn test:zex            # zexdoc.com via vitest (slow; sets ZEX=1)
yarn zex zexdoc          # standalone zex runner with streamed output
yarn zex zexall          # same, all-behaviour variant
yarn pc88                # boot mkI N-BASIC, dump TVRAM after maxOps
yarn dis <file>          # disassemble any raw ROM file (no emulation)
yarn web                 # esbuild watch for the browser bundle
yarn build:web           # tsc -noEmit + production browser bundles to web/{app,worker}.js
yarn web:host            # static-serve web/ via local-server (regenerates the
                         # Chrome DevTools workspace-folders file first)
```

`yarn pc88` accepts CLI flags (`yarn pc88 --help` for the full list):
`-m`/`--machine`, `--basic=n80|n88`, `--rom-dir`, `--max-ops`,
`--trace-io[=raw]`, `--raw-tvram`, `--log-file[=PATH]`,
`-d`/`--debug`, `--break=ADDR`, `--script=PATH`,
`--screenshot=PATH` (writes a PNG of the composited frame —
graphics + text overlay if `font.rom` is loaded). Each non-debug
flag has an env-var fallback (`PC88_ROM_DIR`, `PC88_MAX_OPS`,
`PC88_TRACE_IO`, `PC88_RAW_TVRAM`, `LOG_TO_FILE`, `PC88_SCRIPT`,
`PC88_SCREENSHOT`) so values you'd want to keep across runs can
live in a `.env`. The
required mkI ROM files are `mkI-n80.rom`, `mkI-n88.rom`,
`mkI-e0.rom` with md5s declared in `src/machines/variants/mk1.ts`.
The `roms/` directory is gitignored so dumps stay local.

Canned debugger recipes live in `dbg/` (`*.dbg` files); run
`yarn pc88 --basic=n88 --script=dbg/n88-print-entry.dbg` to drop a
log-mode watch on port 0x71, run boot to the print-routine entry,
and dump the RAM hooks the print path dispatches through. Recipes
omit `quit` so the REPL takes over once the script finishes —
useful for interactive follow-up.

`yarn pc88 --debug` drops into an interactive REPL before any
instructions execute. Commands: step / next (step-over) /
continue [cycles] / break / unbreak / breaks / regs / chips /
screen (renders the live CRTC+DMAC visible region) / stack /
trace [count] / dis [count] / peek / peekw / poke / label /
unlabel / labels / portlabel / unportlabel / bw / unbw / bwl /
bp / unbp / bpl / quit / help. Initial breakpoints can be set with `--break=ADDR`
(repeatable). The `chips` command renders a machine-wide snapshot —
the same plumbing intended to feed disk savestates when those land.
Disassembly + label/portlabel commands read and write the per-ROM /
RAM / port symbol files under `syms/`. RAM (`bw 0xed72 w`) and port
(`bp 0x71 rw`) watchpoints fire on access; default action is
`break` (stop the run), append `log` for a non-stopping one-line
emit. The synthesised `stack` is built from SP deltas (CALL/RST =
SP-2, RET = SP+2) and tracks IRQ acceptance via the IFF1
transition. `trace [count]` dumps the last 16 (max 64) PCs leading
up to the current instruction; the same trace is auto-printed
(last 8) on watch / break stops so the JR/JP / fall-through path
into the current function isn't lost. `--script=PATH` (implies
`--debug`) replays a file of debugger commands before the REPL —
handy for canned boot recipes; ending the script with `quit`
skips the REPL entirely.

The dev environment is Windows, so `test:zex` goes through `cross-env`
to set `ZEX=1` portably; any new env-vared scripts should follow the
same pattern.

## Architecture

```
src/
  chips/            silicon-level emulation, no cross-knowledge
    z80/              CPU, register file, opcode tables, disasm,
                      symbol-file parser
    io/               sysctrl, keyboard, μPD3301, μPD8257, μPD8251,
                      μPD8255 (sub-CPU IPC bridge), μPD765a (FDC,
                      read-side commands), kanji, YM2203, calendar,
                      beeper, irq, misc
                      (mostly stubs at first light)
  core/             buses + shared infrastructure
    MemoryBus.ts      providers + fast-path single-array memory bus
    IOBus.ts          pre-resolved 256-slot port bus (PC-88 I/O)
  machines/         machine wiring (config-driven, not subclassed)
    config.ts         PC88Config / VideoConfig / DiskConfig + DIP
                      bit constants (PORT30 / PORT31)
    variants/         data-only model definitions (12 variants:
                      mkI, mkII, SR, FR, MR, FH, MH, FA, MA, MA2)
    pc88.ts           PC88Machine factory + runMachine() VBL pump
    pc88-memory.ts    PC88MemoryMap, paged ROM/RAM/VRAM banking
                      (write-through to mainRam under ROM)
    sub-cpu.ts        SubCPU subsystem: Z80 + memBus + ioBus + ROM
                      mirror at 0x0000-0x1FFF + RAM at 0x4000-0x7FFF
                      + PPI/FDC port wiring, per pc80s31k
    pc88-display.ts   text-frame capture + ASCII dump
    display-regs.ts   palette + layer-mask + plane-select register block
    rom-loader.ts     md5-validating fs ROM resolver
  debug/            interactive REPL debugger + per-ROM symbol routing
                    (split out from machines/ — see "Web UI architecture"
                    below for the full file list)
  disk/             format-agnostic Disk interface + D88 parser /
                    serialiser + FloppyDrive (motor / cylinder /
                    rotation cursor; FDC will own a FloppyDrive[N])
refs/             references for chip behaviour cross-referenced
                  during reverse-engineering — D88 format,
                  Z80 undocumented, MAME PC-8801 port handlers,
                  port-plan.md (gap analysis vs MAME)
tests/
  z80/              SingleStepTests harness
  programs/         hand-assembled programs + zexdoc runner +
                    IM 1 / IM 2 IRQ-acceptance tests
  chips/io/         per-chip I/O port unit tests (CRTC, DMAC, sysctrl)
  disk/             D88 parse / serialise round-trip + real-disk
                    smoke test (skipped unless `disks/rogue.d88` exists)
  machines/         memory-map, synthetic-ROM boot, visible-region
                    rendering, runner / IRQ-mask gating
```

The `Disk` interface lives in `src/disk/types.ts`; D88Disk in
`src/disk/d88.ts` is the only implementation today. Per-sector
metadata (C/H/R/N, density, deleted mark, FDC status, raw data
length) round-trips byte-for-byte through `parseD88` → `toBytes()`,
including the "weird" cases copy protections rely on (sector data
fields whose length differs from `128 << N`, deliberate CRC error
status, mid-track deleted marks). Multi-image D88 concatenation is
parsed into separate `D88Disk` instances. Real disk dumps go in
`disks/` (gitignored, parallel to `roms/`); the test fixture is
`disks/rogue.d88`.

## TODO

Roughly ordered by what's blocking what.

### CPU

- [ ] **Interrupt acceptance: IM 0, NMI**. IM 0 (execute the byte on
  the data bus as an opcode — only the RST-38 case is reachable by
  the same vector path as IM 1) and NMI (vector 0x0066, ignores
  IFF1) are still TODO. No PC-88 source uses IM 0; NMI is unused on
  mkI but the FDD-IF on later models can drive it.
- [ ] **Run zexdoc/zexall to a clean exit** at least once and
  refresh the `APPROX_TOTAL_OPS` constants.

### Machine layer

- [x] **`Disk` interface** in `src/disk/`. Tracks + per-sector
  metadata (C/H/R/N, density, deleted-mark, CRC status), variable
  data-field length for copy-protected sectors, multi-image D88
  concatenation. D88Disk round-trips byte-for-byte against the
  Rogue (1986 ASCII) fixture.
- [x] **`FloppyDrive` layer** in `src/disk/drive.ts` — owns inserted
  disk + motor + current cylinder + rotation cursor. `scanForSector`
  simulates "scan IDs as the head spins past, advance cursor past
  the matched sector, report whether the index hole was crossed";
  `readNextSectorID` covers the FDC READ ID command; snapshot only
  carries position state (the disk is reattached at savestate-load
  time). The FDC will own `FloppyDrive[N]` and never touch `Disk`
  directly. Step rate / motor spin-up belong to the FDC's timing
  model; the drive only tracks position.
- [ ] **`ROMManifest.disk` is still optional** — once at least one
  chip needs the disk ROM at runtime, lift the field to required.
- [x] **Sub-CPU IPC PPI** (`μPD8255` at 0xFC-0xFF). Two-sided
  bridge modelled per MAME's `pc80s31k`: on each side, port A is
  outgoing (write to send), port B is incoming (read to receive),
  port C carries the handshake bits with a **high-nibble cross-
  down remap** — each side's port-C high nibble (writer's
  ATN/DAC/RFD/DAV at bits 7/6/5/4) lands as the reader's low
  nibble (bits 3/2/1/0). Without that, the PC-8031 disk-board ROM
  polls bit 3 of its port C forever waiting for the BIOS's bit-7
  ATN. Six internal latches plus the remap on read.
  `hasFreshForSub()` / `hasFreshForMain()` flags drive the sub-CPU
  scheduler.
- [x] **Sub-CPU subsystem** in `src/machines/sub-cpu.ts`. Second
  Z80 + its own MemoryBus + IOBus + ROM mirror + 16 KB RAM + PPI
  registered on its sub side, modelled per MAME's pc80s31k. Tested
  standalone with an echo+1 Z80 program that round-trips a byte
  through the PPI from the main side back to the main side.
- [x] **Wire SubCPU into `PC88Machine`** for `hasSubCpu: true`
  variants. Disk-ROM loader populates `LoadedROMs.disk` (slot
  added to `LOADED_ROM_SLOTS`); the runner alternates 1:1 at
  4 MHz (after each main `runOneOp`, sub runs the same cycle
  delta). PPI registered on the main IOBus when the SubCPU is
  present, otherwise 0xFC-0xFF stay open-bus. `MachineSnapshot`
  now includes `subcpu` + `ppi` fields (null on hasSubCpu=false).
- [x] **PPI-driven sub-CPU IRQ wake**. `μPD8255.onFreshForSub` /
  `onFreshForMain` fire on each port-A write; SubCPU wires the
  former to `cpu.requestIrq(irqVector)`. SubCPU.runCycles now
  steps a halted CPU when an IRQ is pending, mirroring the main
  runMachine pattern. Bus-only IPC round-trip is tested
  end-to-end: main writes the PPI, the HALTed sub wakes via IM 1,
  the handler at 0x0038 echoes back through the PPI, main reads
  the response — no direct-poke API needed.
- [x] **`FloppyDrive[N]` attached to the FDC + `insertDisk` API +
  CLI `--disk0=PATH.d88`**. PC88Machine creates `count` drives
  (default 2 when the disk subsystem is wired but the variant
  declares 0) and attaches them to the FDC; `insertDisk(idx, disk)`
  loads a parsed `Disk` and turns the motor on. The
  `enableDiskSubsystem` constructor opt force-wires the subsystem
  on hasSubCpu=false variants (the path mkI users take with the
  PC-8031 add-on); `--disk0=PATH.d88` parses the D88 (taking image
  0 for multi-image files), sets that flag, and inserts. EXTON bit
  3 of port 0x40 is cleared automatically when the subsystem is
  wired so the BIOS does its PPI-init handshake instead of jumping
  straight to BASIC.
- [x] **Z80 IM 0 + bus byte 0x00 (NOP) IRQ acceptance**. Real
  pc80s31k IRQ ack drives NOP onto the data bus, so the EI;HALT;DI
  sequence the disk ROM uses to wait on FDC completions resumes at
  the post-HALT instruction without a vector dispatch. We were
  jumping to 0x0038 unconditionally for every IM 0 IRQ, which
  corrupted the post-HALT flow (the bytes at 0x0038 in the disk
  ROM are mid-instruction, not a real RST 38h handler). Fixed in
  cpu.ts: IM 0 + NOP just clears HALT, no push, PC unchanged.
  IM 0 + 0xFF (RST 38h) still works for the IM 1-style /INT
  pulled-low default. Test in `irq.test.ts`.
- [x] **Debugger drives sub-CPU; chips command shows it**.
  `trackedStep` now feeds the sub the same cycle delta as the
  main, so debugger sessions see the real two-CPU dynamics.
  `chips` reports PPI control + latches + fresh-flags and the
  sub's PC / SP / IFF1 / IM / halted / irqVec / drive-mode.
- [x] **Structured PPI/FDC IPC tracer (`--trace-ipc`)**. The PPI
  exposes a `tracer` callback emitting decoded events for port-A/B
  data writes (with the receiver's ATN state attached so a printer
  can tag cmd-byte vs param-byte) and for port-C bit set/reset
  with the GPIB mnemonic (ATN/DAC/RFD/DAV) resolved. The FDC
  emits cmd-start / param / execute / result / irq events with
  the command name decoded. `--trace-ipc` (env: PC88_TRACE_IPC=1)
  installs default printers — much easier to read than `--trace-io`
  for disk-boot work because most port traffic is the polling
  loops. Both tracers are null by default; one branch per port
  write when un-hooked.
- [ ] **Sub-CPU disk-boot handshake completion**. With drives
  attached + EXTON cleared + PPI cross-down remap + IM 0 + NOP
  IRQ wake-up all in place, the full handshake runs end-to-end:
  main's `ppi_send_byte` (cmd 0x00 init / 0x07 drive count / 0x06
  status) round-trips, the sub-CPU dispatches each cmd, the FDC
  asserts IRQ on RECALIBRATE completion, and the sub wakes from
  HALT and reads SENSE INT. The N88-BASIC disk-detect path now
  CALLs into the disk-BASIC E-ROM at 0x6F06 with bytes flowing
  on the PPI both ways. The remaining gap is the actual boot-
  sector read: cmd 0x06 returns the init-state status (0x80),
  which BIOS interprets as "no boot disk", so it falls through
  to the N88-BASIC "How many files(0-15)?" prompt. Need to
  understand the E-ROM disk-BASIC's boot-sector-read protocol
  to drive the sub-CPU into a path that reports a bootable disk.
- [ ] **DMAC channel scheduling**. The `μPD8257` stub accepts the
  init handshake (channel address/count + mode-set) but doesn't
  actually perform character-pull transfers; once the renderer is
  real, the DMAC will need to drive TVRAM → CRTC fetches each
  scanline.

### Chips

- [x] **μPD765a FDC — read + write path**. Four-phase
  command/result state machine + symbolic `MSR` / `ST0-3` / `CMD` /
  `CMD_FLAGS` enums. Commands: SPECIFY, SENSE DRIVE STATUS, SENSE
  INTERRUPT STATUS, RECALIBRATE, SEEK, READ ID, READ DATA (incl.
  multi-track), WRITE DATA (incl. multi-sector + multi-track +
  write-protect), FORMAT TRACK (synthesises sectors from a streamed
  CHRN list, fills data fields with the FILL byte). Drives mount via
  `attachDrive()`; the chip's INT callback wires through SubCPU to
  `cpu.requestIrq()`. Registered on the SubCPU IOBus at 0xFA-0xFB.
- [ ] **μPD765a FDC — SCAN family**. SCAN EQUAL / SCAN LO-EQ /
  SCAN HI-EQ — comparison commands few PC-88 BIOSes use. Plumbing
  matches READ DATA closely; deferred until something exercises it.
- [ ] **Cycle-accurate FDC timing**. Seek/step rate, head load /
  unload, rotational latency. Today the chip transitions phases
  on demand. Copy-protected disks need the real silicon timing.
- [x] **Graphics VRAM rendering — pixel frame**.
  `PC88TextDisplay.getPixelFrame()` composites the three GVRAM
  planes into a 640×200 RGBA buffer using the digital 8-colour
  palette (`DIGITAL_PALETTE` exported from pc88-display.ts: plane
  0 = blue, 1 = red, 2 = green; combined index → RGB). MSB-first
  within each byte, layer mask honoured, port-0x52 background
  colour fills the rest. Renderer-agnostic: web canvas can blit
  via `putImageData`; CLI can dump as PPM. Both targets share the
  same data model.
- [x] **CLI screenshot renderer**. Two entry points:
  `yarn pc88 --screenshot=PATH` writes the composited frame as a
  PNG via `pngjs` after the run completes; the debugger command
  `ss PATH` (alias `screenshot PATH`) saves the live frame at any
  point in a session. Helper: `pixelFrameToPNG(frame): Uint8Array`
  in `src/machines/pc88-screenshot.ts` (Node-only — pngjs uses
  node:zlib; pulling that into pc88-display.ts would break the
  web bundle). The debugger reaches the encoder through a
  `DebugOptions.saveScreenshot` callback that the CLI populates;
  the dispatcher itself stays browser-safe. N-BASIC boot screen at
  640×200 is ~3 KB.
- [x] **Text glyph overlay from font ROM**. `LoadedROMs.font`
  loaded via the loader's slot allowlist; `PC88Machine` passes the
  bytes to `PC88TextDisplay`; `getPixelFrame()` overlays each TVRAM
  cell's glyph (8×8 from the 2 KB mkI font ROM, char-code-indexed,
  MSB-leftmost) on top of the GVRAM composite. Cell width derived
  from CRTC's cols (8 in 80-col mode, 16 with 1-pixel doubling in
  40-col).
- [x] **Text attributes from the 40-byte (col, attr) pair area**
  (per MAME pc8001.cpp). `getTextFrame().attrs` is now a
  `Uint16Array` packing colour-state in the high byte and
  decoration-state in the low byte. Each row reset to 0xE800
  (white text, no decoration), then walked: bit 3 set on an attr
  byte → it's a colour update (bits 7-5 = RGB); bit 3 clear → it's
  a decoration update (bit 5 lower-line, bit 4 upper-line, bit 2
  reverse, bit 1 blink, bit 0 secret). `getPixelFrame()` honours
  fg colour (DIGITAL_PALETTE), reverse video (paints the cell box
  in fg, then draws glyph "off" pixels in bg), and secret (skips
  the cell, graphics layer shows through). Blink is parsed but
  rendered as solid-on in static captures — the visual blink is
  a renderer concern (web canvas can toggle by frame count). Upper
  / lower line + semi-graphics still TODO.
- [x] **Web canvas renderer for the pixel frame**. The worker
  ships the 640×200 RGBA buffer from `getPixelFrame()` as a
  transferable `ArrayBuffer` (no structured-clone of the 512 KB
  payload at 60 Hz); the UI thread `putImageData`s it. Same
  composited frame the CLI writes via `--screenshot`. Replaces
  the earlier monospace-font text-only path that bypassed the
  font ROM, ignored graphics, and didn't honour attributes. CSS
  scales the natural 640×200 to 640×480 (4:3) with
  `image-rendering: pixelated` for crisp edges.
- [ ] **Pixel-accurate CRT controller (raster timing, text overlay)**.
  The μPD3301 stub consumes SET MODE / START DISPLAY correctly but
  doesn't generate scanline timing. `getPixelFrame` returns a
  graphics-only frame — the text layer composite (CRTC reads font
  ROM glyphs from TVRAM cells and overlays them at fixed cell
  positions) is still TODO.
- [ ] **400-line mode + analogue palette**. `getPixelFrame` only
  handles the 200-line digital-palette path today. mkII SR onwards
  has 4096-colour analogue palette (port 0x32 bit 5 = `PMODE_ANALOG`,
  programmed at port 0x54-0x5B); V2 mode bumps to 640×400 with
  doubled GVRAM. Both extend the same composite path.
- [ ] **YM2203 / YM2608 sound generation**. `YM2203.ts` latches
  register writes (0x44 = addr, 0x45 = data) but doesn't generate
  audio. Needs FM synth + SSG + per-channel mixer.
- [ ] **Real serial / cassette traffic** through the μPD8251 USART
  stubs. Three channels at 0x20/0xC0/0xC2 currently latch mode +
  command bytes and return idle status — enough for boot init
  not to stall.
- [ ] **Kanji ROM image**. The lookup at 0xE8-0xEF latches the
  16-bit address per bank but reads return 0xFF until a real ROM
  image is loaded.

### Tooling

- [x] **Web UI** — `yarn build:web` produces `web/app.js` +
  `web/worker.js`. Boot screen with variant + DIP picker writes
  ROMs to OPFS (md5 content-addressed); a top-level multi-file
  picker auto-routes uploads to descriptors by md5 then filename
  stem, and per-row inputs stay for explicit overrides;
  cross-variant detection picks up shared ROMs without
  re-upload. Boot spawns a Worker
  that owns the CPU loop and emits 60 Hz tick snapshots — each
  tick ships the composited 640×200 RGBA pixel frame
  (transferable), an ASCII fallback for the diagnostic pane, a
  typed `CPUSnapshot`, 16 disasm lines around PC, and a
  `DebugSnapshot` (breakpoints + RAM/port watches + call stack).
  UI `putImageData`s the pixel frame onto a 640×200 `<canvas>`
  (CSS-scaled to 480 px tall, pixel-aligned) plus Registers /
  Disassembly (with ●
  breakpoint + ► PC markers + per-row label headers) / Memory
  / Breakpoints / Watches / Stack / REPL panels. The REPL
  flows through the same `dispatch()` as the CLI debugger via
  a `setDebugWriter` callback. Keyboard input maps
  `KeyboardEvent.code` → `PC88Key` matrix when no form has
  focus. Symbol files persist in OPFS and feed disasm
  resolution; an "Import labels" panel takes one or more `.sym`
  uploads and merges them into the live tables, routing each
  file by `# md5:` header → filename stem → explicit scope.
  Native monospace font for now; a CG-ROM glyph atlas is
  deferred until the kanji ROM image lands. See "Web UI
  architecture" below for module layout + gotchas.
  Still open:
  - [ ] `localStorage` for breakpoint / watch persistence + panel
    layout preferences across reloads.
- [x] **End-to-end real-ROM smoke test**. `tests/machines/pc88-real-rom.test.ts`
  is gated on `PC88_REAL_ROMS=1` and runs four cases against the
  real mkI ROM image: (1) N-BASIC boots to the banner; (2) N-BASIC
  accepts a typed program — `10 print "hello world"` / `LIST` /
  `RUN` — through the keyboard matrix and produces the expected
  output; (3) N88-BASIC reaches the disk-files prompt; (4) N88
  answers the prompt (via mailbox poke; see below) and reaches the
  BASIC banner. ROMs go in `roms/` (gitignored) — see
  `src/machines/variants/mk1.ts` for filenames + md5s.
- [x] **Headless keyboard input via the matrix (N-BASIC path)**.
  Tests drive `Keyboard.pressKey(row, col)` and synchronise with
  the BIOS scan via the `IOBus.tracer` — `runUntilRowReadCount(row,
  N)` waits for the BIOS to read row N times so a key is observed
  across the debounce window. ASCII → matrix-position map +
  `pc88KeyFor(ch)` live in `tests/tools.ts`. Replaces the earlier
  fragile op-count timing.
- [x] **N88 disk-files prompt — past it via mailbox poke**. The
  real-ROM smoke test now answers the prompt and asserts the BASIC
  banner ("NEC N-88 BASIC Version 1.0", copyright, "Ok"). The full
  matrix-scan ISR path (RTC IRQ → ISR samples keyboard → queues
  ASCII into the BIOS mailbox) isn't wired — RTC IRQs aren't
  generated, and the BIOS's IM 2 vector table at 0xF300 is wiped
  before the prompt is reached anyway. Workaround: the test pokes
  ASCII directly into the BIOS's input mailbox at the head pointer
  stored at 0xE6CB. ROM-version-specific (works for the mkI N88
  ROM md5 verified by loadRoms).
- [ ] **RTC IRQ pump + keyboard ISR path**. Real-silicon-style
  keyboard input requires (a) a 600 Hz RTC IRQ source, (b) the BIOS
  IM 2 vector table at 0xF300 staying populated through the prompt
  (or pointing somewhere stable), and (c) the BIOS keyboard ISR
  reading the matrix. Today (a) and (b) are both missing — the
  BIOS sets up the table at boot then re-clears it around op
  124k for reasons we haven't reverse-engineered yet. Until this
  lands, headless tests use the mailbox-poke workaround above.

## Web UI architecture

```
┌─────────────────────────────┐  postMessage   ┌────────────────────┐
│ web/main.ts (UI thread)     │ ─────────────► │ web/worker.ts      │
│  panels + canvas + REPL     │ ◄───────────── │  PC88Machine       │
│  OPFS ROM/settings cache    │                │  DebugState + REPL │
└─────────────────────────────┘                └────────────────────┘
```

Worker owns the CPU loop. UI thread owns rendering + input.
Snapshots cross as plain JSON; the composited pixel frame and
memory-peek responses ride as transferable `ArrayBuffer`. The CLI
debugger's
`dispatch(line, ctx)` is the message protocol — every panel button
is sugar over typed REPL lines, and the on-page REPL gives access
to anything we don't build a button for.

```
src/
  chips/z80/
    symbols.ts                 # pure parse / serialise / mutate
    symbols-fs.ts              # node:fs load / save (Node-only)
  debug/
    debug.ts                   # dispatch + DebugState (browser-safe)
    debug-cli.ts               # runDebug + runScript (Node-only)
    debug-symbols-core.ts      # shared label-file logic (browser-safe)
    debug-symbols.ts           # fs + node:crypto backend (Node-only)
    debug-symbols-browser.ts   # OPFS + js-md5 backend
  machines/
    rom-loader-browser.ts      # in-memory map path
  md5.ts                       # MD5Sum-branded wrapper over js-md5
  web/
    main.ts                    # UI entry; spawns worker, renders ticks
    worker.ts                  # emulator worker; owns PC88Machine + run loop
    protocol.ts                # typed message union (inbound + outbound)
    canvas-renderer.ts         # CRTC chars → 8×16 cell canvas
    keymap.ts                  # KeyboardEvent.code → PC88Key
    panels.ts                  # Registers / Disasm / Memory / Breakpoints / Watches / Stack / REPL
    boot-screen.ts             # form + state
    opfs.ts                    # storage abstraction
web/
  index.html, app.css          # static page + styles
  app.js, worker.js            # esbuild output (gitignored)
```

Gotchas:

1. **`pc88.ts` has a `process.env.LOG_CPU` guard** that esbuild's
   tree-shaker can't drop because the surrounding function is
   reachable. The web bundle's `define` substitutes it for
   `false`. New `process.env.X` reads must be added there too —
   esbuild rejects a wholesale `process.env: "({})"`.

2. **`debug-symbols.ts` uses `node:fs` / `node:crypto`** at module
   top. The web esbuild config has an `onResolve` plugin that
   redirects every relative import of `./debug-symbols.js` to
   `debug-symbols-browser.ts` (esbuild's `alias` rejects relative
   paths, hence the plugin). Same redirect strategy applies if
   any other Node-fs-using module gets pulled in.

3. **OPFS handle types are hand-rolled** in `opfs.ts` and
   `debug-symbols-browser.ts` because the standard-lib
   `FileSystemDirectoryHandle` types aren't reachable through
   this tsconfig. If the typing gets awkward, consider adding
   `"DOM.AsyncIterable"` to `tsconfig.json`'s `lib`.

## Test harness notes

The SingleStepTests JSON cache lives under `tests/z80/data/`
(gitignored, ~960 MB when fully populated). Useful env vars:

```
Z80_OP=00          run only this filename ("00", "ed 40", "dd cb 00 06")
Z80_PREFIX=ed      run only this prefix (base|cb|dd|ed|fd|ddcb|fdcb)
Z80_SAMPLE=N|full  cases per opcode (default 25; "full" = all 1000)
Z80_IGNORE_REGS=r  comma list of register keys to skip in the diff
```

zexdoc/zexall binaries are fetched on first run from `anotherlin/z80emu`
and cached under `tests/programs/fixtures/` (also gitignored).

## License

UNLICENSED — see `package.json`. Frank Cringle's zexdoc/zexall binaries
are public-domain test programs from `anotherlin/z80emu`; they're
fetched at test time, not redistributed in this repo.
