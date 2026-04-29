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

## What this is

PC-88 emulator written in TypeScript. Goal: PC-8801 mkII SR support first,
accurate enough to run simple RPGs, with FH/MH expansion later. Heavily
test-driven on the Z80 side; the rest of the machine (FDC, video, sub-CPU,
sound) is mostly unbuilt.

## Architecture intent

- `src/chips/` — silicon-level emulation. Each chip module knows about
  itself only; chips never reach across to each other. The Z80 lives
  under `chips/z80/`; the PC-88 I/O surface chips
  (`sysctrl`/`ppi-8255`/`crtc-3301`/`dmac-8257`/`calendar`/`beeper`)
  live under `chips/io/`. The I/O chips are still mostly stubs at
  first-light scope — they accept the BASIC ROM init writes and
  return idle status reads, no rendering or audio yet.
- `src/core/` — buses and shared infrastructure. `MemoryBus` is the
  multi-provider memory bus with a fast path for the single-array
  case. `IOBus` is the 256-slot pre-resolved I/O port bus used by the
  Z80's `io` parameter (replaced `MemoryBus` for I/O — the table is
  always full, dispatch is one array load + one call). PC-88 I/O is
  decoded on the low 8 bits of the port; chip stubs ignore the upper
  byte that `IN A,(n)` / `OUT (C),r` put on the bus.
- `src/machines/` — wiring. `pc88.ts` exports `PC88Machine` (a real
  factory consuming `PC88Config` + `LoadedRoms` and instantiating
  the Z80, memory map, IOBus, and chip stubs) plus `runMachine()`,
  which pumps a 60 Hz VBL onto `Z80.requestIrq()` while running.
  `pc88-memory.ts` is the bank-switched memory map (paged at 4 KB
  granularity; subarray views into ROM/RAM/VRAM). `pc88-display.ts`
  is the frame-capture interface (`getTextFrame()` works today,
  `getPixelFrame()` returns null until graphics are implemented).
  `rom-loader.ts` resolves `ROMDescriptor.id` to `roms/${id}.rom`,
  validates the size, and md5-checks against the descriptor (md5s
  are populated for mkI in `variants/mk1.ts`).
  Models are config-driven (`PC88Config` in `machines/config.ts`);
  variants under `machines/variants/` are data, not subclasses.
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

The emulator is a cycle-listed dispatcher. Each opcode is an `OpCode`
(`{code, mnemonic, mCycles}`) where `mCycles` is an array of `MCycle`
records (`{type, tStates, process}`). `Z80.runOneOp()`:

1. Fetches one byte at `PC`, increments `PC`.
2. Decodes via `prefix` + `regs.OP` against the appropriate table.
3. Iterates the `mCycles` list, calling each `process(cpu)` and totalling
   `tStates`.

Seven opcode tables are declared and exported from
`src/chips/z80/ops.ts`: `opCodes`, `edOpCodes`, `cbOpCodes`,
`ddOpCodes`, `fdOpCodes`, `ddcbOpCodes`, `fdcbOpCodes`. All seven
are populated by factory functions in the same file.

### RegSet pattern

`opCodes`, `ddOpCodes`, and `fdOpCodes` are all generated by the same
`buildOpTable(set: RegSet)` factory, where `RegSet` describes the
substitution applied to opcodes that touch HL/H/L/(HL):

```ts
interface RegSet {
  rp: "HL" | "IX" | "IY";   // active 16-bit pair
  rh: "H" | "IXH" | "IYH";  // its high half
  rl: "L" | "IXL" | "IYL";  // its low half
  addr: "hl" | "ix-d" | "iy-d";
}
```

For (HL)-style memory access the `indexed_prefix(set)` and
`indexed_addr(set)` helpers expand to either plain `mem_read("HL", …)` or
to `[fetch_disp_to_wz(set), internal_delay(5), mem_read("WZ", …)]`. WZ is
loaded with `IX/IY + d` so MEMPTR comes out right.

`buildCbTable(HL_SET)` produces `cbOpCodes`. `buildIndexedCbTable(set)`
produces `ddcbOpCodes` (with `IX_SET`) and `fdcbOpCodes` (with
`IY_SET`). DDCB/FDCB always operate on `(IX+d)` / `(IY+d)`, never on
plain registers, so the indexed builder rejects `HL_SET`. It also
implements the undocumented "register copy" side effect: for non-(HL)
target slots (0..5, 7) the modified byte is also written into the
named register. `BIT b,(IX+d)` ignores the slot entirely — every BIT
slot behaves identically with no register write-back.

