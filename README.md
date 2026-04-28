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
- CRT controller, text/graphics VRAM, palette.
- PSG / YM2203 / YM2608 sound.
- Interrupt acceptance (IM 0/1/2, NMI, request-line wiring).
- Machine factory (`PC88Config` → wired-up chip set + memory map).

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
```

The dev environment is Windows, so `test:zex` goes through `cross-env`
to set `ZEX=1` portably; any new env-vared scripts should follow the
same pattern.

## Architecture

```
src/
  chips/            silicon-level emulation, no cross-knowledge
    z80/              CPU, register file, opcode tables
    ...
  core/             buses + shared infrastructure
    MemoryBus.ts
  machines/         machine wiring (config-driven, not subclassed)
    config.ts         PC88Config / VideoConfig / DiskConfig / ...
    variants/         data-only model definitions (mkI, mkII, mkII-SR)
    pc88.ts           factory (TODO)
tests/
  z80/              SingleStepTests harness
  programs/         hand-assembled programs + zexdoc runner
```

Disk formats are intended to live separately from the FDC behind a
`Disk` interface that exposes per-sector metadata (C/H/R/N, deleted
mark, CRC OK/error, density). The interface needs to land before the
FDC because flattening the format loses state the FDC depends on.

## TODO

Roughly ordered by what's blocking what.

### CPU

- [ ] **Block-instruction repeat-iteration flags**. The non-repeating
  CPI/CPD/INI/IND/OUTI/OUTD all pass at any sample size. The
  repeating variants — CPIR, CPDR, INIR, INDR, OTIR, OTDR — have
  edge cases the default `Z80_SAMPLE=25` misses but
  `Z80_SAMPLE=200 yarn test:z80` (and zexdoc's `cpd<r>` test) catch:
  - LDIR / LDDR pass in zexdoc, so the LD repeat path is fine.
  - CPIR / CPDR fail at higher sample sizes despite the X/Y
    rule (`(PC+1).high`) and WZ rule (`PC + 1` after `PC -= 2`)
    looking correct. Suspect a flag at the loop boundary
    (the dual `BC != 0 AND result != 0` exit condition is what
    distinguishes them from LDIR/LDDR).
  - INIR / INDR / OTIR / OTDR fail on H and PV during repeat. X/Y
    and WZ are correct; H/PV follow undocumented hardware quirks
    that haven't been matched against any simple formula over
    `(B_post, C_flag, base, value)`. Empirical fitting against
    test data tops out around 941/995. Cracking these needs a
    known-correct reference (FUSE / mame / Patrik Rak's z80core).
- [ ] **zexdoc/zexall failures**. Both fail the same families, so
  these are documented-flag bugs (zexdoc masks X/Y from its CRC).
  The `cpd<r>` failure is the same root cause as the CPIR/CPDR
  SingleStepTests failures above — track it there. Remaining:
  - `<inc,dec> (hl)` and `<inc,dec> (<ix,iy>+1)` — register form
    of INC/DEC passes, so the bug is in the memory R-M-W
    surrounding `inc8`/`dec8`, not the flag math itself. Suspect
    spurious WZ updates: `INC (HL)` should leave WZ alone,
    `INC (IX+d)` should leave WZ at IX+d.
  - `<rrd,rld>` — flag mismatch. WZ rule (`WZ = HL + 1`) is
    correct; likely a subtle F-flag bug.

  Reproduce in the SingleStepTests harness with
  `Z80_OP="<op>" Z80_SAMPLE=full yarn test:z80` (or `Z80_SAMPLE=200`
  if a smaller window is enough) to surface the exact cases.
- [ ] **Interrupt acceptance**. IM 0/1/2 dispatch, NMI vector, edge-
  vs level-triggered handling, and the `iff1 && !eiDelay` gate on
  the M1 boundary. The Z80 has all the pieces; nothing acts as the
  request source yet.
- [ ] **Run zexdoc/zexall to a clean exit** at least once and
  refresh the `APPROX_TOTAL_OPS` constants.
- [ ] **Extend the inlined dispatch switch in `runOneOp`**. The
  dispatcher has been progressively unwrapped: each opcode's
  M-cycle list is pre-composed into a length-specialised
  `execute(cpu)` function at table-build time with no-branch and
  abortable variants; the universal M1 fetch is hoisted into
  `runOneOp`; `MemoryBus` exposes a fast-path `Uint8Array` for
  single-provider RAM; and a peephole switch at the top of
  `runOneOp` inlines a small set of unprefixed hot-path opcodes
  (NOP, JR, DJNZ, INC/DEC rr, ADD HL,DE, HALT) so they don't pay
  the indirect call into `inst.execute`. `tests/programs/bench.ts`
  numbers (Linux V8, warm):

  ```
                     baseline   now      gain
    NOP×16 loop      28         73       +161%
    ADD HL,DE loop   12         29       +142%
    LDIR 256 bytes   7          10       +43%
  ```

  The peephole only handles ~10 ops; everything else still goes
  through the table. Extending it to cover the full 1600-op set
  (256 base + 256 ED + 256 CB + 256 DD + 256 FD + 256 DDCB + 256
  FDCB) is the natural next step — most can be code-generated from
  the same factory pattern `buildOpTable` already uses, but
  emitted as raw `case` bodies rather than `MCycle` arrays. Done
  fully, this is the 50-100 Mops/s pattern of mature Z80
  emulators and would collapse a BIOS boot from tens of seconds
  to a couple.

### Machine layer

- [ ] **`Disk` interface** in `src/chips/` (or `src/core/`?). Tracks
  + per-sector metadata, density, deleted-mark, CRC status. D88
  parser bolts on top.
- [ ] **`PC88Config` cleanup**: `DipSwitchState` type referenced
  but never declared (`src/machines/config.ts:11`); `dipSwitches`
  required on `PC88Config` but missing from every variant; `ROMManifest`
  requires `disk` but mk2 omits it. These are real tsc errors today.
- [ ] **`pc88.ts` factory** that consumes `PC88Config` and wires
  up the chip set, memory regions, and I/O ports.
- [ ] **Sub-CPU model** for mkII (`hasSubCpu: true`). Two Z80
  instances + a shared latch object; FDC connects to the sub-CPU
  bus, not the main bus. Design the IPC latch before writing FDC
  code so the FDC doesn't accidentally couple to the main bus.

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

- [ ] **`build` script type-checks `src/machines/` errors** —
  currently fails on the pre-existing `DipSwitchState` issues. Fix
  these as part of the machine-layer cleanup above.

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
