# CLAUDE.md

Guide for future Claude sessions working on this repo.

## Before starting any work

Read the **TODO list in `README.md`** first — that's the canonical
source for what's open, what's blocked on what, and the rough order
to tackle things in. When you finish a piece of work and are about
to commit, update the TODO list in the same commit:

- Tick off (`- [x]`) items that are now done.
- Add new items the work surfaced (e.g. a hardware quirk uncovered
  during testing, a refactor a feature now obviously wants).
- Reword items whose scope changed.

Treat README.md as part of the deliverable, not separate
documentation. A commit that lands a feature without updating the
TODO list is incomplete.

## After debugging: capture findings in symbol files

When debugging surfaces useful labels — a routine entry point you
worked out, a RAM cell whose role became clear, a port quirk — write
those into the matching `syms/*.sym` file in the same commit. It's
cheaper than re-deriving the same address next time, and the
fuzzy-resolver already turns `name+N` into useful disassembly hints
for nearby instructions. Three files per variant exist for routing:
per-ROM `syms/<rom-id>.sym` (e.g. `mkI-n88.sym`, `mkI-disk.sym`),
per-variant RAM `syms/<variant>.ram.sym`, per-variant ports
`syms/<variant>.port.sym`. The debugger has `label` /
`portlabel` / `unlabel` commands that mutate these files in place;
prefer those for one-off labels mid-session and edit the files
directly when you've got several to add. See the existing files for
the canonical comment style.

## What this is

PC-88 emulator written in TypeScript. Goal: PC-8801 mkII SR support first,
accurate enough to run simple RPGs, with FH/MH expansion later. Heavily
test-driven on the Z80 side; the rest of the machine (FDC, video, sub-CPU,
sound) is mostly unbuilt.

## Architecture intent

- `src/chips/` — silicon-level emulation. Each chip module knows about
  itself only; chips never reach across to each other. The Z80 lives
  under `chips/z80/`; the PC-88 I/O surface chips live under
  `chips/io/`:
    - `sysctrl` — system controller / gate-array (DIP, ROM banks,
      EROM gating, status, beeper strobe, EROM bank, text window)
    - `μPD3301` — CRTC (text controller; 80×20 mode programming)
    - `μPD8257` — DMAC (channel 2 streams TVRAM to CRTC)
    - `μPD8251` — USART (3 channels: CMT + RS-232 ch.1/ch.2)
    - `keyboard` — 16 read-only key-matrix rows at 0x00-0x0F
    - `kanji` — kanji-ROM lookup at 0xE8-0xEF (2 banks)
    - `YM2203` — OPN sound chip (mkII SR onwards; 0x44-0x45)
    - `irq`, `calendar`, `beeper`, `misc` — small stubs
  The I/O chips are still mostly stubs at first-light scope — they
  accept the BASIC ROM init writes and return idle status reads, no
  rendering or audio yet. Anything stubbed-but-not-implemented logs
  its writes at warn-level (with a `(stub)` suffix) so they stay
  visible in the trace.
- `src/core/` — buses and shared infrastructure. `MemoryBus` is the
  multi-provider memory bus with a fast path for the single-array
  case. `IOBus` is the 256-slot pre-resolved I/O port bus used by the
  Z80's `io` parameter (replaced `MemoryBus` for I/O — the table is
  always full, dispatch is one array load + one call). PC-88 I/O is
  decoded on the low 8 bits of the port; chip stubs ignore the upper
  byte that `IN A,(n)` / `OUT (C),r` put on the bus.
- `src/machines/` — wiring. `pc88.ts` exports `PC88Machine` (a real
  factory consuming `PC88Config` + `LoadedROMs` and instantiating
  the Z80, memory map, IOBus, and chip stubs) plus `runMachine()`,
  which pumps a 60 Hz VBL onto `Z80.requestIrq()` while running.
  `pc88-memory.ts` is the bank-switched memory map (paged at 4 KB
  granularity; subarray views into ROM/RAM/VRAM). `pc88-display.ts`
  is the frame-capture interface (`getTextFrame()` works today,
  `getPixelFrame()` returns null until graphics are implemented).
  `display-regs.ts` is the palette/layer-mask/plane-select register
  block (in-gate-array; not a separate chip). `rom-loader.ts`
  resolves `ROMDescriptor.id` to `roms/${id}.rom`, validates the
  size, and md5-checks against the descriptor (md5s are populated
  for mkI in `variants/mk1.ts`; other variants have md5s for ROMs
  the user has dumped locally and `"todo-md5"` placeholders for
  the rest). Models are config-driven (`PC88Config` in
  `machines/config.ts`); variants under `machines/variants/` are
  data, not subclasses. Twelve variants modelled: mkI / mkII / SR /
  FR / MR / FH / MH / FA / MA / MA2 (mkII TR, MC, FE/FE2, and the
  PC-88 VA family are explicitly out of scope).
- Disk formats will live separately from the FDC behind a `Disk`
  interface (not yet written — design before implementing the FDC).

## Build / run / test

```
yarn dev                 # esbuild watch
yarn build               # tsc -noEmit + esbuild production bundle
yarn test                # vitest (full suite)
yarn test:z80            # SingleStepTests Z80 harness only
yarn test:programs       # hand-assembled program tests (fast)
yarn test:zex            # Frank Cringle's zexdoc.com (slow; sets ZEX=1)
yarn zex zexdoc          # standalone zex runner with streamed output
yarn zex zexall          # same, all-behaviour variant
yarn pc88                # boot mkI N-BASIC, dump TVRAM after maxOps
```

`yarn pc88` reads ROMs from `roms/` (override with `PC88_ROM_DIR`).
The required mkI files have ids declared in `src/machines/variants/mk1.ts`
(`mkI-n80`, `mkI-n88`, `mkI-e0`, etc.) — drop them under `roms/` as
`<id>.rom`; the loader hard-fails on size or md5 mismatch.

`test:zex` uses `cross-env` so the `ZEX=1` env var works on both
POSIX and Windows shells. The dev environment is Windows; if you add
new scripts that need an env var, route them through `cross-env`.

The same applies to **any command line you write for the user to
copy-and-paste** — PR descriptions, test plans, README snippets,
chat messages telling them how to repro something. The bare
`FOO=bar yarn x` POSIX syntax doesn't work in Windows `cmd.exe`,
so always prefix with `cross-env` (or `npx cross-env`) when an env
var is involved:

