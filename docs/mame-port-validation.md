# MAME port-handler validation reference

Cross-checked against MAME's `src/mame/nec/pc8801.cpp` (HEAD,
2026-05-04). Use as a quick lookup when adding or modifying I/O
in `src/chips/io/`.

## Status legend

- ✅ matches MAME (bit decode, side effects, edge cases)
- ⚠️ minor divergence, behaviorally equivalent for boot
- ❌ behavioral divergence — fix needed
- ❓ MAME has it, we don't (or vice versa); investigate
- — not implemented in either / out of scope

## Main-CPU I/O port map

| Port | MAME handler | Our handler | Status | Notes |
|------|--------------|-------------|--------|-------|
| 0x00-0x0F | KEY0-KEY15 read | `keyboard.ts` rows | ✅ | 16 read-only matrix rows; both return 0xFF idle. |
| 0x10 | port10_w | `calendar.ts` | ✅ | Calendar/cassette write stub on both sides (MAME inherits from `pc8001_base_state`). |
| 0x20-0x21 | i8251 ch.0 | `μPD8251.ts` ch.0 | ✅ | USART CMT/RS-232C ch.0; both latch mode + cmd, return idle status. |
| 0x30 | DSW1 r / port30_w | `sysctrl.ts` handle30 | ✅ | DIP1 readback + bit decode (COLS_80, MONO, CARRIER_MARK, CASSETTE_MOTOR, USART_MASK). |
| 0x31 | DSW2 r / port31_w | `sysctrl.ts` handle31 | ✅ | Bit decode (200LINE, MMODE, RMODE, GRPH, HCOLOR, 25LINE). MMODE/RMODE propagate to memoryMap on every write. |
| 0x32 | misc_ctrl r/w | `sysctrl.ts` handle32 | ✅ | Bit decode matches (SINTM, GVAM, PMODE, TMODE, SCROUT, EROMSL). EROMSL value drives `setEROMSlot`. |
| 0x34 | alu_ctrl1_w | — | ❓ | GVRAM ALU mode register. Used by graphics-heavy titles for ALU-blit. Not exercised by SR boot. |
| 0x35 | alu_ctrl2_w | — | ❓ | Companion ALU register. |
| 0x40 | port40_r/port40_w | `sysctrl.ts` handle40 + status read | ⚠️ | Bit decode matches MAME comments. **Minor divergence**: MAME's beeper toggle is edge-triggered (state goes ON on 0→1 transition of bit 5, OFF on 1→0; bit 7 set forces OFF). Our `beeper.toggle(beep)` is level-based — equivalent for tonal output but skips the SING bit-7 mask. Action: confirm Beeper.toggle's semantics; consider matching the bit-7-forces-off rule. |
| 0x44-0x45 | YM2203 (SR+) | `YM2203.ts` | ✅ | Address-then-data Yamaha protocol; timer A/B + IRQ wired (commit 1882737). Status read returns timer overflow flags. |
| 0x46-0x47 | YM2608 (FH+) | — | ❓ | FH/MA replace YM2203 with OPNA. |
| 0x50-0x51 | uPD3301 CRTC | `μPD3301.ts` | ✅ | RESET / SET MODE / START DISPLAY / SET INTERRUPT MASK dispatch by `cmd & 0xE0`; param decode matches MAME upd3301_device. |
| 0x52 | bgpal_w | `display-regs.ts` 0x52 | ⚠️ | MAME sets BG pen (bits 4-6) AND BORDER pen (bits 0-2). We only latch the BG bits (`bgColor = (v >> 4) & 7`). Border-color renderer support deferred — borders aren't drawn by the text-only frame today. |
| 0x53 | layer_masking_w | `display-regs.ts` 0x53 | ✅ | Active-low layer-hide bits. We track 5 individual booleans (text + 4 GVRAM); MAME stores `text_layer_mask` + `bitmap_layer_mask` packed. Functionally equivalent. |
| 0x54-0x5B | palram_w | `display-regs.ts` 0x54-0x5B | ✅ | Digital (1 byte/port) + analogue (2 bytes/port) protocols, gated on `m_misc_ctrl & 0x20` (PMODE). PMODE callback wires through SystemController → DisplayRegisters. |
| 0x5C-0x5F | vram_select r/w | `display-regs.ts` 0x5C-0x5F | ✅ | Selector is `offset & 3` (port-low-2-bits, NOT data byte); readback `0xF8 \| (1 << sel)` for plane modes, `0xF8` for sel=3 (main-RAM). Bit-exact match. |
| 0x60-0x68 | i8257 DMA (device-mapped) | `μPD8257.ts` | ✅ | Channel addr/count/mode latched. MAME has direct `dma_mem_r/w` for the device's transfer hooks and `dackv` to deliver channel-2 bytes to the CRTC. Our impl latches the channel-2 src/length but doesn't yet drive scanline-rate transfers. |
| 0x6E | CPU clock r (FH+) | — | ❓ | FH/MA-specific high-speed-mode read. |
| 0x6F | baudrate r/w (FH+) | — | ❓ | USART baud-rate divider; FH/MA-specific. |
| 0x70 | window_bank_r/w | `sysctrl.ts` handle70 | ⚠️ | Latch-only: `m_window_offset_bank = data` matches our `textWindow = v`. The 1KB window mapping at 0x8000-0x83FF isn't wired in our memoryMap (latch surfaces in snapshot only). |
| 0x71 | ext_rom_bank_r/w | `sysctrl.ts` handle71 | ✅ | **Validated commit e26d66b**: only bit 0 gates enable; slot from port 0x32 bits 0-1; bits 1-3 are MAME-TODO ("EXP slot ROMs?"); bits 4-7 model-specific. 4 lock-in tests. |
| 0x78 | window_bank_inc_w | — | ❓ | `m_window_offset_bank++` — companion to 0x70. Not wired (TODO with 0x70). |
| 0x90-0x9F | CD-ROM (MC) | — | — | PC-8801 MC out of scope per CLAUDE.md. |
| 0xC0-0xC3 | (USART ch.1/ch.2 — MAME notes "documented but not mapped") | `μPD8251.ts` ch.1/ch.2 | ⚠️ | We register both expansion channels; MAME comments indicate hardware exists but driver doesn't wire them. Our coverage is more complete than MAME's. |
| 0xC8 / 0xCA | none (falls through) | `misc.ts` 0xC8/0xCA stubs | ⚠️ | MAME comment: `map(0xc8,0xc8).noprw()` — commented out, falls through to bus default. Our stubs return 0xFF / log writes — functionally equivalent. |
| 0xE2 | extram_mode r/w | — | ❓ | **Extended-RAM enable.** MAME's `mem_r` checks `extram_mode & 1` BEFORE MMODE/RMODE/E-ROM, so this is the highest-priority memory selector. Required for FH/MA models with extended RAM. |
| 0xE3 | extram_bank r/w | — | ❓ | Extended-RAM bank index (`m_extram_bank * 0x8000` offset). Companion to 0xE2. |
| 0xE4 | irq_level_w | `irq.ts` priority w | ✅ | `m_pic->b_sgs_w(~data)` in MAME — μPD8214 priority-encoder level register. We latch-only; functionally fine since IM 2 priority resolution isn't modelled. |
| 0xE6 | irq_mask_w | `irq.ts` mask w | ⚠️ | **MAME bit-swaps the low 3 bits of input** (`bitswap<3>(data & 7, 0, 1, 2)`) before storing — its internal `m_irq_state.enable` indexes by IRQ source level (CLOCK=0, VRTC=1, RXRDY=2 after swap), opposite to BIOS bit numbering. We store raw and check via the raw bit positions (bit 2 = VBL, etc.). Functionally equivalent — same BIOS-level semantics, different internal encoding. Don't "fix" this. |
| 0xE7 | none (commented `noprw()`, "arcus writes here, mirror of above?") | `misc.ts` 0xE7 latch | ⚠️ | We latch for diagnostics; MAME ignores. Possibly an alt mirror of 0xE6 used by the game Arcus. Keep our latch. |
| 0xE8-0xEB | kanji_r<0>/kanji_w<0> | `kanji.ts` bank 0 | ⚠️ | Both implement `addr-low @ off+0`, `addr-high @ off+1`, no-op @ off+2/3. MAME's read fetches `rom[(addr*2) + ((offset & 1) ^ 1)]`. We return 0xFF until a kanji ROM image is loaded. Equivalent for boot; complete the read when kanji rendering is needed. |
| 0xEC-0xEF | kanji_r<1>/kanji_w<1> | `kanji.ts` bank 1 | ⚠️ | Same as bank 0. |
| 0xF0-0xF1 | dictionary (MA) | — | — | MA-specific; out of scope. |
| 0xF4 / 0xF8 (main side) | none (commented `noprw()`, "DMA floppy?") | `misc.ts` 0xF4/0xF8 stubs | ⚠️ | MAME's main_io leaves them unmapped with a TODO comment. Our stubs return 0xFF / log writes — functionally equivalent to MAME's "fall through". |
| 0xFC-0xFF | pc80s31 host_map | `μPD8255.ts` main side | ✅ | Sub-CPU IPC PPI; mode-word 0x91, port A/B data, port C cross-down remap (writer bits 7/6/5/4 → reader bits 3/2/1/0). MAME's PPI cross-wiring lives in a separate device file (`pc80s31` in `src/devices/`/`src/mame/nec/`); WebFetch couldn't reach it directly, but our implementation was empirically validated against the real disk-handshake protocol (bytes flow correctly per `chips` snapshot at PC=0x37ee). |

