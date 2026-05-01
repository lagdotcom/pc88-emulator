# PC-8801 I/O port wiring plan

Reference: `refs/MAME-pc8801-ports.cpp` (sliced from `mame/src/mame/nec/pc8801.cpp`).
That file is the authoritative open-source PC-88 port table; bit
layouts in inline comments come from NEC's hardware manual, transcribed
by MAME maintainers.

A second reference URL the MAME source cites at line 908:
`https://retrocomputerpeople.web.fc2.com/machines/nec/8801/io_map88.html`
— blocked from our sandbox but worth a manual fetch when off-sandbox.

This file plans which ports we add next, ordered by what's blocking the
N88 banner first, then by what unlocks each subsequent milestone (keyboard
input, sound, FDC). For each port we capture: where it lives in the MAME
driver, what we currently do (if anything), and what the smallest useful
implementation would be.

## Discrepancies to fix in existing code

These are bugs in our current wiring surfaced by comparing against MAME.
Worth fixing **before** adding new ports — otherwise the new ports
inherit the same wrong assumptions.

### `i8255` is on the wrong ports

We register `i8255.ts` at `0x00-0x03` AND `0xFC-0xFF`. MAME shows:

- `0x00-0x0F` = direct keyboard scan rows (KEY0..KEY15), one row per
  port read; **not** a PPI. 16 separate read-only ports backed by the
  keyboard matrix.
- `0xFC-0xFF` = `pc80s31_device::host_map` — i8255 PPI for sub-CPU IPC.
  THIS is where the actual 8255 lives, with 4 ports (data A, B, C,
  control). On mkII this is the FDC sub-CPU bus.

