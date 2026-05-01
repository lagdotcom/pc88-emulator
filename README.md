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

- FDC (μPD765a) and the `Disk` interface that abstracts D88 from it.
- Sub-CPU model (mkII+ has a second Z80 driving the FDC via the
  `μPD8255` PPI at 0xFC-0xFF; communicates through shared latches).
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
  continue / break / regs / chips / screen / dis / peek / poke /
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
```

`yarn pc88` accepts CLI flags (`yarn pc88 --help` for the full list):
`-m`/`--machine`, `--basic=n80|n88`, `--rom-dir`, `--max-ops`,
`--trace-io[=raw]`, `--raw-tvram`, `--log-file[=PATH]`,
`-d`/`--debug`, `--break=ADDR`, `--script=PATH`. Each non-debug flag
has an env-var fallback (`PC88_ROM_DIR`, `PC88_MAX_OPS`,
`PC88_TRACE_IO`, `PC88_RAW_TVRAM`, `LOG_TO_FILE`, `PC88_SCRIPT`) so
values you'd want to keep across runs can live in a `.env`. The
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
                      kanji, YM2203, calendar, beeper, irq, misc
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
    pc88-display.ts   text-frame capture + ASCII dump
    display-regs.ts   palette + layer-mask + plane-select register block
    debug.ts          interactive REPL debugger
    debug-symbols.ts  per-variant symbol-file routing
    rom-loader.ts     md5-validating fs ROM resolver
refs/             references for chip behaviour cross-referenced
                  during reverse-engineering — D88 format,
                  Z80 undocumented, MAME PC-8801 port handlers,
                  port-plan.md (gap analysis vs MAME)
tests/
  z80/              SingleStepTests harness
  programs/         hand-assembled programs + zexdoc runner +
                    IM 1 / IM 2 IRQ-acceptance tests
  chips/io/         per-chip I/O port unit tests (CRTC, DMAC, sysctrl)
  machines/         memory-map, synthetic-ROM boot, visible-region
                    rendering, runner / IRQ-mask gating
```

Disk formats are intended to live separately from the FDC behind a
`Disk` interface that exposes per-sector metadata (C/H/R/N, deleted
mark, CRC OK/error, density). The interface needs to land before the
FDC because flattening the format loses state the FDC depends on.

## TODO

Roughly ordered by what's blocking what.

### CPU

- [x] **Block-instruction repeat-iteration flags** — fully resolved.
  INIR/INDR/OTIR/OTDR (and CPIR/CPDR, LDIR/LDDR via the same
  PC.high logic) apply the 5 T-state PC-decrement fix-up to H and
  PF per David Banks's analysis (matching MAME's
  `block_io_interrupted_flags`). 1604/1604 opcodes × full 1000-case
  SingleStepTests pass.
- [x] **IM 2 acceptance**. `requestIrq(vector)` carries the data-bus
  byte; on accept the CPU reads PC from `(I << 8) | (vector & 0xFE)`.
  The runner asserts vector 0x00 for VBL. PC-88 BIOS programs IM 2
  early during init.
- [ ] **Interrupt acceptance: IM 0, NMI**. IM 0 (execute the byte on
  the data bus as an opcode — only the RST-38 case is reachable by
  the same vector path as IM 1) and NMI (vector 0x0066, ignores
  IFF1) are still TODO. No PC-88 source uses IM 0; NMI is unused on
  mkI but the FDD-IF on later models can drive it.
- [ ] **Run zexdoc/zexall to a clean exit** at least once and
  refresh the `APPROX_TOTAL_OPS` constants.
- [x] **Per-opcode switch dispatcher** — `ops.ts` is six giant
  switches (`dispatchBase` / `dispatchED` / `dispatchCB` /
  `dispatchDD` / `dispatchFD` / `dispatchIndexedCB`), one per
  prefix table. Throughput ~36 Mops/s on Windows V8; full
  zexdoc/zexall ~2.5 min each, both CRC-clean (incl. undocumented
  X/Y).
- [x] **Retire the MCycle table system** — done. The legacy
  closure-per-MCycle dispatcher and its compile / OpCode.execute /
  buildOpTable / buildCbTable / buildIndexedCbTable machinery are
  gone. ALU/flag/control helpers live in `alu.ts`, mnemonic tables
  for the disassembler / test harness in `mnemonics.ts`, and
  `ops.ts` is the only dispatcher. The `useDispatchBase`
  kill-switch and the `DISPATCH=table` harness override are gone.