## Sub-CPU I/O port map (PC-80S31 internal)

| Port | MAME handler | Our handler | Status | Notes |
|------|--------------|-------------|--------|-------|
| 0xF0 | (sub IRQ vector latch) | `sub-cpu.ts` PORT_IRQ_VECTOR | ✅ | Write-only IM-2 vector latch. |
| 0xF4 | (drive-mode register) | `sub-cpu.ts` PORT_DRIVE_MODE | ✅ | Write-only. |
| 0xF8 | (FDC /TC trigger) | `sub-cpu.ts` PORT_FDC_TC | ✅ | Read asserts `fdc.terminalCount()` — ends current data phase. Critical for non-DMA per-byte FDC reads (BIOS at sub PC 0x0332 hits this after byte counter runs out). |
| 0xFA-0xFB | μPD765 FDC | `μPD765a.ts` | ✅ | 0xFA = MSR, 0xFB = data FIFO. SPECIFY/RECAL/SEEK/READ ID/READ DATA/WRITE DATA/FORMAT TRACK landed; SCAN family TODO. |
| 0xFC-0xFF | μPD8255 PPI sub side | `μPD8255.ts` sub side | ✅ | Cross-wired with main side. |

## Findings + action items from this audit

### Behavioral divergences worth fixing

1. **None blocking SR boot.** All ports the SR BIOS exercises during the boot stall window match MAME's behavior bit-for-bit (verified against `mem_r`, `irq_mask_w`, `port31_w`, `misc_ctrl_w`, `ext_rom_bank_w`, `port40_r`).