The DD/FD CB-prefix transition is in `prefix_cb_for(set)`. Plain CB
fetches just the op byte and dispatches; DDCB/FDCB fetch the
displacement *first*, park `IX/IY+d` in WZ, and then the next
`runOneOp` reads the op byte (as MR, not M1 — DDCB/FDCB ops use a
no-op first MCycle so R isn't double-incremented).

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
because real silicon never auto-modifies it. The `opcode_fetch_and`
M1 cycle calls `incR()` unconditionally.

### Prefix dispatch

`Z80.decode()` clears `cpu.prefix` as part of dispatching the
prefixed opcode (the prefix is consumed by the M1 fetch, not left
hanging). This matters for code running multiple instructions in a
row — the SingleStepTests harness was masking the bug for a while
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

Measured rates (Windows V8):
- ops2 path (default): ~36 Mops/s; full zexdoc ~2.5 min; full
  zexall ~2.5 min. Both pass cleanly (no CRC mismatches).
- legacy table path (`DISPATCH=table`): ~8 Mops/s; ~12 min; four
  CRC families fail in both zexdoc and zexall.

The vitest `test:zex` path captures the same output but only
surfaces it on completion.

The 3 Mops/s figure is the next obvious perf lever: the M-cycle list
dispatcher allocates closure objects per cycle and walks an array per
opcode. Switching to a giant per-opcode switch with inline code (the
common pattern in fast Z80 emulators) typically gets to 50-100 Mops/s
in V8. Worth doing before the user is sitting waiting for a real
PC-88 BIOS to boot, but not while the focus is correctness.

## Test status (as of last commit)

SingleStepTests sample size 25 per opcode → 40100 total cases run by
`yarn test:z80` (1604 ops × 25, covering base + CB + DD + FD + ED +
DDCB + FDCB). **40023 / 40100** pass on either dispatcher path. The
77 remaining failures are all in the SingleStepTests harness's
shared helpers (do_io_block_flags) — they appear via both ops2 and
the legacy table — and concern undocumented H/PV bits during
INIR/INDR/OTIR/OTDR repeating iterations. Empirical fitting against
the test data gets to 941/995 with a `(C ? bp_lo == 0 : bp_lo ==
0xf)` rule for H, but the remaining ~5% don't fit any simple formula
over `(B_post, C_flag, base, value)`. Fixing them needs a
known-correct reference (FUSE / mame / Patrik Rak's z80core).

All non-repeat INI/IND/OUTI/OUTD pass, every base/CB/DD/FD opcode
passes, and DDCB/FDCB pass cleanly. The `tests/programs/`
hand-assembled suite passes 18/18. Both **zexdoc** and **zexall**
run to a clean exit on the ops2 dispatcher (the default).

## Style

- Prefer small, focused commits with mnemonic test-driven verification.
- Don't add comments that explain what the code does — only WHY (a
  hidden invariant, an undocumented hardware quirk, a workaround). Most
  commits in the history follow this.
- Don't write docs unless asked. This file is the one exception.
- For Z80 work, when an opcode's behaviour is non-obvious (MEMPTR rule,
  X/Y source, BIT b,(HL) X/Y from W, SCF/CCF Q register), drop a one-line
  comment citing Sean Young or the test name.

## PC88 machine wiring

Memory layout (mkI). All 16 addresses dispatch through `PC88MemoryMap`
at 4 KB page granularity, which keeps `read(addr)` to one array load
+ one indexed Uint8Array load even with bank-switching active:

```
0x0000-0x5FFF  BASIC ROM (n80 or n88)            [bank-switchable]
0x6000-0x7FFF  E0 extension ROM (or BASIC cont.)  [bank-switchable]
0x8000-0xBFFF  main RAM (always)
0xC000-0xEFFF  GVRAM plane 0/1/2 or main RAM      [VRAM enable + plane]
0xF000-0xFFFF  TVRAM (4 KB)                       [permanently mapped]
```

TVRAM is **not** bank-switchable on mkI: CPU reads/writes always hit
the 4 KB TVRAM array. The CRTC controls whether the contents are
displayed, but it doesn't toggle CPU addressability. Earlier code
modelled a `_tvramEnabled` flag that fell back to main RAM; this was
wrong and caused early BIOS writes to be lost.

ROM/VRAM state lives on the map and is mutated by the system controller
on writes to ports 0x30/0x31/0x32/0x5C. Writes to ROM-mapped pages go
to a 4 KB discard buffer. After every state mutation, `refreshPages()`
recomputes all 16 page slots; the cost is negligible compared to the
millions of reads between bank flips.

I/O port surface (the chip-stub-fed slots — anything else is a
noisy-once 0xff read / no-op write):