```
cross-env PC88_REAL_ROMS=1 yarn test
npx cross-env Z80_SAMPLE=full yarn test:z80
```

`-noEmit`/-style flags and pure `yarn ...` commands are fine
unprefixed.

The Z80 harness fetches per-opcode JSON test cases from
[SingleStepTests/z80](https://github.com/SingleStepTests/z80) on first run
and caches them under `tests/z80/data/v1/` (gitignored — they total
~960 MB across all 1604 files when fully populated). Useful env vars:

```
Z80_OP=00          run only this filename (e.g. "00", "ed 40", "dd cb __ 46")
Z80_PREFIX=ed      run only this prefix (base|cb|dd|ed|fd|ddcb|fdcb)
Z80_SAMPLE=N|full  cases per opcode (default 25; "full" = all 1000)
Z80_IGNORE_REGS=r,ei  comma list of register keys to skip in the diff
```

After a run vitest writes a JSON report to `out/test-output.json` plus an
HTML report under `out/test-html/`. Both are gitignored. The Python
snippets used to bucket failures by opcode and reason are inline in earlier
session transcripts; they're worth re-using rather than rewriting.

## Z80 emulation model

The dispatcher is six per-prefix giant `switch` blocks in
`src/chips/z80/ops.ts` — one each for unprefixed, ED, CB, DD, FD,
and DDCB/FDCB. Each case inlines the per-opcode work directly
against the `Z80` instance: register and memory accesses are direct
property loads, no closure-per-MCycle layer, no `inst.execute(this)`
indirect call. ALU + flag helpers live in
`src/chips/z80/alu.ts` (`do_add_a`, `inc8`, `do_io_block_flags`,
`scf`, `prefix_ed`, …) and are imported into the dispatchers.

`Z80.runOneOp()` runs the universal M1 work (read OP, advance PC,
incR, charge 4 t-states), then dispatches by `this.prefix?.type`.
DDCB/FDCB are the exception — by the time we reach the dispatch
the prefix has already been resolved to `{type:"DDCB",...}` with
the displacement parked in WZ, and what remains is the operation
byte read as MR (not M1) on real silicon, so the DDCB/FDCB cases
account their own cycles.

Mnemonic strings live separately in `src/chips/z80/mnemonics.ts`:
seven tables (`opCodes`, `edOpCodes`, `cbOpCodes`, `ddOpCodes`,
`fdOpCodes`, `ddCbOpCodes`, `fdCbOpCodes`) of `{code, mnemonic}`
records, consumed by the disassembler and the test harness. The
HL/IX/IY substitutions (Sean Young's H/L rule) are applied through
the same `RegSet`-driven factory functions there, kept in table form
because hand-writing 1604 mnemonics with the substitution corner
cases would be error-prone.

### RegSet pattern (mnemonics)

`opCodes`, `ddOpCodes`, and `fdOpCodes` are all generated by the
same `buildOpTable(set: RegSet)` factory in `mnemonics.ts`, where
`RegSet` describes the substitution applied to opcodes that touch
HL/H/L/(HL):

```ts
interface RegSet {
  rp: "HL" | "IX" | "IY";   // active 16-bit pair
  rh: "H" | "IXH" | "IYH";  // its high half
  rl: "L" | "IXL" | "IYL";  // its low half
  addr: "hl" | "ix-d" | "iy-d";
}
```

`buildCbTable(HL_SET)` produces `cbOpCodes`. `buildIndexedCbTable(set)`
produces `ddCbOpCodes` (with `IX_SET`) and `fdCbOpCodes` (with
`IY_SET`); DDCB/FDCB always operate on `(IX+d)` / `(IY+d)` so
`HL_SET` is rejected. The indexed builder also surfaces the
undocumented "register copy" side effect in mnemonics: for
non-(HL) target slots the modified byte is also written into the
named register, e.g. `RES 4,(IX+d),B`. `BIT b,(IX+d)` ignores the
slot — every BIT variant prints identically with no register
write-back.

### Sean Young's H/L substitution rule

In opcodes that mix a register operand AND `(HL)` as memory (LD H,(HL),
LD L,(HL), LD (HL),H, LD (HL),L, the math-with-(HL) family), the H/L
register is **not** swapped to IXH/IXL even under DD/FD; only the address
mode swaps. The literal "H"/"L" strings are intentional in those op
entries.

### MEMPTR / WZ

`WZ` is a real architectural register here, not a scratch. Many
instructions update it in surprising ways (LD A,(BC) sets WZ = BC + 1,
LD (BC),A sets WZ.lo = (C+1)&0xff and WZ.hi = A, RST sets WZ = vector,
etc.). Using `regs.Z`/`regs.W` as a scratch will silently break MEMPTR.
Use `regs.OPx` (the high half of OP2) when you need a temp register
inside read-modify-write sequences.

### Q register

`Q` is a hidden latch holding the F value last written by an instruction
(or 0 if F wasn't touched). `SCF` and `CCF` read it for their X/Y bits:
`X/Y = (A | (F ^ Q)) & {X, Y}`. The wiring is in `cpu.ts`:
`updateFlags` sets `q = newF; qWritten = true`; `runOneOp` resets
`qWritten` at the start and clears `q = 0` at the end if `qWritten`
stayed false. The harness loads `cpu.q` from `initial.q` in the test
JSON.

### EI delay

`eiDelay` is the one-instruction grace period after `EI`. It's cleared at
the start of `runOneOp` so the EI handler can re-arm it; consumes
naturally on the next instruction.

### R register increment

`Z80.incR()` increments the low 7 bits of R only — bit 7 is preserved
because real silicon never auto-modifies it. `runOneOp` calls it
unconditionally except on the DDCB/FDCB op-byte cycle (already
counted by the prefix transition).

### Prefix dispatch

`runOneOp` clears `cpu.prefix` immediately after reading the
prefix-type so the dispatched opcode handler sees a clean slate.
This matters for code running multiple instructions in a row —
the SingleStepTests harness was masking a related bug for a while
by force-clearing prefix between tests, but real programs (LDIR
loops, sequential CB ops on (HL)) ran into immediate corruption.

Both the SingleStepTests harness and `runUntilHalt`/`runCpm` follow
the same termination rule for multi-byte instructions: keep calling
`runOneOp` while `cpu.prefix !== undefined` (each prefix byte sets
it, the effective opcode clears it).

## Register file

`regs.ts` is backed by a single 30-byte `ArrayBuffer` with both
`Uint8Array` and `Uint16Array` views. The `Z80RegsImpl` class exposes
all 45 byte/word accessors as direct typed-array indexed loads. This is
much faster (~2.2× across the test suite) than the previous
`Object.defineProperty` + closure layout because V8 sees a stable hidden
class on every Z80 instance and can inline the accesses.

## Program tests (`tests/programs/`)

Two harness modes for testing the CPU on real Z80 sequences:

- `runUntilHalt(h, bytes, opts)` — load bytes, run to first HALT.
  Used for the hand-assembled tests in `programs.test.ts`.
- `runCpm(h, bytes, opts)` — load a `.com` file at 0x0100 and trap
  `CALL 0x0005` to provide BDOS functions 0/2/9. Used for zexdoc.

`zexdoc.test.ts` fetches `zexdoc.com` / `zexall.com` from
anotherlin/z80emu on first run and caches under `tests/programs/
fixtures/`. Gated behind `ZEX=1` since each takes minutes; a full
zexdoc run is ~7 billion Z80 instructions.

For watching progress in real time use `yarn zex zexdoc` (or `yarn
zex zexall`) — that runs `zex-runner.ts` standalone, streams BDOS
output as zexdoc prints it, and every 50M ops logs a status line
with elapsed time, Mops/s, percentage complete, and ETA. The
percentage and ETA come from a hardcoded total of ~5.8 G
instructions per run (measured on this emulator; refresh in both
`zex-runner.ts` and `zexdoc.test.ts` if it drifts).

Measured rate (Windows V8): ~33.8 Mops/s on zexall, ~36 Mops/s on
zexdoc. Full zexdoc ~2.5 min; full zexall ~2.5 min. Both pass
cleanly (no CRC mismatches). The
vitest `test:zex` path captures the same output but only surfaces
it on completion.

The legacy MCycle table dispatcher and `ops.ts` were retired once
SingleStepTests, zexdoc, and zexall all ran clean on `ops.ts`.
ALU helpers ops.ts imports moved to `alu.ts`; mnemonic tables for
the disassembler / test harness moved to `mnemonics.ts`. There is
no fallback dispatcher anymore — `ops.ts` is the only path.

## Test status (as of last commit)

SingleStepTests has 1604 opcode files × 1000 cases each (1.6 M
machine-traced cases). The harness registers **one vitest fixture
per opcode group** (1604 fixtures, plus the disasm/symbol files
on top); inside each fixture the loop iterates the SAMPLE-truncated
case list and aggregates failures (up to 10 per group, with a
"more elided" tail). Cases load lazily via `beforeAll` and are
dropped via `afterAll` so only one group's parsed JSON sits in the
heap at a time — eagerly loading all 1604 files top-level OOM'd V8
at full sample (~4 GB of parsed JSON + per-case fixture metadata).

`yarn test:z80` runs the default sample (25 cases × 1604 ops)
in ~20 s; `Z80_SAMPLE=full yarn test:z80` runs the full 1000 ×
1604 in ~72 s, no OOM. **All cases pass on both dispatcher paths.**

The previously-failing INIR/INDR/OTIR/OTDR repeat-iteration
failures were resolved by applying David Banks's analysis
(`hoglet67/Z80Decoder/wiki/Undocumented-Flags`, also implemented
as `block_io_interrupted_flags()` in MAME's `z80.cpp`): the 5
T-state PC-decrement M-cycle on a repeating non-final iteration
applies a fix-up that overrides H and XNOR-toggles PF with the
parity of a small seed table, branching on `CF` and `value & 0x80`.
The `do_io_block_flags` helper in `ops.ts` carries the formula
inline. Y/X come from the post-decrement `PC.high` (not `PC+1`) —
the same off-by-one was also fixed in `do_cp_block` (CPIR/CPDR).

The `tests/programs/` hand-assembled suite passes 23/23
(programs + IRQ acceptance). Both **zexdoc** and **zexall** run to
a clean exit on the dispatcher in ops.ts (the default).

## Style

- Prefer small, focused commits with mnemonic test-driven verification.
- Don't add comments that explain what the code does — only WHY (a
  hidden invariant, an undocumented hardware quirk, a workaround). Most
  commits in the history follow this.
- Don't write docs unless asked. This file is the one exception.
- For Z80 work, when an opcode's behaviour is non-obvious (MEMPTR rule,
  X/Y source, BIT b,(HL) X/Y from W, SCF/CCF Q register), drop a one-line
  comment citing Sean Young or the test name.

## Conventions to follow first time

These are patterns the user has had to fix in repeated cleanup commits
(`82b124e`, `c1d222a`, `0828a76`). Get them right up front to keep
those commits from being necessary.

### Branded types over raw `number` / `string`

`src/flavours.ts` defines `Flavour<T, Tag>` aliases for everything
non-trivial. **Use them on every signature, struct field, and return
type** — don't leave a public API in raw `number`. The aliases land
in three families:

- **CPU widths**: `u8`, `u16`, `s8`, `s16`. A function reading from
  the bus takes `u16`, returns `u8`. A signed displacement is `s8`.
  The Z80 CPU + bus surface (`MemoryBus`, `IOBus`, `PC88MemoryMap`)
  are now u8/u16-typed end to end; new code on those surfaces must
  follow.
- **Counts**: `Bytes`, `Kilobytes`, `Operations`, `Cycles`, `Chars`,
  `Pixels`. A function counting instructions returns `Operations`,
  not `number`. ROM size is `Kilobytes`. Disassembly length is
  `Bytes`.
- **Time / freq**: `Milliseconds`, `Seconds`, `Minutes`, `Hours`,
  `Hertz`. `Date.now()` returns `Milliseconds`. Clock rates are
  `Hertz`.
- **Strings**: `FilesystemPath`, `WebURI`, `MD5Sum`, `ROMID`. Anywhere
  the value is a *kind of string* — the path argument to `readFile`,
  the URL fed to `fetch`, the md5 in a symbol-file header, the ROM
  id from `ROMDescriptor` — it gets the appropriate alias rather
  than `string`.

The compiler accepts a raw number where a `Flavour<number, …>` is
expected (the brand is structural-but-private), so adopting them is
a no-cost refactor at the call site, but it documents intent and
catches mistakes the moment a same-shape value is passed for the
wrong purpose.

### Use the makers in `flavour.makers.ts` for magic numbers

Don't write `4_000_000` or `15 * 60_000` inline; import the matching
maker from `src/flavour.makers.ts`:

```ts
import { kOps, mOps, bOps, mCycles, mHz, minutesToMs } from "./flavour.makers.js";

const DEFAULT_MAX_OPS = kOps(15);          // not 15_000
const Z80_HZ = mHz(4);                      // not 4_000_000
const ZEX_TIMEOUT = minutesToMs(15);        // not 15 * 60_000
const APPROX_TOTAL = bOps(5.8);             // not 5_800_000_000
```

This makes the units visible and keeps test/runner thresholds in a
shape that reads as English. New units go in this file — don't
inline a new conversion.

### Acronym capitalisation

PC-88 is full of three-letter acronyms. Use **all-caps for acronyms
inside otherwise-camelCase identifiers**. The user has had to rename
each of these at least once:

- `PC88MemoryMap`, not `Pc88MemoryMap`
- `LoadedROMs`, not `LoadedRoms`
- `DIPSwitchState`, not `DipSwitchState`
- `RAM64k`, not `Ram64K`
- `TestIO`, not `TestIo`
- `formatHMS`, not `formatHms`
- `toASCIIDump` / `rawTVRAMDump`, not `toAsciiDump` / `rawTvramDump`
- `ROMID`, `MD5Sum`, `WebURI`

Same rule applies to chip filenames: NEC second-source chips get
the Greek `μPD` prefix (`μPD3301.ts`, `μPD8251.ts`, `μPD8257.ts` —
not `ppi-8255.ts` / `crtc-3301.ts` / `dmac-8257.ts`). Yamaha keeps
its own part numbering (`YM2203.ts`). Non-chip register blocks
that don't have a real silicon name (the keyboard matrix, the
display register block) get descriptive names: `keyboard.ts`,
`display-regs.ts` — not `i8255.ts` (the keyboard matrix is NOT a
PPI on PC-88 hardware; that was an early refactor mistake).

When in doubt, search the codebase for an existing case-form before
introducing a new one.

### Don't duplicate small utilities

Per-test file copies of the same RAM/IO stubs got extracted to
`tests/tools.ts`. The hex/byte/word formatters live in `src/tools.ts`.
**Before writing a 5-line helper, grep for its name** — chances are
the same shape exists already:

```
src/tools.ts          hex(), byte(), word(), isDefined()
src/flavour.makers.ts kOps/mOps/bOps/mCycles/mHz/minutesToMs
tests/tools.ts        RAM64k, TestIO, filledROM, formatHMS
```

If you write a helper that two files need, hoist it to the matching
shared module in the same commit; don't leave a duplicate as a TODO.
The same applies to inline helpers like `formatDuration` /
`formatHms` — those went straight to `tests/tools.ts` as `formatHMS`.

### Import ordering (matches prettier-plugin-organize-imports)

Imports are alphabetised within each group, with a blank line
between `node:`-prefixed builtins, third-party, and relative imports.
Within a `import { … }` block, named items are alphabetised too —
`import { OpCode, opCodes } from "./ops.js"` (types and values
co-mingled, just sorted). Don't fight the formatter.

### Prettier escape hatch for table-style code

Some files are intentionally dense (one row per opcode in
`ops.ts`'s giant switches, one line per accessor in
`regs.ts`'s typed-array class, byte arrays commented as Z80
assembly in `tests/programs/`). Prettier's default reformatting
turns those into walls of wrapped statements. Use
`// prettier-ignore` on the AST node prettier can target — the
switch statement, the class declaration, the `const program = …`
declaration. If you need to add an inner ignore, hoist the inner
node into a named const so the ignore can attach.

### No dead `eslint-disable` comments

When you fix the underlying issue, remove the disable. Don't leave
`// eslint-disable-next-line no-console` above a `console.error`
call after we've decided the call is fine.

## PC88 machine wiring

Memory layout (mkI). All 16 addresses dispatch through `PC88MemoryMap`
at 4 KB page granularity, which keeps `read(addr)` to one array load
+ one indexed Uint8Array load even with bank-switching active:

```
0x0000-0x5FFF  BASIC ROM (n80 or n88)             [DIP-selected at reset; runtime via port 0x31 bit 2]
0x6000-0x7FFF  Active extension-ROM slot E0..E3   [port 0x32 bits 0-1; falls back to BASIC continuation if slot unloaded]
0x8000-0xBFFF  main RAM (always)
0xC000-0xEFFF  GVRAM plane 0/1/2 or main RAM      [VRAM enable + plane]
0xF000-0xFFFF  TVRAM (4 KB)                       [permanently mapped]
```

`PC88MemoryMap.setEromSlot(0|1|2|3)` selects which extension-ROM
image is mapped at 0x6000-0x7FFF, and `setEromEnabled(bool)`
toggles whether the slot is exposed at all (separate flag because
"slot 0" and "E-ROM disabled" are distinct hardware states — at
reset E-ROM is disabled even though the slot index is 0). If the
slot is enabled but `roms[`e0..e3`]` is undefined for the active
slot, the page falls through to the BASIC ROM continuation
(BASIC ROM bytes 0x6000-0x7FFF). mkI ships only E0; mkII SR ships
E0-E3. Earlier code hardcoded a boolean `setE0RomEnabled` which
broke the moment N88-BASIC tried to swap to E1; folding "slot
selected" and "slot enabled" into a single integer also regressed
N-BASIC boot, hence the separate flags.

TVRAM is **not** bank-switchable on mkI: CPU reads/writes always hit
the 4 KB TVRAM region. On mkI/mkII/FR/FA/FH that region is the upper
4 KB of main RAM (`mainRam.subarray(0xF000, 0x10000)`); on SR/MR/MH/
MA/MA2 it's a separate 4 KB chip — driven from
`MemoryConfig.tvramSeparate` per variant. Either way `.tvram` is a
Uint8Array view callers can write to directly.

ROM/VRAM state lives on the map and is mutated by the system controller
on writes to ports 0x30/0x31/0x32/0x5C/0x71. Writes to ROM-mapped pages
go through to main RAM at the same offset (write-through shadowing) —
real silicon ROM /OE is gated by the bank register but RAM /WE always
tracks the bus, so a Z80 write at 0x1234 lands in `mainRam[0x1234]`
regardless of ROM mapping. After every state mutation,
`refreshPages()` recomputes all 16 page slots.

I/O port surface (chips registered against the IOBus; anything else
is a noisy-once 0xff read / no-op write at the bus default):

```
0x00-0x0F    keyboard rows           (keyboard.ts: 16 read-only KEY rows)
0x09         soft-boot status         (misc.ts: returns 0xff)
0x10         calendar / cassette     (calendar.ts)
0x20-0x21    USART ch.0 (CMT/RS-232) (μPD8251.ts: latched, no traffic)
0x30         system DIP 1 / sysctrl1 (sysctrl.ts: latches cols80 etc.)
0x31         system DIP 2 / sysctrl2 (sysctrl.ts: latches mmode/rmode for EROM gate)
0x32         misc_ctrl (eromsl etc.) (sysctrl.ts: SCROUT/TMODE/PMODE/GVAM/SINTM)
0x40         status / strobe / beep  (sysctrl.ts → beeper.ts)
0x44-0x45    OPN sound (SR onwards)  (YM2203.ts: register latch, no audio)
0x50         CRTC data / status      (μPD3301.ts: param + status)
0x51         CRTC command            (μPD3301.ts: cmd, status read)
0x52-0x5B    palette / layer mask    (display-regs.ts: bgpal + palram + layer-mask)
0x5C-0x5F    GVRAM plane / RAM sel   (display-regs.ts: port-low-2 = sel index)
0x60-0x68    DMAC 8257               (μPD8257.ts: addr/count/mode)
0x70         text window             (sysctrl.ts: latched, mapping not yet wired)
0x71         EROM bank select        (sysctrl.ts: one-hot active-low slot)
0xC0-0xC3    USART ch.1/ch.2         (μPD8251.ts: latched, no traffic)
0xC8 / 0xCA  RS232 prohibited gates  (misc.ts: stub)
0xE4         IRQ priority             (irq.ts: latched, no behaviour)
0xE6         IRQ mask                 (irq.ts: bit 2 = VBL — runner honours; bits 0=RTC,1=SOUND,3=RxRdy,4=TxRdy)
0xE7         alt IRQ mask (mkII+)     (misc.ts: latched, no behaviour)
0xE8-0xEF    kanji ROM lookup        (kanji.ts: 2 banks, addr latch + 0xFF read)
0xF4 / 0xF8  external floppy DMA     (misc.ts: read 0xFF = card not present)
0xFC-0xFF    sub-CPU IPC PPI (mkII+) (μPD8255.ts: PA-out → other side's PB-in;
                                      port C symmetric)

(sub-CPU bus, exposed when hasSubCpu=true)
0xF0         IRQ vector latch        (sub-cpu.ts)
0xF4         drive-mode register     (sub-cpu.ts)
0xFA-0xFB    μPD765a FDC             (μPD765a.ts: SPECIFY, SENSE,
                                      RECAL, SEEK, READ ID, READ DATA,
                                      WRITE DATA, FORMAT TRACK;
                                      SCAN family still TODO)
0xFC-0xFF    μPD8255 PPI (sub side)  (same chip as the main-side line)
```

The runner (`runMachine` in `pc88.ts`) pumps a 60 Hz VBL: every
~66,667 Z80 cycles it sets the VBL bits on sysctrl + crtc and (if
bit 2 of the IRQ mask is set) calls `cpu.requestIrq(0x04)` — IM 2
vector 0x04 because the μPD8214 priority encoder emits 2 × source
and VBL is source 2 (RTC=0, SOUND=1, VBL=2). The pulse clears
~3,200 cycles later. Masked pulses still toggle the status bit so
polling-based BIOS code sees them. The 60 Hz constant lives at the
top of `pc88.ts`.

`runMachine` returns a `RunResult` with the final PC/SP, IFF1 state,
HALTed flag, and counts of VBL IRQs raised vs masked. `src/main.ts`
prints this plus bank state, chip-stub status bytes, CRTC mode, DMAC
channel-2 source/length, and a TVRAM hex-dump head as a "Diagnostics"
block — first port of call when "BIOS got stuck".

## What the screen actually shows

On real PC-88 hardware the visible image is decided by three pieces
of state working together:

- **μPD3301 RESET / SET MODE** (cmd `0x00`-`0x1F`) programs the
  visible geometry via 5 follow-up parameter bytes. The chip
  dispatches by the top 3 bits of the command byte (RESET = 000,
  START DISPLAY = 001, INTERRUPT MASK = 010, LOAD CURSOR = 100,
  etc.); the low 5 bits are flags. PC-8801 BASIC sends
  `[0xCE 0x93 0x69 0xBE 0x13]` → 80 chars × 20 rows. Decoding,
  per MAME's `upd3301_device::write` MODE_RESET handler:
    p0 bit 7 = `dmaCharMode` (DMA mode: char-pull vs burst)
    p0 bits 0-6 = `charsPerRow - 2` (the *byte count* of the
                  cell run pulled per row)
    p1 bits 6-7 = blink rate; bits 0-5 = `rows - 1`
    p2 bit 7 = skip-line; bits 5-6 = cursor mode;
                bits 0-4 = `charHeight - 1`
    p3 bits 5-7 = vblank-1; bits 0-4 = hblank-2
    p4 bits 5-7 = `gfxMode` (AT1|AT0|SC); bits 0-4 = attr-pairs-1
                  (= 20 in BASIC's programming, capped 20)
- **μPD8257 channel 2** carries the TVRAM start address + byte
  count to the CRTC each frame. `dmac.channelAddress(2)` /
  `dmac.channelByteCount(2)` expose this. PC-8801 BASIC programs
  `src=0xF300` (N-BASIC) or `0xF3C8` (N88) and
  `count=0x0960` → 20 rows × 120 bytes/row.
- **μPD3301 START DISPLAY** (`0x20`-`0x3F`) gates whether the
  raster is unblanked. `crtc.displayOn` tracks it. There is no
  separate STOP DISPLAY on the PC-88; RESET clears it.

**Per MAME's `upd3301_device::dack_w`, the CRTC streams
`charsPerRow` 1-byte chars per row, then `attrPairsPerRow * 2`
attribute-pair bytes** — there is no 2-byte interleaved char/attr
stride at the chip level. Both BASICs program `charsPerRow = 80`.

What looks like "2-byte cells" in N-BASIC's TVRAM dump
(`4e 00 45 00 43 00...`) is just N-BASIC choosing to write text
at every other byte with NUL fill; the CRTC streams all 80 bytes
unchanged. **Software-side cell stride** is selected by
`sysctrl.cols80` (mirrors port 0x30 bit 0 / COLS_80 written by
the BIOS):

  - `cols80 = false` (40-col mode) → BASIC stores 40 cells × 2
    bytes (char + attr); display reads chars at even offsets,
    attrs at odd. N-BASIC's convention.
  - `cols80 = true` (80-col mode) → BASIC stores 80 cells × 1
    byte (char only); per-cell attributes come from the trailing
    attr-pair area. N88-BASIC's convention.

Per-row stride = `charsPerRow + 40` bytes (cell run + 40-byte
attribute-pair area; the BIOS reserves all 20 attr slots whether
or not they're active). Confirmed by the DMAC channel-2 count
BASIC programs (2400 / 20 rows = 120 bytes/row in both modes).

`PC88TextDisplay.toASCIIDump()` honours all three: it reads only
the bytes the DMAC is configured to fetch, and only the rows × cols
the CRTC was told to show. **Anything else in TVRAM is BASIC scratch
that never reaches the screen** — token tables (`auto`, `go to`,
`list`, `run`), line buffers, attribute pair tables, etc.
`rawTVRAMDump()` ignores the CRTC config and lays out the full 4 KB
as 25 × 80 cells; useful for spotting what the BIOS is using
TVRAM for outside the visible area.

### Boot-path op-budget thresholds

Empirical minimums for the headless runner (`runMachine` /
`pc88-real-rom.test.ts`) — anything below these and the visible
region will still be mid-init when the run terminates:

- **N-BASIC banner** ("NEC PC-8001 BASIC", "Copyright 1979 (C) by
  Microsoft", "Ok") — needs at least **120 kOps**. The smoke test
  budgets `kOps(150)` for headroom.
- **N88-BASIC "How many files(0-15)?"** — needs at least
  **210 kOps**. The smoke test budgets `kOps(250)`.

Refresh these if the boot path picks up extra work (e.g. when
the FDC and sub-CPU land and the disk-config prompt actually
takes user input).

`yarn pc88` exposes its options as CLI flags (`yarn pc88 --help`
for the full list): `-m`/`--machine=NAME`,
`--basic=n80|n88` (overrides DIP bit 2 for the run only),
`--rom-dir=PATH`, `--max-ops=N`, `--trace-io[=raw]`, `--raw-tvram`,
`--log-file[=PATH]`, `-d`/`--debug`, `--break=ADDR` (repeatable).
Each non-debug flag has an env-var fallback with the same name
uppercased and `PC88_`-prefixed (or `LOG_TO_FILE` for the file
logger), so .env values work too. CLI wins over env when both are
set.

`--trace-io` (bare) dedupes consecutive identical IO lines; the
`=raw` form prints them all. The tracer hooks in via
`IOBus.tracer` (null in normal use, so the hot path stays
branch-cheap).

## Interactive debugger

`yarn pc88 --debug` (or `-d`) drops into a REPL before any code
runs. Commands: `step` / `next` (step over) / `continue [cycles]`
(stops on breakpoint / watchpoint / halt / op cap, or after N CPU
cycles when the optional arg is given) / `break <addr>` /
`unbreak <addr>` / `breaks` / `regs` / `chips` / `screen`
(renders the live CRTC+DMAC visible region) / `stack` (synthesised
CALL/RST/IRQ frames) / `trace [count]` (PC ring buffer) /
`dis [count]` (disassembles N instructions starting at PC,
default 8) / `peek <addr> [count]` / `peekw <addr>` /
`poke <addr> <val>` / `quit` / `help`. Initial breakpoints can be
installed up-front with `--break=ADDR` (repeatable). Addresses
accept `0xff`, `ff`, or decimal; out-of-range values are masked
to u16.

Watchpoints fire on access; the trailing `[break|log]` token
selects what happens on hit:

- `bw <addr> [r|w|rw] [break|log]` — RAM read/write watch
  (default `rw break`); fires via a `memBus.read` /
  `memBus.write` monkey-patch installed for the lifetime of the
  debug session.
- `bp <port> [r|w|rw] [break|log]` — IN/OUT port watch (default
  `rw break`); fires via `IOBus.tracer`. Port low byte only —
  chips dispatch on `port & 0xff`, the watch matches the same way.
- `unbw <addr>` / `unbp <port>` remove a watch. `bwl` / `bpl` list
  the active watches.

Action `break` sets `state.stopReason` and the run loop halts
between instructions; action `log` emits a `[watch] PC=... <kind>
<body>` line (with PC label resolved through `syms.resolver`) and
keeps running. Mode and action tokens are order-independent —
`bw 0xed42 log w` and `bw 0xed42 w log` are equivalent. Log mode
is the right tool for "init writes to this port hundreds of times
but only one of those is the bug" diagnosis: pipe `--script` /
`--log-file` output to a file and grep / diff later.

The PC ring buffer (`pcTrace` in DebugState; `PC_TRACE_SIZE = 64`)
captures the about-to-execute PC at every `trackedStep` call and
answers "how did we get here?" when a watch fires inside a JR /
fall-through chain that the call stack can't see. `trace [count]`
prints the last N (default 16, capped at 64) oldest-first with
disassembly + label resolution. Disassembly uses the LIVE memory
map — bank swaps between trace capture and trace print can lie,
so the `trace` header notes "captured" not "recorded", and a
note in the helper flags it. The same trace (last 8 lines) is
auto-printed on watch / break stops so the user doesn't have to
ask separately.

The synthesised `stack` is bookkept by `trackedStep` from SP
deltas + the IFF1 transition: CALL / conditional CALL / RST push
a frame (`via = "CALL"` or `"RST"`), RET pops one, and a
non-CALL instruction whose IFF1 went from 1→0 with SP-2 is
recorded as `via = "IRQ"`. Bounded at 256 frames; oldest is
dropped on overflow so the deepest frames stay visible. Best-
effort: BASIC stack-mungery (PUSH/RET as gosub, manual SP
unwinds) makes the model imperfect, but it's right for normal
code paths and hugely useful when stepping through the BIOS init.

`--script=PATH` replays a file of debugger commands through the
same dispatcher the REPL uses, then drops into the REPL. Lines
are echoed with a `script>` prefix so the captured output can be
matched against the input. Blank lines and lines starting with
`#` are skipped. `--script=PATH` implies `--debug`, and an
ending `quit` skips the REPL entirely (canned "boot, dump
state, exit" automation). The script-file driver and the REPL
both feed lines through `dispatch(line, ctx)` so behaviour can
never drift between them.

Disassembly is driven by `src/chips/z80/disasm.ts` which walks the
existing `opCodes` / `cbOpCodes` / `edOpCodes` / `ddOpCodes` /
`fdOpCodes` / `ddCbOpCodes` / `fdCbOpCodes` mnemonic strings and
substitutes `n` / `nn` / `d` / `(IX+d)` / `(IY+d)` placeholders
with the bytes read at PC. New opcodes added to `ops.ts` get
disassembly for free as long as the mnemonic uses those
placeholders. Tests in `tests/z80/disasm.test.ts`.

`yarn dis <file> [<addr> [<count>]]` is a standalone CLI
disassembler that operates on a raw binary file — no variant /
machine emulation needed. `--base=ADDR` sets the address the file
is "loaded at" so JR / JP / CALL targets render in the right
address space (e.g. `--base=0x6000 e0.rom` for an E-ROM image).
Uses the same disassemble() that powers the debugger; same output
format. Useful for poking at a ROM dump without booting anything.

## Symbol files

Each ROM that's been reverse-engineered enough to have named
addresses lives alongside a symbol file in `syms/<rom-id>.sym`.
The id matches `ROMDescriptor.id` from `src/machines/variants/`,
so `roms/mkI-n88.rom` ↔ `syms/mkI-n88.sym`. Files are committed
to the repo (not gitignored) — symbol names accumulated during
debugging are useful forever and lose nothing by being shared.

Format (plain text, one per line):

```
# md5: 22be239bc0c4298bc0561252eed98633
0x5550 print_string         ; print NUL-terminated string at HL
0x7968 print_banner_seq
```

`# md5: <hash>` is a header comment that's checked at load time
against the actual ROM's md5; mismatch emits a warning to stderr
and the symbols still load. `# ...` lines and blank lines are
preserved verbatim across rewrites — including the user's hand-
tuned column alignment for inline `; ...` comments. Edits via
`setSymbol()` drop the verbatim line so the rewritten symbol is
emitted in canonical form; surrounding lines stay untouched.

`yarn dis` auto-loads `syms/<basename>.sym` next to its CWD when
the path matches; `--syms=PATH` is an explicit override and
`--syms=off` disables substitution. The disassembler substitutes
labels for resolved addresses in JP / CALL / JR targets and
16-bit `LD HL,nn` / `LD (nn),HL`-style operands; 8-bit `n`
immediates are left as hex (they're almost never addresses).
Address-equal labels also print as a header line above the
instruction.

The debugger loads symbol files for every ROM the active variant
declares (via `src/machines/debug-symbols.ts`) and threads a
memory-map-aware resolver into `printPromptSummary` /
`printDisassembly`. Resolution is dispatched by the live state of
the memory map: `romIdAt(machine, addr)` consults `basicMode` /
`eromEnabled` / `eromSlot` to pick the right per-ROM file. So the
same address `0x5550` resolves to one name when N-BASIC is mapped
and another when N88-BASIC is mapped — the symbols don't
cross-pollute.

Three debugger commands persist mutations eagerly:

```
label <addr> <name> [comment...]   add / rename a symbol; writes
                                   the right syms/<rom-id>.sym
unlabel <addr-or-name>             addr → live-map lookup;
                                   name → search every loaded file
labels                             list every loaded symbol grouped
                                   by ROM id, sorted by address
```

The first mutation against a previously-empty symbol file seeds
it with a `# Symbol file for <id>.` header line, an md5 header
computed from the live ROM bytes, and a blank separator. After
that, mutations leave the header alone and use the same
verbatim-original-line preservation the file parser keeps for
unedited rows.

RAM and port namespaces (with fuzzy `name+N` resolution) live
alongside the per-ROM files. RAM addresses (0x8000+, outside
any mapped ROM) route to
`syms/<variant>.ram.sym`; port labels live in
`syms/<variant>.port.sym` and surface in `IN A,(n)` / `OUT (n),A`
disassembly via a separate `resolvePort` callback. The variant
slug comes from the lowercased model name with non-word
characters stripped (mkI → `pc8801`, mkII SR → `pc8801mkiisr`).
The address resolver wraps the merged table in
`fuzzySymbolTable()` which falls back to the nearest preceding
label within 16 bytes, emitted as `name+N` so instructions
mid-function still surface the function name. New REPL commands
`portlabel <num> <name>` / `unportlabel <n-or-name>` mirror the
existing label commands but write the port file. `yarn dis`
gains `--ram-syms=PATH` and `--port-syms=PATH` for explicit
paths (no auto-detect — RAM and port files belong to a variant,
not a ROM file).

The debugger and the headless runner share a single VBL pump
(`makeVblState()` + `pumpVbl(machine, state)` in `pc88.ts`) so
timing-sensitive code sees IRQs at the same instruction
boundaries regardless of which loop is driving. Step-over scans
the byte at PC; if it's CALL / conditional-CALL / RST it sets a
post-call target PC and runs until that's hit (capped at 5M ops
to avoid runaway).

## Snapshots / savestate foundation

Every stateful chip exposes `snapshot()` returning a
JSON-friendly state object plus `fromSnapshot(s)` to restore it.
`PC88Machine.snapshot()` aggregates them all into a `MachineSnapshot`
covering the CPU registers + flags + IFFs, the bank state of the
memory map, and every I/O chip's persistent fields. Heavy buffers
(TVRAM / mainRam / GVRAM planes) are intentionally NOT in the
top-level snapshot — a savestate writer will copy those separately
because they're base64-encoded for size reasons. The debugger's
`chips` command renders state via `machine.snapshot()`, so the
same plumbing that powers debug display is the foundation for
disk savestates whenever they land.

Snapshot tests in `tests/machines/pc88-snapshot.test.ts` lock
in the round-trip property: any per-chip mutation captured via
`snapshot()` is recoverable via `fromSnapshot()` and survives a
JSON round-trip.

## DIP-switch defaults

Per-variant DIP-switch state lives on `PC88Config.dipSwitches`
(`{ port30: u8, port31: u8 }`) — never hardcode magic bytes in
chip stubs. `SystemController` consumes the bytes via constructor
injection and surfaces them at port reads.

Variant configs construct their DIP bytes by OR-ing the symbolic
constants exported from `machines/config.ts`:

```ts
import { PORT30, PORT31, makeROM, type PC88Config } from "../config.js";

dipSwitches: {
  port30:
    PORT30.COLS_80 |
    PORT30.MONO |
    PORT30.CASSETTE_MOTOR |
    PORT30.USART_RS232_HIGH |
    0xc0, // bits 6-7 model-specific
  port31:
    PORT31.LINES_200 |
    PORT31.RMODE_N80 |
    PORT31.GRPH |
    PORT31.HIGHRES |
    0xc0, // bits 6-7 model-specific
},
```

The `0xc0` for bits 6-7 stays as a literal because those bits are
documented as "model-specific" without a public bit-name standard
across NEC's hardware manuals. SystemController re-uses PORT30 and
PORT31 to interpret the same bit positions on writes (port 0x30
write triggers `cols80` updates etc.). Bit-position docs live
inline on `PORT30` / `PORT31` in config.ts.

`PORT32`, `PORT40_R`, `PORT40_W`, `PORT71` (system-control register
bits not exposed via the DIP interface) stay private to
`sysctrl.ts` since no variant config touches them. `IRQ_MASK` lives
in `irq.ts`. `PORT52`, `PORT53`, `VRAM_SEL` live in
`display-regs.ts`. All follow the `as const` object pattern so they
compose with `&`/`|` without TS-enum casts.

## Canned debugger recipes (`dbg/`)

Diagnostic flows we run repeatedly live as committed scripts under
`dbg/`. Each is a one-shot probe — set up the watches/breakpoints,
run a fixed cycle budget, dump diagnostics. Scripts intentionally
omit `quit` so the REPL takes over when the script finishes,
giving the operator room for interactive follow-up.

| Script | Purpose |
|--------|---------|
| `dbg/n88-print-entry.dbg` | Run N88 boot, log port 0x71 EROM gating, break at 0x5550, dump the RAM hooks (0xEC88/0xED42/0xED99/0xE64C). The hooks staying as `C9` RET stubs at print-call time is *expected* — they're user-replaceable hooks whose default state is RET; the actual RST 18h dispatch is at ROM 0x0018, always present. The original "BIOS hasn't installed RST 18h" diagnosis was a red herring — the real banner blocker was the IRQ controller bit layout. |
| `dbg/erom-cycle.dbg` | Log every port 0x32 + 0x71 hit during a fixed boot window. Diff between N88 and N-BASIC to see who actually exercises the EROM dispatch. |
| `dbg/vbl-acceptance.dbg` | Log writes to port 0xE6 (IRQ mask), break at 0x0038 to catch IM 1 acceptance. Stack will show `via=IRQ` from the about-to-execute PC. |

When you write a new recipe (or significantly change one), update
this table and the README's debugger paragraph in the same commit.

## Hooks

Project-wide hooks live in `.claude/settings.json`:

- **`PostToolUse` on `Bash(git commit *)`** — emits a reminder via
  `additionalContext` that the README TODO list should be updated
  in any feature-changing commit. Backstop for the "treat README
  as part of the deliverable" rule above; the existing
  `~/.claude/stop-hook-git-check.sh` separately blocks Stop while
  uncommitted changes remain.

## Branch / pushing

Active branch: `claude/continue-web-gui-0cis8`. Never push to `main`.

GitHub MCP tools are restricted to `lagdotcom/pc88-emulator`.
Direct `git push` works for this branch in this workspace; if
it fails with 403, the access change usually propagates after a
session restart.

## Open architectural decisions before FDC work

1. The `Disk` interface — needs to expose tracks/sectors with per-sector
   metadata (C/H/R/N, deleted-data mark, CRC OK/error, density). D88
   supports all of this; flattening it loses needed state.
2. The sub-CPU model — mkII has `hasSubCpu: true`; the main CPU and
   sub-CPU communicate through shared latches. Two CPU instances + a
   latch object. The FDC connects to the sub-CPU, not the main bus.
3. **IM 0 / NMI acceptance.** IM 1 + IM 2 are both wired now.
   `Z80.requestIrq(vector?)` carries the data-bus byte the source
   chip would assert during the IRQ ack cycle (default 0xff = "/INT
   pulled low, no chip driving the bus"). Acceptance:
     - IM 1 → push PC, vector to 0x0038, 13 t-states.
     - IM 2 → push PC, read PC from word at `(I << 8) | (vector & 0xFE)`,
              19 t-states. The `& 0xFE` mirrors real silicon tying
              D0 of the table read low.
   The runner asserts vector 0x00 for VBL (PC-88 IM 2 table puts VBL
   at I:0x00). IM 0 (execute bus byte as opcode — only the RST 38h
   case is reachable; no PC-88 source uses anything else) and NMI
   (vector 0x0066, ignores IFF1) remain TODO; FDC + sub-CPU IPC
   will surface them.

## Things to know about the harness

- The harness skips opcodes whose mnemonic starts with `PREFIX`
  (DD/FD/CB/ED themselves) — those don't have their own test files.
- DDCB/FDCB filenames in SingleStepTests are `<prefix> cb __ XX.json`
  where `__` is a placeholder for the displacement byte (it varies
  per case inside the file). Both tables are populated and pass
  cleanly.
- `step()` calls `runOneOp` up to 5 times and stops when `cpu.prefix`
  is undefined, which signals that the prefix has been consumed and
  the effective opcode dispatched. A `DD CB d xx` instruction takes
  three calls to `runOneOp` (DD prefix, CB sub-prefix, then the op
  byte), all inside one `step()` invocation.
- The harness still defensively force-clears `cpu.prefix` after each
  test, which is harmless but no longer load-bearing.
