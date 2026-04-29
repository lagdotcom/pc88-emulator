# pc88-emulator

A TypeScript emulator for the NEC PC-8801 family. Initial target is the
PC-8801 mkII SR — accurate enough to boot and run simple disk-based
RPGs. Later models (FH/MH and the VA branch) are planned via the
config-driven machine wiring; the chip layer is shared.

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
- Sub-CPU model (mkII has a second Z80 driving the FDC; communicates
  through shared latches).
- Pixel-accurate CRT controller (currently a parameter-eating stub),
  graphics VRAM rendering, analogue palette.
- PSG / YM2203 / YM2608 sound (beeper toggles are counted, not played).
- IM 0 / NMI interrupt acceptance — IM 1 + IM 2 + a 60 Hz VBL pump
  work, IM 0 + NMI are TODO.

Working enough for first-light boot:

- mkI machine factory (`PC88Machine` in `src/machines/pc88.ts`) that
  wires the Z80, memory map, and I/O port stubs from `PC88Config`.
- Pre-resolved 256-slot `IOBus` (replaces `MemoryBus` for the I/O
  side; the per-port dispatch is one array load + one call).
- `PC88MemoryMap` with bank-switched 4 KB pages: BASIC ROM,
  E0 extension, TVRAM window at 0xF000, GVRAM plane window at 0xC000.
- Chip stubs (`SystemController`, `Ppi8255`, `Crtc3301`, `Dmac8257`,
  `Calendar`, `Beeper`) with just enough state-machine to keep the
  BIOS init path advancing.
- ROM loader with size + md5 validation against the descriptors in
  `src/machines/variants/`.
- Display capture (`PC88TextDisplay.toAsciiDump()`) so headless tests
  can assert against TVRAM contents.

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
```

`yarn pc88` reads ROMs from `roms/` (override with `PC88_ROM_DIR`).
The required mkI files are `mkI-n80.rom`, `mkI-n88.rom`, `mkI-e0.rom`
with the md5s declared in `src/machines/variants/mk1.ts`. The `roms/`
directory is gitignored so dumps stay local.

The dev environment is Windows, so `test:zex` goes through `cross-env`
to set `ZEX=1` portably; any new env-vared scripts should follow the
same pattern.

## Architecture

```
src/
  chips/            silicon-level emulation, no cross-knowledge
    z80/              CPU, register file, opcode tables
    io/               sysctrl, ppi-8255, crtc-3301, dmac-8257,
                      calendar, beeper (mostly stubs at first light)
  core/             buses + shared infrastructure
    MemoryBus.ts      providers + fast-path single-array memory bus
    IOBus.ts          pre-resolved 256-slot port bus (PC-88 I/O)
  machines/         machine wiring (config-driven, not subclassed)
    config.ts         PC88Config / VideoConfig / DiskConfig / ...
    variants/         data-only model definitions (mkI, mkII, mkII-SR)
    pc88.ts           PC88Machine factory + runMachine() VBL pump
    pc88-memory.ts    PC88MemoryMap, paged ROM/RAM/VRAM banking
    pc88-display.ts   text-frame capture + ASCII dump
    rom-loader.ts     md5-validating fs ROM resolver
tests/
  z80/              SingleStepTests harness
  programs/         hand-assembled programs + zexdoc runner +
                    IM 1 IRQ-acceptance test
  machines/         synthetic-ROM boot test, memory-map unit tests
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
- [ ] **`PC88Config` cleanup**: `DipSwitchState` is currently a
  `Record<string, never>` placeholder, `dipSwitches` is optional,
  `ROMManifest.disk` is optional. Replace with real DIP-switch
  state once any chip needs to read it.
- [ ] **Sub-CPU model** for mkII (`hasSubCpu: true`). Two Z80
  instances + a shared latch object; FDC connects to the sub-CPU
  bus, not the main bus. Design the IPC latch before writing FDC
  code so the FDC doesn't accidentally couple to the main bus.
- [ ] **Real CRTC parameter parsing**. The current `Crtc3301` stub
  guesses parameter counts from a small table and falls back to 5;
  this is enough for first light but the actual μPD3301 command set
  has 8 commands with specific parameter layouts (Reset / Start /
  Set Mode / Load Cursor / Reset Counters / Read Light Pen /
  Interrupt Mask / Sync). Replace before driving a real renderer.
- [ ] **DMAC channel scheduling**. The `Dmac8257` stub accepts the
  init handshake but doesn't actually perform character-pull
  transfers; once the renderer is real, the DMAC will need to drive
  TVRAM → CRTC fetches each scanline.

### Chips

- [ ] **μPD765a FDC** behind the Disk interface. Seek time, step
  rate, motor state, status-register timing — copy-protected disks
  rely on it. Don't ship until cycle-accurate.
- [ ] **CRT controller** + text VRAM + graphics VRAM (3 planes,
  16 KB per plane on the SR).
- [ ] **Palette + analogue colour** (mkII SR introduces analogue
  palette).
- [ ] **YM2203 (OPN)** for sound on the SR. PSG-only beeper for
  earlier models; YM2608 for FH/MA.
- [ ] **Calendar clock, USART, DMAC** (μPD8253, μPD8255).

### Tooling

- [x] **`build` script type-checks `src/machines/` errors** — the
  `DipSwitchState`/`dipSwitches`/`disk` cases above are now placeholders
  that compile cleanly. They still need real shapes (see machine layer
  TODOs).
- [ ] **End-to-end real-ROM smoke test**. Gate behind `PC88_ROM_DIR`
  pointing at a real mkI ROM dump and assert the BASIC banner appears
  in `display.toAsciiDump()`. Don't check ROMs into the repo.
- [x] **mkI BASIC banner reaches TVRAM**. The N-BASIC banner ("NEC
  PC-8001 BASIC Ver 1.2", "Copyright 1979 (C) by Microsoft", "Ok")
  is now visible in the TVRAM dump.
- [x] **PC88TextDisplay reads the right layout**. The actual mkI
  layout is 25 rows × 160 bytes, each cell 2 bytes (char at even
  offset, attribute at odd). The earlier "stride 120, 80 chars
  contiguous" theory was wrong — reading the attribute as a char
  produced the "char NUL char NUL" pattern in the dump. Display
  now reads chars at `row*160 + col*2` and attrs at `+col*2 + 1`.
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