```
0x00-0x03    PPI #1                  (ppi-8255.ts: keyboard, idle)
0x09         hardware probe           (misc.ts: returns 0xff)
0x10         calendar / cassette     (calendar.ts)
0x30         system DIP 1 / ROM bank (sysctrl.ts)
0x31         system DIP 2 / ext ROM  (sysctrl.ts)
0x32         VRAM/TVRAM window       (sysctrl.ts)
0x40         status / beep / strobe  (sysctrl.ts → beeper.ts)
0x50         CRTC data / status      (μPD3301.ts: param + status)
0x51         CRTC command            (μPD3301.ts: cmd, status read)
0x5C         GVRAM plane select      (sysctrl.ts)
0x60-0x68    DMAC 8257               (dmac-8257.ts: param eater)
0x71         secondary ROM bank      (sysctrl.ts: noop)
0xE4         IRQ priority             (irq.ts: latched, no behaviour)
0xE6         IRQ mask                 (irq.ts: bit 0 = VBL — runner honours)
0xE7         IRQ-related (mkII+)      (misc.ts: latched, no behaviour)
0xF8         boot/FDD-IF (mkII+)      (misc.ts: latched, no behaviour)
```

The runner (`runMachine` in `pc88.ts`) pumps a 60 Hz VBL: every
~66,667 Z80 cycles it sets the VBL bits on sysctrl + crtc and (if
bit 0 of the IRQ mask is set) calls `cpu.requestIrq()`, then clears
the bits ~3,200 cycles later. Masked pulses still toggle the status
bit so polling-based BIOS code sees them. The 60 Hz constant lives
at the top of `pc88.ts`.

`runMachine` returns a `RunResult` with the final PC/SP, IFF1 state,
HALTed flag, and counts of VBL IRQs raised vs masked. `src/main.ts`
prints this plus bank state, chip-stub status bytes, CRTC mode, DMAC
channel-2 source/length, and a TVRAM hex-dump head as a "Diagnostics"
block — first port of call when "BIOS got stuck".

## What the screen actually shows

On real PC-88 hardware the visible image is decided by three pieces
of state working together:

- **μPD3301 RESET / SET MODE** (cmd `0x00`-`0x1F`) programs the
  visible geometry via 5 follow-up parameter bytes: characters per
  row, rows per screen, attribute pairs per row, character cell
  height. The chip dispatches by the top 3 bits of the command byte
  (RESET = 000, START DISPLAY = 001, INTERRUPT MASK = 010, LOAD
  CURSOR = 100, etc.); the low 5 bits are flags.
  N-BASIC sends `[0xCE 0x93 0x69 0xBE 0x13]` → 80 cols × 20 rows.
  Stored as `crtc.charsPerRow`, `crtc.rowsPerScreen`, etc.
- **μPD8257 channel 2** carries the TVRAM start address + byte
  count to the CRTC each frame. `dmac.channelAddress(2)` /
  `dmac.channelByteCount(2)` expose this. N-BASIC programs
  `src=0xF300, count=0x0960` → 20 rows × 120 bytes/row.
- **μPD3301 START DISPLAY** (`0x20`-`0x3F`) gates whether the
  raster is unblanked. `crtc.displayOn` tracks it. There is no
  separate STOP DISPLAY on the PC-88; RESET clears it.

The TVRAM per-row layout is **80 chars contiguous (offsets 0..79)
followed by 40 bytes of attribute-pair area (offsets 80..119)**;
each attribute pair is 2 bytes (column index, attribute byte).
Total stride = 120 bytes, confirmed by the DMAC count BASIC
programs (2400 / 20 = 120). An earlier "char+attr interleaved at
2-byte cells" theory turned out to be wrong — the misleading
"char NUL char NUL" pattern in the dump was just attribute bytes
at offsets 80+ being read past the char run.

`PC88TextDisplay.toAsciiDump()` honours all three: it reads only
the bytes the DMAC is configured to fetch, and only the rows × cols
the CRTC was told to show. **Anything else in TVRAM is BASIC scratch
that never reaches the screen** — token tables (`auto`, `go to`,
`list`, `run`), line buffers, attribute pair tables, etc.
`rawTvramDump()` ignores the CRTC config and lays out the full 4 KB
as 25 × 80 cells; useful for spotting what the BIOS is using
TVRAM for outside the visible area.

Set `PC88_TRACE_IO=1` to log every IN/OUT with the CPU PC at the
time of the access. Hooks in via `IOBus.tracer` (null in normal use,
so the hot path stays branch-cheap).

## Branch / pushing

Active branch: `claude/pc88-emulator-fdc-NufaT`. Never push to `main`.

GitHub MCP tools are restricted to `lagdotcom/killchain` and
`lagdotcom/pc88-emulator`. Direct `git push` works for this branch in
this workspace; if it fails with 403, the access change usually
propagates after a session restart.

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