### Machine layer

- [ ] **`Disk` interface** in `src/chips/` (or `src/core/`?). Tracks
  + per-sector metadata, density, deleted-mark, CRC status. D88
  parser bolts on top.
- [x] **`pc88.ts` factory** consuming `PC88Config` — `PC88Machine`
  wires the chip set, memory map, and I/O ports for mkI.
- [x] **`DipSwitchState` is a real shape** — `{ port30: u8, port31: u8 }`,
  required on `PC88Config`, with mkI/mkII/SR variants supplying their
  factory defaults. `SystemController` consumes them via constructor
  injection rather than hardcoding magic bytes.
- [ ] **`ROMManifest.disk` is still optional** — once at least one
  chip needs the disk ROM at runtime, lift the field to required.
- [ ] **Sub-CPU model** for mkII (`hasSubCpu: true`). Two Z80
  instances + a shared latch object; FDC connects to the sub-CPU
  bus, not the main bus. Design the IPC latch before writing FDC
  code so the FDC doesn't accidentally couple to the main bus.
- [x] **Real CRTC parameter parsing**. `μPD3301.ts` decodes all 5
  SET MODE parameter bytes per MAME's `upd3301_device::write`
  MODE_RESET handler: `dmaCharMode`, `charsPerRow`, `rowsPerScreen`,
  `charHeightLines`, `gfxMode`, `attrPairsPerRow`. Surfaced through
  `CRTCSnapshot` and the `chips` debugger command.
- [ ] **DMAC channel scheduling**. The `μPD8257` stub accepts the
  init handshake (channel address/count + mode-set) but doesn't
  actually perform character-pull transfers; once the renderer is
  real, the DMAC will need to drive TVRAM → CRTC fetches each
  scanline.

### Chips

- [ ] **μPD765a FDC** behind the Disk interface. Seek time, step
  rate, motor state, status-register timing — copy-protected disks
  rely on it. Don't ship until cycle-accurate.
- [ ] **Pixel-accurate CRT controller**. The μPD3301 stub consumes
  SET MODE / START DISPLAY / etc. correctly but doesn't generate
  raster timing or scanlines. Renderer + text+graphics composite
  blocks on this.
- [ ] **Graphics VRAM rendering** (3 planes, 16 KB per plane,
  switched in at 0xC000-0xEFFF via port 0x5C-0x5F).
- [ ] **Palette + analogue colour**. `display-regs.ts` latches
  port 0x52 (border/bg) + 0x54-0x5B (palette RAM) but doesn't
  feed a renderer yet. mkII SR onwards has the analogue palette
  (selectable via port 0x32 bit 5 / `PMODE_ANALOG`).
- [ ] **YM2203 / YM2608 sound generation**. `YM2203.ts` latches
  register writes (0x44 = addr, 0x45 = data) but doesn't generate
  audio. Needs FM synth + SSG + per-channel mixer.
- [x] **USART stub** (μPD8251). Three channels at 0x20/0xC0/0xC2
  with mode/command latching and idle status reads — enough for
  N88 boot init not to stall on the channel-1/-2 reset sequence.
  Real serial / cassette traffic still TODO.
- [x] **Kanji ROM lookup** (μPD3301 sister chip). 0xE8-0xEF
  latches the 16-bit address per bank; reads return 0xFF until a
  real kanji ROM image is loaded. Kanji rendering = renderer +
  ROM-image work.

### Tooling

- [x] **`build` script type-checks `src/machines/` errors** — the
  `DipSwitchState`/`dipSwitches`/`disk` cases above are now placeholders
  that compile cleanly. They still need real shapes (see machine layer
  TODOs).