**Fix:** rename our current `i8255.ts` → `subcpu-ppi.ts` (or keep the
chip name but be explicit it's the *FDC i8255*). Move the keyboard
ports to a new `keyboard.ts` that registers 16 read-only ports
0x00..0x0F and exposes a `pressKey(row, col)` API.

### `sysctrl` port 0x32 bit layout

We document port 0x32 as `eromsl + avc + tmode + pmode + gvam + sintm`.
MAME's authoritative layout (from inline comment in `misc_ctrl_w`):

```
bit 7  sound IRQ mask     0=enabled 1=masked
bit 6  GVRAM access mode  0=independent 1=ALU
bit 5  palette select     0=digital 1=analog
bit 4  high-speed RAM sel 0=dedicated text RAM 1=main RAM bank (TVRAM)
bits 2-3 screen output    00=TV/video 01=disabled 10=analog RGB 11=optional
bits 0-1 internal EROM selection
```

Our current `tmode`/`pmode`/`gvam`/`sintm` mostly match but should
adopt MAME's exact field names so future readers can grep both
codebases. Bit 4 in particular is significant — it controls whether
TVRAM is the dedicated chip (mkII SR onwards) or the upper 4 KB of
main RAM. That's exactly the `tvramSeparate` distinction we just
added to `MemoryConfig`; right now it's a static config flag, but on
SR+ port 0x32 bit 4 makes it dynamic.

### Port 0x71 = `ext_rom_bank`, semantics confirmed

MAME's `ext_rom_bank_r/w` is a single byte that selects the active
extension-ROM bank. Bits 1..3 are written at POST and likely select
"EXP slot ROMs" (MAME comment: "TODO: bits 1 to 3 written to at POST,
selection for EXP slot ROMs?").

Our current handler treats bits 0..3 as an active-low one-hot slot
selector. MAME doesn't document the bit layout that confidently, so
our active-low assumption is at least plausible. Keep our impl, but
add a comment cross-referencing MAME's `ext_rom_bank_w` for future
verification.

## New ports to add, in priority order

### Tier 1 — blocking the N88 banner

#### Keyboard rows (ports 0x00–0x0F, read-only)
**Current:** registered as `i8255.ts` ports 0x00-0x03 stub returning
"no key pressed".
**MAME:** `map(0x00, 0x00).portr("KEY0")` … through KEY15. Plain
read-only ports backed by the keyboard matrix — when the user
presses a key, the corresponding row+column reads as a 1.
**What we need:** a `Keyboard` chip with `pressKey(row, col)` /
`releaseKey(row, col)`, registered at all 16 ports as read-only.
Idle state returns 0xFF (no keys held = all rows = 0xFF because the
matrix uses active-low). The N88 boot path may sample these to
detect "boot key held" behaviour — explains the reset-key check
we saw in earlier traces.
**Priority:** high. The N88 banner-print path may diverge based on
"any key pressed?" reads.

#### Port 0x10 (write) — printer data + calendar
**Current:** registered in `calendar.ts` as a no-op.
**MAME:** `port10_w` (handler not in our slice; on PC-8001 it sets
calendar bits + printer data lines). Mostly write-then-strobe via
port 0x40.
**What we need:** keep the no-op, add a comment cross-referencing
MAME `port10_w`. Real wiring waits until we model the printer or
care about calendar reads.

#### Port 0x44–0x45 (mkII SR onwards) — YM2203 OPN
**Current:** none.
**MAME:** `pc8801mk2sr_state::main_io` adds `map(0x44, 0x45).rw(m_opn, ym2203_device::read/write)`.
**What we need:** stub `OPN` chip module that latches register addr
(port 0x44 write) and data (port 0x45 read/write), no actual sound
generation. Some N88 BASIC programs probe these on init — silent
ignore is enough for the banner.
**Priority:** low for first-light, but cheap to stub.

#### Port 0xC0–0xC3 — USART (RS-232C ch 1/ch 2)
**Current:** unhandled (we saw `OUT c1`/`OUT c3` in N88 trace logs).
**MAME:** commented-out (`// map(0xc0, 0xc3) USART RS-232C ch. 1 / ch. 2`).
**What we need:** a tiny `Usart8251` stub that latches the mode/
command register pair and returns idle status (TX-empty bit set,
RX-not-ready bit clear). N88 boot pokes these even with no serial
device attached; without a stub the noisy-once IOBus default
pollutes diagnostics every cycle.
**Priority:** medium — N88 init writes these unconditionally.

#### Ports 0xE8–0xEF — Kanji ROM access
**Current:** unhandled.
**MAME:** `kanji_r<0>` / `kanji_w<0>` at 0xE8-0xEB and `kanji_r<1>`
/ `kanji_w<1>` at 0xEC-0xEF.
**What we need:** stub returning 0xFF on read so the BIOS sees "no
kanji ROM" and skips that branch of init. Real implementation
needs the kanji ROM image (`mkI-kanji1.rom`) and the lookup logic
(write address → read data). Skip for first-light; add when we
care about JIS character rendering.

### Tier 2 — needed for keyboard input + program loading

#### Port 0xFC–0xFF — Sub-CPU PPI (i8255)
**Current:** stubbed by our `i8255.ts` returning idle.
**MAME:** `m_pc80s31->host_map` — full i8255 mode-1 strobed I/O for
the sub-CPU IPC latch. The sub-CPU is a second Z80 with its own ROM
that drives the FDC (μPD765a).
**What we need:** a real `Pc80s31` device that:
- Models the i8255 in mode-1 (latched A→sub, B←sub, C control bits)
- Hosts a separate `Z80` instance running the sub-CPU ROM
- Wires the sub-CPU's I/O ports to the FDC + IPC PPI
This is significant work — probably its own milestone after the
banner.
**Priority:** medium-low for banner; high for "load a disk".

#### Port 0xE2/0xE3 — extended-RAM bank
**Current:** unhandled.
**MAME:** `extram_mode_r/w`, `extram_bank_r/w`. Standard on mkIIMR,
MH/MA/MA2/MC. Selects between physical RAM banks beyond the base
64 KB.
**What we need:** stub for now (return 0). Implement for FH/MA when
we model 128 KB+ RAM.

### Tier 3 — needed for graphics rendering

#### Port 0x34/0x35 — ALU control (mkII SR onwards)
**Current:** unhandled.
**MAME:** `alu_ctrl1_w` / `alu_ctrl2_w`. Per-plane raster operations
(AND/OR/XOR/copy) for fast GVRAM blits. mkII SR introduced this; mkI
and pre-SR mkII don't have it.
**What we need:** stubs that latch the ALU mode bytes. Real
implementation = full GVRAM ROP support, blocks on the graphics
renderer.

#### Port 0x6E/0x6F (FH+) — CPU clock + baud rate
**Current:** unhandled.
**MAME:** `cpuclock_r` / `baudrate_r/w`. FH+ adds 8 MHz mode toggle.
**What we need:** stubs returning fixed values. mkI runs at 4 MHz
unconditionally.

### Tier 4 — peripheral expansion

These are write-only stubs returning idle / 0xFF, none blocking
first-light. Listed for completeness.

| Port | MAME description | Notes |
|------|------------------|-------|
| 0x20-0x21 (mirror 0x0E) | i8251 USART (CMT/RS-232 ch 0) | Cassette + serial, present from mkI |
| 0x33 | "PC8001mkIISR port, mirror on PC8801?" | Probably nothing on mkI |
| 0x78 | window_bank_inc_w | Increments port 0x70's text-window latch |
| 0x82 | "access window for PC8801-16" | Slot card |
| 0x8E | "<unknown>, accessed by scruiser on boot (a board ID?)" | One game probe |
| 0x90-0x9F | PC-8801-31 CD-ROM (MC) | Optical drive |
| 0xA0-0xA3 | GSX-8800 / network board | Expansion |
| 0xA8-0xAD | Expansion OPN / OPNA (Sound Board II) | Add-on sound |
| 0xB0-0xB3 | General Purpose I/O | Expansion |
| 0xB4 | PC-8801-17 Video art board | Add-on |
| 0xB5 | PC-8801-18 Video digitizing unit | Add-on |
| 0xBC-0xBF | External floppy I/F (i8255) | PC-8801-13/-20/-22 |
| 0xC4-0xC7 | PC-8801-10 MIDI / GSX-8800 PIT | Add-on |
| 0xC8-0xCD | JMB-X1 OPM / SSG | Add-on sound |
| 0xD0-0xDF | GP-IB | IEEE-488 |
| 0xDC-0xDF | PC-8801-12 MODEM (TR built-in) | Modem |
| 0xF0-0xF1 | Dictionary bank (MA+) | Japanese IME |
| 0xF3-0xFB | DMA floppy variants | FDC alternatives |

## Suggested order of work

1. **Fix the i8255-on-wrong-ports bug.** Rename current `i8255.ts` to
   indicate it's the sub-CPU PPI; move the 0x00-0x03 registration
   off it.
2. **Add `Keyboard` chip** at 0x00-0x0F. Idle = 0xFF on every row.
   Expose `pressKey(row, col)` for future input. This unblocks
   anything that polls the keyboard during boot.
3. **Add `Usart8251` stub** at 0xC0-0xC3 (and later 0x20-0x21).
   Latches mode/command, returns idle status. Cleans up the noisy
   trace output during N88 boot.
4. **Stub kanji ROM ports** 0xE8-0xEF — return 0xFF, latch
   write-addresses for diagnostics.
5. **Stub OPN at 0x44-0x45** (mkII SR variant only). Empty state
   machine.
6. **Refine sysctrl port 0x32** to use MAME's exact bit names; wire
   bit 4 (high-speed RAM select) into `PC88MemoryMap` so SR boot can
   dynamically toggle TVRAM source.
7. **Sub-CPU + FDC** as its own dedicated milestone.

Each of items 1-6 is a single small commit; together they should
clear most of the unhandled-port noise from the N88 boot trace,
which should make the remaining real divergences (port 0x71 stateful
latch, RAM-hook init) easier to spot.