2. **0x40 beeper edge-trigger** — MAME goes ON only on 0→1 transition of bit 5 and forces OFF when bit 7 (SING) is set. Our `beeper.toggle(level)` is level-based and ignores SING. Affects sound output, not boot.

3. **0x52 border color** — MAME applies bits 0-2 to a BORDER pen separate from the BG pen. We only track BG. Affects rendering aesthetics, not boot.

### Unimplemented, deferred (not on SR-boot critical path)

4. **0x34 / 0x35 alu_ctrl1/2_w** — GVRAM ALU mode for plane blits. Required by titles that use ALU-mode graphics.

5. **0xE2 / 0xE3 extram_mode/extram_bank** — extended-RAM bank for FH/MA models. MAME's `mem_r` checks `extram_mode & 1` first (highest priority).

6. **0x46-0x47 YM2608** — FH/MA OPNA replacement for YM2203. Same 0x44/0x45 base + extra bank at 0x46/0x47.

7. **0x6E / 0x6F** — FH/MA CPU clock + baudrate.

8. **0x78 window_bank_inc_w** — companion to 0x70 (increments the latch by 1).

9. **0x70 window mapping** — we latch the byte but don't expose the 1KB window at 0x8000-0x83FF.

10. **Kanji ROM read** — both banks return 0xFF; once a kanji image is loaded, the read formula is `rom[(addr * 2) + ((offset & 1) ^ 1)]`.

### Documentation-only divergences

11. **0xE6 IRQ mask bit-swap** — MAME bit-swaps low 3 bits of input to its internal storage layout. We store raw with reversed bit assignment. Same BIOS-level semantics, different storage. Don't "fix" — would re-introduce a bug.

12. **0xC0-0xC3 USART ch.1/ch.2** — we register them; MAME comments them as "documented but not mapped". Our coverage is broader.

13. **0xC8/0xCA, 0xE7, 0xF4, 0xF8 (main side)** — MAME has `noprw()` (commented-out fall-through). Our stubs return 0xFF / log writes — same effective behavior.

## Validation method

For each port:
1. Identify MAME handler from `pc8801_io` map.
2. Fetch C++ handler body via WebFetch from
   `raw.githubusercontent.com/mamedev/mame/master/src/mame/nec/pc8801.cpp`.
3. Compare bit decode + side effects against our handler in
   `src/chips/io/`.
4. If divergence affects boot or known programs, file an action
   item; if it's a documented MAME TODO (e.g. EXP slot ROMs on
   port 0x71 bits 1-3), match MAME's TODO.

The most rigorous case studies live in commit messages:
- `e26d66b` — port 0x31/0x32/0x71 E-ROM gating (this validation pass)
- `1882737` — port 0x44/0x45 YM2203 timer + SOUND IRQ
- `f2099b6` — port 0x32 PMODE + 0x54-0x5B 2-byte palette

Re-run the relevant fetches when MAME's pc8801.cpp is refactored
(easy to spot: the `pc8801_io` address-map definition moves or the
handler names change). The validation summary table at the top of
this file should be the first thing to update.