- [x] **End-to-end real-ROM smoke test**. `tests/machines/pc88-real-rom.test.ts`
  is gated on `PC88_REAL_ROMS=1` and runs the mkI N-BASIC boot
  against the real ROM image, asserting the banner ("NEC PC-8001
  BASIC", "Copyright 1979 (C) by Microsoft", "Ok") appears in the
  CRTC+DMAC visible region. A second case asserts `--basic=n88`
  reaches CRTC/DMAC programming + IRQ-mask programming (it
  currently stalls there on the missing sub-CPU PPI handshake;
  tighten the assertion to require the N88 banner once sub-CPU
  emulation lands). ROMs go in `roms/` (gitignored) — see
  `src/machines/variants/mk1.ts` for filenames + md5s.
- [x] **N88-BASIC print path reaches TVRAM**. Root cause was the
  IRQ controller bit layout: real PC-88 wires port 0xE6 as
  `bit 0=RTC, bit 1=SOUND, bit 2=VBL` and the μPD8214 priority
  encoder emits IM 2 vector `2 × source` (RTC=0x00, SOUND=0x02,
  VBL=0x04). Our stub had bit 0 = VBL with vector 0x00. N88-BASIC
  programs mask=0x03 (RTC + SOUND) before populating its IM 2
  table, so under the wrong wiring every VBL pulse was accepted,
  the CPU read PC from `(0xF300)` (still all zeros), jumped to
  0x0000, and soft-reset mid-banner — looping forever in the
  TVRAM-clear LDIR. Fixed `IRQ_MASK` constants in
  `src/chips/io/irq.ts` and `VBL_IRQ_VECTOR` in
  `src/machines/pc88.ts`; the RAM hooks at 0xED42 / 0xED99 are
  user-replaceable hooks that are *meant* to be `C9` RET stubs
  by default (the RST 18h dispatch itself lives at ROM 0x0018,
  always installed). The previous diagnosis was a red herring.
  N80-BASIC banner now prints clean. N88-BASIC reaches its
  "How many files(0-15)?" disk prompt and stalls waiting for
  keyboard input — see next item.
- [ ] **N88 disk-files prompt needs keyboard input**. After the
  IRQ fix, `--basic=n88` boots all the way to "How many
  files(0-15)?" (the disk-config prompt that real N88-BASIC
  shows on disk-equipped models) and stalls. To reach the
  banner past this prompt the headless runner needs either: a
  way to feed key events into `Keyboard` (the matrix is wired
  but no input source is hooked up), or a `--no-disk` switch
  that programs the DIP bits to skip the prompt.

- [x] **`yarn dis` standalone disassembler**. Reads any raw ROM
  file, optionally with a `--base=ADDR` mount point so JR/CALL
  targets render in the right address space. Used to drive the
  N88 diagnosis above.
- [x] **mkI BASIC banner reaches TVRAM**. The N-BASIC banner ("NEC
  PC-8001 BASIC Ver 1.2", "Copyright 1979 (C) by Microsoft", "Ok")
  is now visible in the TVRAM dump.
- [x] **PC88TextDisplay reads the right layout**. Per MAME's
  `upd3301_device::dack_w`, the CRTC streams `charsPerRow` bytes
  (= 80) as **single-byte chars**, then `attrPairsPerRow * 2` (=
  40) attr-pair bytes — total 120 bytes/row matching the DMAC
  count. Software-side cell stride is selected by
  `sysctrl.cols80` (mirrors port 0x30 bit 0): 1 byte/cell in
  80-col mode (N88-BASIC), 2 bytes/cell in 40-col mode (N-BASIC,
  with chars at even offsets and attrs at odd). The "always
  2-byte cells" theory I had earlier was wrong — N-BASIC just
  uses the same 80-byte stream as a 40 × 2 layout.
- [x] **Visible region driven by CRTC + DMAC**. The on-screen image
  is whatever the μPD3301 (rows × cols, programmed via SET MODE
  cmd `0x00`-`0x1F` — top 3 bits dispatch the command, low 5 bits
  are flags) tells it to lay out from the address the μPD8257
  channel 2 streams in. `toASCIIDump()` now respects both, so it
  shows only the visible region — not BASIC's TVRAM scratch
  (token tables, line buffers, attribute pair tables). The full
  4 KB is still dumped via `rawTVRAMDump()` for diagnostics.
- [x] **Stub IRQ mask register (0xE6)**. VBL pulses now respect the
  per-bit mask — when the BIOS clears bit 0 during init, the runner
  flips the status bit but doesn't assert /INT.
- [x] **Stub low-traffic ports** 0x09 (read) / 0xE7 / 0xF8 (write).
  Quietly idle so they don't pollute diagnostics.

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
