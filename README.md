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
yarn web                 # esbuild watch for the browser bundle
yarn build:web           # tsc -noEmit + production browser bundles to web/{app,worker}.js
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

- [ ] **Interrupt acceptance: IM 0, NMI**. IM 0 (execute the byte on
  the data bus as an opcode — only the RST-38 case is reachable by
  the same vector path as IM 1) and NMI (vector 0x0066, ignores
  IFF1) are still TODO. No PC-88 source uses IM 0; NMI is unused on
  mkI but the FDD-IF on later models can drive it.
- [ ] **Run zexdoc/zexall to a clean exit** at least once and
  refresh the `APPROX_TOTAL_OPS` constants.

### Machine layer

- [ ] **`Disk` interface** in `src/chips/` (or `src/core/`?). Tracks
  + per-sector metadata, density, deleted-mark, CRC status. D88
  parser bolts on top.
- [ ] **`ROMManifest.disk` is still optional** — once at least one
  chip needs the disk ROM at runtime, lift the field to required.
- [ ] **Sub-CPU model** for mkII (`hasSubCpu: true`). Two Z80
  instances + a shared latch object; FDC connects to the sub-CPU
  bus, not the main bus. Design the IPC latch before writing FDC
  code so the FDC doesn't accidentally couple to the main bus.
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
  ROMs to OPFS (md5 content-addressed); cross-variant detection
  picks up shared ROMs without re-upload. Boot spawns a Worker
  that owns the CPU loop and emits 60 Hz tick snapshots — each
  tick ships the CRTC chars buffer (transferable), an ASCII
  fallback, a typed `CPUSnapshot`, 16 disasm lines around PC,
  and a `DebugSnapshot` (breakpoints + RAM/port watches + call
  stack). UI renders an 8×16 cell `<canvas>` (480 px tall,
  pixel-aligned) plus Registers / Disassembly (with ●
  breakpoint + ► PC markers + per-row label headers) / Memory
  / Breakpoints / Watches / Stack / REPL panels. The REPL
  flows through the same `dispatch()` as the CLI debugger via
  a `setDebugWriter` callback. Keyboard input maps
  `KeyboardEvent.code` → `PC88Key` matrix when no form has
  focus. Symbol files persist in OPFS and feed disasm
  resolution. Native monospace font for now; a CG-ROM glyph
  atlas is deferred until the kanji ROM image lands. See "Web
  UI architecture" below for module layout + gotchas.
  Still open:
  - [ ] `localStorage` for breakpoint / watch persistence + panel
    layout preferences across reloads.
- [x] **End-to-end real-ROM smoke test**. `tests/machines/pc88-real-rom.test.ts`
  is gated on `PC88_REAL_ROMS=1` and runs the mkI N-BASIC boot
  against the real ROM image, asserting the banner ("NEC PC-8001
  BASIC", "Copyright 1979 (C) by Microsoft", "Ok") appears in the
  CRTC+DMAC visible region. A second case runs `--basic=n88` to the
  "How many files(0-15)?" disk-config prompt and asserts the prompt
  string in the visible region; boot stalls past that on keyboard
  input — `Keyboard.pressKey(row, col)` is wired now (the web UI
  uses it via `src/web/keymap.ts`), but the headless test doesn't
  drive the matrix yet. Once it does, tighten the assertion to
  require the N88 banner past the prompt. ROMs go in `roms/`
  (gitignored) — see `src/machines/variants/mk1.ts` for filenames
  + md5s.
- [ ] **N88 disk-files prompt needs keyboard input**. After the
  IRQ fix, `--basic=n88` boots all the way to "How many
  files(0-15)?" (the disk-config prompt that real N88-BASIC
  shows on disk-equipped models) and stalls. To reach the
  banner past this prompt the headless runner needs either: a
  way to feed key events into `Keyboard` (the matrix is wired
  but no input source is hooked up), or a `--no-disk` switch
  that programs the DIP bits to skip the prompt.

## Web UI architecture

```
┌─────────────────────────────┐  postMessage   ┌────────────────────┐
│ web/main.ts (UI thread)     │ ─────────────► │ web/worker.ts      │
│  panels + canvas + REPL     │ ◄───────────── │  PC88Machine       │
│  OPFS ROM/settings cache    │                │  DebugState + REPL │
└─────────────────────────────┘                └────────────────────┘
```

Worker owns the CPU loop. UI thread owns rendering + input.
Snapshots cross as plain JSON; CRTC chars buffers and memory-peek
responses ride as transferable `ArrayBuffer`. The CLI debugger's
`dispatch(line, ctx)` is the message protocol — every panel button
is sugar over typed REPL lines, and the on-page REPL gives access
to anything we don't build a button for.

```
src/
  chips/z80/
    symbols.ts                 # pure parse / serialise / mutate
    symbols-fs.ts              # node:fs load / save (Node-only)
  machines/
    debug.ts                   # dispatch + DebugState (browser-safe)
    debug-cli.ts               # runDebug + runScript (Node-only)
    debug-symbols-core.ts      # shared label-file logic (browser-safe)
    debug-symbols.ts           # fs + node:crypto backend (Node-only)
    debug-symbols-browser.ts   # OPFS + js-md5 backend
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
