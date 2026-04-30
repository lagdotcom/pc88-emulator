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
- SingleStepTests/z80 harness running 1604 opcodes × 25 sample cases
  = 40,100 hardware-traced test cases per `yarn test:z80`. 40,023
  currently pass; the 77 failures are all in the undocumented H/PV
  flags during INIR/INDR/OTIR/OTDR repeating iterations.
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
  label / portlabel / quit. Per-ROM, per-variant-RAM, and per-variant
  port symbol files (`syms/<rom-id>.sym`, `syms/<variant>.ram.sym`,
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
`-d`/`--debug`, `--break=ADDR`. Each non-debug flag has an env-var
fallback (`PC88_ROM_DIR`, `PC88_MAX_OPS`, `PC88_TRACE_IO`,
`PC88_RAW_TVRAM`, `LOG_TO_FILE`) so values you'd want to keep
across runs can live in a `.env`. The required mkI ROM files are
`mkI-n80.rom`, `mkI-n88.rom`, `mkI-e0.rom` with md5s declared in
`src/machines/variants/mk1.ts`. The `roms/` directory is gitignored
so dumps stay local.

`yarn pc88 --debug` drops into an interactive REPL before any
instructions execute. Commands: step / next (step-over) /
continue [cycles] / break / unbreak / breaks / regs / chips /
screen (renders the live CRTC+DMAC visible region) / dis [count] /
peek / peekw / poke / label / unlabel / labels / portlabel /
unportlabel / quit / help. Initial breakpoints can be set with
`--break=ADDR` (repeatable). The `chips` command renders a
machine-wide snapshot — the same plumbing intended to feed disk
savestates when those land. Disassembly + label/portlabel commands
read and write the per-ROM / RAM / port symbol files under `syms/`.

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

- [ ] **zexdoc/zexall failures (table dispatcher only)**. The
  table-driven dispatch path fails four CRC families in both zexdoc
  and zexall: `cpd<r>`, `<inc,dec> (hl)`, `<inc,dec> (<ix,iy>+1)`,
  and `<rrd,rld>`. The same workload runs cleanly on the ops2
  giant-switch dispatcher (see perf TODO below), so the bugs are
  somewhere in the MCycle composition or closure layer rather than
  the underlying flag math the helpers compute. Reproduce with
  `Z80_OP="<op>" Z80_SAMPLE=full yarn test:z80` (or
  `Z80_SAMPLE=200`); they appear in CPIR/CPDR/INIR/OTIR/INDR/OTDR
  too. Diagnosing the table path is no longer urgent now that ops2
  is correct end-to-end.

- [x] **Block-instruction repeat-iteration flags** — fixed when
  running through ops2; remaining 77 SingleStepTests failures on
  the table path are documented above.
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
- [x] **Performance: per-opcode switch dispatcher** — landed as
  `ops2.ts`, six dispatchers (`dispatchBase` / `dispatchED` /
  `dispatchCB` / `dispatchDD` / `dispatchFD` / `dispatchIndexedCB`),
  one per prefix table. **Default-on** as of validation against
  Frank Cringle's full exerciser:
  - **zexdoc**: all CRC sections clean.
  - **zexall**: all CRC sections clean (this is the documented +
    undocumented X/Y test, the stronger of the two).
  - Throughput: ~36 Mops/s on Windows V8 vs ~8 Mops/s on the legacy
    table path — a ~4.5× speedup, full zexdoc run ~2.5 min vs
    ~12 min.

  `cpu.useDispatchBase` is the kill-switch; flip to `false` (or
  set `DISPATCH=table` in the test harness env) to run the legacy
  table path for A/B comparison. The legacy path still fails four
  CRC families in zexdoc — `cpd<r>`, `<inc,dec> (hl)`, `<inc,dec>
  (<ix,iy>+1)`, `<rrd,rld>` — and the CPIR/CPDR/INIR/OTIR/INDR/OTDR
  block-flag failures appear there at higher SingleStepTests sample
  sizes. Both sets of bugs evaporate on ops2.

- [ ] **Retire the MCycle table system in `ops.ts`**. Now that
  ops2 is default and validated, `compile()`, `OpCode.execute`,
  `MCycle`, and the `buildOpTable` / `buildCbTable` /
  `buildIndexedCbTable` factories have no live consumers. They
  remain in the tree as the A/B fallback (`useDispatchBase=false`)
  and as the home of the shared helpers ops2 imports
  (`do_add_a`, `inc8`, etc.). Once the surrounding chips (CRT,
  FDC, sub-CPU) are wired up enough to validate via a real BIOS
  boot, lift the helpers into a small `alu.ts` and delete
  everything else in `ops.ts`.

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
- [ ] **N88-BASIC banner reaches TVRAM**. Boot now runs to the
  banner-print code path. Diagnosis via `yarn dis` against the
  N88 ROM:
  - The N88 banner / "Bytes free" / "Copyright" strings live at
    ROM 0x79B2-0x79FA. Print code is at 0x7968 (`LD HL,0x79BE` /
    `CALL 0x5550`).
  - The print routine at 0x5550 touches port 0x71 (secondary ROM
    bank — our handler is a logging no-op, may need real
    behaviour) and dispatches char output via `RST 18h`.
  - `RST 18h` jumps through `CALL (0xED42)` (a RAM-resident hook
    the BIOS installs during init) and `JP 0x5925` (ROM print
    handler). 0x5925 in turn checks `(0xEC88)` and may take an
    alternate "console redirected" path at 0x4B52.
  - Net: the print path depends on multiple RAM hooks that the
    BIOS installs early, plus possibly the sub-CPU PPI for actual
    cell delivery. Diagnosing further means tracing what the BIOS
    writes to those RAM cells (0xEC88 / 0xED42 / 0xED99 / 0xE64C)
    and at what point 0x5925 takes the "actual print to TVRAM"
    branch (jump-target 0x59A5) vs the alternate.
  Plumbing for switching BASICs is solid; what remains is the
  sub-CPU + RAM-hook init.

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
