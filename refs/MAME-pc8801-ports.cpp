uint8_t pc8801_state::ext_rom_bank_r()
{
	return m_ext_rom_bank;
}

void pc8801_state::ext_rom_bank_w(uint8_t data)
{
	// TODO: bits 1 to 3 written to at POST
	// selection for EXP slot ROMs?
	m_ext_rom_bank = data;
}

// inherited from pc8001.cpp
#if 0
void pc8801_state::port30_w(uint8_t data)
{
	m_txt_width = data & 1;
	m_txt_color = data & 2;

	m_cassette->change_state(BIT(data, 3) ? CASSETTE_MOTOR_ENABLED : CASSETTE_MOTOR_DISABLED, CASSETTE_MASK_MOTOR);
}
#endif

/*
 * I/O Port $31 (w/o) "System Control Port (2)"
 * N88-BASIC buffer port $e6c2
 *
 * --x- ---- 25LINE: line control in high speed CRT mode (1) 25 lines (0) 20 lines
 * ---x ---- HCOLOR: color graphic display mode
 * ---1 ----         color mode
 * ---0 ----         monochrome mode
 * ---- x--- GRPH: Graphic display mode yes (1) / no (0)
 * ---- -x-- RMODE: ROM mode control N-BASIC (1, ROM 1 & 2) / N88-BASIC (0, ROM 3 & 4)
 * ---- --x- MMODE: RAM mode control yes (1, full RAM) / no (0, ROM/RAM mixed)
 * ---- ---x 200LINE: 200 lines (1) / 400 lines (0) in 1bpp mode
 *
 */
void pc8801_state::port31_w(uint8_t data)
{
	m_gfx_ctrl = data;

//  set_screen_frequency((data & 0x11) != 0x11);
//  dynamic_res_change();
}

/*
 * I/O Port $40 reads "Strobe Port"
 *
 * 1--- ---- UOP2: SW1-8
 * -1-- ---- UOP1:
 * --x- ---- VRTC: vblank signal (0) display (1) vblank
 * ---x ---- CDI: upd1990a data read
 * ---- x--- /EXTON: Minidisc unit connection signal (SW2-7)
 * ---- -x-- DCD: SIO Data Carrier Detect signal (0) no carrier (1) with
 * ---- --x- /SHG: monitor resolution mode (0) high res (1) normal res
 * ---- ---x BUSY: printer (0) READY (1) BUSY
 *
 */
uint8_t pc8801_state::port40_r()
{
	// TODO: merge with PC8001
	uint8_t data = 0x00;

	data |= m_centronics_busy;
//  data |= m_centronics_ack << 1;
	data |= ioport("CTRL")->read() & 0xca;
	data |= m_rtc->data_out_r() << 4;
	data |= m_crtc->vrtc_r() << 5;
	// TODO: enable line from pc80s31k (bit 3, active_low)

	return data;
}

/*
 * I/O Port $40 writes "Strobe Port"
 * N88-BASIC buffer port $e6c1
 *
 * x--- ---- UOP2: general purpose output 2 / sound port
 *                 SING (buzzer mask?)
 * -x-- ---- UOP1: general purpose output 1
 *                 generally used for mouse latch (JOP1, routes on OPN sound port A)
 * --x- ---- BEEP: beeper enable
 * ---x ---- FLASH: flash mode control (active high)
 * ---- x--- /CLDS: "CRT I/F sync control" (init CRT and controller sync pulses?)
 * ---- -x-- CCK: upd1990a clock bit
 * ---- --x- CSTB: upd1990a strobe bit
 * ---- ---x /PSTB: printer strobe (active low)
 *
 */
void pc8801_state::port40_w(uint8_t data)
{
	// TODO: merge (and fix) from pc8001.cpp
	m_centronics->write_strobe(BIT(data, 0));

	m_rtc->stb_w(BIT(data, 1));
	m_rtc->clk_w(BIT(data, 2));

	if(((m_device_ctrl_data & 0x20) == 0x00) && ((data & 0x20) == 0x20))
		m_beeper->set_state(1);

	if(((m_device_ctrl_data & 0x20) == 0x20) && ((data & 0x20) == 0x00))
		m_beeper->set_state(0);

	m_mouse_port->pin_8_w(BIT(data, 6));

	// TODO: is SING a buzzer mask? bastard leaves beeper to ON state otherwise
	if(m_device_ctrl_data & 0x80)
		m_beeper->set_state(0);

	m_device_ctrl_data = data;
}

uint8_t pc8801_state::vram_select_r()
{
	return 0xf8 | ((m_vram_sel == 3) ? 0 : (1 << m_vram_sel));
}

void pc8801_state::vram_select_w(offs_t offset, uint8_t data)
{
	m_vram_sel = offset & 3;
}

void pc8801_state::irq_level_w(uint8_t data)
{
	m_pic->b_sgs_w(~data);
}

/*
 * ---- -x-- /RXMF RXRDY irq mask
 * ---- --x- /VRMF VRTC irq mask
 * ---- ---x /RTMF Real-time clock irq mask
 *
 */
void pc8801_state::irq_mask_w(uint8_t data)
{
	m_irq_state.enable &= ~7;
	// mapping reversed to the correlated irq levels
	m_irq_state.enable |= bitswap<3>(data & 7, 0, 1, 2);

	check_irq(RXRDY_IRQ_LEVEL);
	check_irq(VRTC_IRQ_LEVEL);
	check_irq(CLOCK_IRQ_LEVEL);
}


uint8_t pc8801_state::window_bank_r()
{
	return m_window_offset_bank;
}

void pc8801_state::window_bank_w(uint8_t data)
{
	m_window_offset_bank = data;
}

void pc8801_state::window_bank_inc_w(uint8_t data)
{
	m_window_offset_bank ++;
	m_window_offset_bank &= 0xff;
}

/*
 * I/O Port $32 (R/W)
 * Not on vanilla PC-8801 (mkII onward)
 *
 * x--- ---- sound irq mask (0) irq enabled (1) irq masked
 * -x-- ---- Graphic VRAM access mode (0) independent access mode (1) ALU mode
 * --x- ---- analog (1) / digital (0) palette select
 * ---x ---- high speed RAM select (for TVRAM) (1) main RAM bank (0) dedicated Text RAM
 * ---- xx-- Screen output mode
 * ---- 00-- TV / video mode
 * ---- 01-- None (as in disabling the screen entirely?)
 * ---- 10-- Analog RGB mode
 * ---- 11-- Optional mode
 * ---- --xx internal EROM selection
 */
uint8_t pc8801_state::misc_ctrl_r()
{
	return m_misc_ctrl;
}

void pc8801_state::misc_ctrl_w(uint8_t data)
{
	m_misc_ctrl = data;

	m_sound_irq_enable = ((data & 0x80) == 0);

	// Note: this will map to no irq anyway if there isn't any device interested in INT4
	if (m_sound_irq_enable)
		int4_irq_w(m_sound_irq_pending);
}

/*
 * I/O Port $52 "Border and background color control"
 *
 * -RGB ---- BGx: Background color, index for pen #0
 * ---- -RGB Rx: Border color
 *
 * NB: according to several sources a non-vanilla PC8801 hardwires border to black,
 *     leaving this portion unconnected.
 *     For debugging reasons we leave it in for every machine instead.
 *
 */
void pc8801_state::bgpal_w(uint8_t data)
{
	// sorcerml uses BG Pal extensively:
	// - On bootup message it sets register $54 to white and bgpal to 0, expecting the layer to be transparent;
	// - On playlist sets BG Pal to 0x10 (blue background);
	m_palette->set_pen_color(BGPAL_PEN, pal1bit(BIT(data, 6)), pal1bit(BIT(data, 5)), pal1bit(BIT(data, 4)));
	m_palette->set_pen_color(BORDER_PEN, pal1bit(BIT(data, 2)), pal1bit(BIT(data, 1)), pal1bit(BIT(data, 0)));
}

void pc8801_state::palram_w(offs_t offset, uint8_t data)
{
	if(m_misc_ctrl & 0x20) //analog palette
	{
		if((data & 0x40) == 0)
		{
			m_palram[offset].b = data & 0x7;
			m_palram[offset].r = (data & 0x38) >> 3;
		}
		else
		{
			m_palram[offset].g = data & 0x7;
		}
	}
	else //digital palette
	{
		m_palram[offset].b = data & 1 ? 7 : 0;
		m_palram[offset].r = data & 2 ? 7 : 0;
		m_palram[offset].g = data & 4 ? 7 : 0;
	}

	// TODO: What happens to the palette contents when the analog/digital palette mode changes?
	// Preserve content? Translation? Undefined?
	m_palette->set_pen_color(offset, pal3bit(m_palram[offset].r), pal3bit(m_palram[offset].g), pal3bit(m_palram[offset].b));
	// TODO: at least analog mode can do rasters, unconfirmed for digital mode
	// p8suite Analog RGB test cross bars (reportedly works in 24 kHz / 80 column only)
	// NB: it uses a bunch of non-waitstate related opcodes to cycle time it right,
	// implying a stress-test for Z80 opcode cycles.
	m_screen->update_partial(m_screen->vpos());
}


/*
 * ---- x--- green gvram masked flag
 * ---- -x-- red gvram masked flag
 * ---- --x- blue gvram masked flag
 * ---- ---x text vram masked
 */
void pc8801_state::layer_masking_w(uint8_t data)
{
	m_text_layer_mask = bool(BIT(data, 0));
	m_bitmap_layer_mask = ((data & 0xe) >> 1) ^ 7;
}

uint8_t pc8801_state::extram_mode_r()
{
	return (m_extram_mode ^ 0x11) | 0xee;
}

void pc8801_state::extram_mode_w(uint8_t data)
{
	/*
	---x ---- Write EXT RAM access at 0x0000 - 0x7fff
	---- ---x Read EXT RAM access at 0x0000 - 0x7fff
	*/

	m_extram_mode = data & 0x11;
}

uint8_t pc8801_state::extram_bank_r()
{
	return m_extram_bank;
}

void pc8801_state::extram_bank_w(uint8_t data)
{
	// TODO: bits 2 and 3 also accesses bank for PC-8801-17 "VAB" card
	m_extram_bank = data;
}

void pc8801_state::alu_ctrl1_w(uint8_t data)
{
	m_alu_ctrl1 = data;
}

void pc8801_state::alu_ctrl2_w(uint8_t data)
{
	m_alu_ctrl2 = data;
}

/*
 * $e8-$eb kanji LV1
 * $ec-$ef kanji LV2
 *
 */
template <unsigned kanji_level> uint8_t pc8801_state::kanji_r(offs_t offset)
{
	if((offset & 2) == 0)
	{
		const u8 *kanji_rom = kanji_level ? m_kanji_lv2_rom : m_kanji_rom;
		const u32 kanji_address = (m_knj_addr[kanji_level] * 2) + ((offset & 1) ^ 1);
		return kanji_rom[kanji_address];
	}

	return 0xff;
}

template <unsigned kanji_level> void pc8801_state::kanji_w(offs_t offset, uint8_t data)
{
	if((offset & 2) == 0)
	{
		m_knj_addr[kanji_level] = (
			((offset & 1) == 0) ?
			((m_knj_addr[kanji_level] & 0xff00) | (data & 0xff)) :
			((m_knj_addr[kanji_level] & 0x00ff) | (data << 8))
		);
	}
	// TODO: document and implement what the upper two regs does
	// read latches on write? "read start/end sign" according to
	// https://retrocomputerpeople.web.fc2.com/machines/nec/8801/io_map88.html
}


/*
 * PC8801FH overrides (CPU clock switch)
 */

uint8_t pc8801fh_state::cpuclock_r()
{
	return 0x10 | m_clock_setting;
}

uint8_t pc8801fh_state::baudrate_r()
{
	return 0xf0 | m_baudrate_val;
}

void pc8801fh_state::baudrate_w(uint8_t data)
{
	m_baudrate_val = data & 0xf;
}

/*
 * PC8801MA overrides (dictionary)
 */

inline uint8_t pc8801ma_state::dictionary_rom_r(offs_t offset)
{
	return m_dictionary_rom[offset + ((m_dic_bank & 0x1f) * 0x4000)];
}

inline bool pc8801ma_state::dictionary_rom_enable()
{
	return m_dic_ctrl;
}

void pc8801ma_state::dic_bank_w(uint8_t data)
{
	m_dic_bank = data & 0x1f;
}

void pc8801ma_state::dic_ctrl_w(uint8_t data)
{
	m_dic_ctrl = (data ^ 1) & 1;
}

/*
 * PC8801MC overrides (CD-ROM)
 */

inline uint8_t pc8801mc_state::cdbios_rom_r(offs_t offset)
{
	return m_cdrom_bios[offset | ((m_gfx_ctrl & 4) ? 0x8000 : 0x0000)];
}

inline bool pc8801mc_state::cdbios_rom_enable()
{
	return m_cdrom_bank;
}

void pc8801_state::main_io(address_map &map)
{
	map.global_mask(0xff);
	map.unmap_value_high();
	map(0x00, 0x00).portr("KEY0");
	map(0x01, 0x01).portr("KEY1");
	map(0x02, 0x02).portr("KEY2");
	map(0x03, 0x03).portr("KEY3");
	map(0x04, 0x04).portr("KEY4");
	map(0x05, 0x05).portr("KEY5");
	map(0x06, 0x06).portr("KEY6");
	map(0x07, 0x07).portr("KEY7");
	map(0x08, 0x08).portr("KEY8");
	map(0x09, 0x09).portr("KEY9");
	map(0x0a, 0x0a).portr("KEY10");
	map(0x0b, 0x0b).portr("KEY11");
	map(0x0c, 0x0c).portr("KEY12");
	map(0x0d, 0x0d).portr("KEY13");
	map(0x0e, 0x0e).portr("KEY14");
	map(0x0f, 0x0f).portr("KEY15");
	map(0x10, 0x10).w(FUNC(pc8801_state::port10_w));
	map(0x20, 0x21).mirror(0x0e).rw(m_usart, FUNC(i8251_device::read), FUNC(i8251_device::write)); // CMT / RS-232C ch. 0
	map(0x30, 0x30).portr("DSW1").w(FUNC(pc8801_state::port30_w));
	map(0x31, 0x31).portr("DSW2").w(FUNC(pc8801_state::port31_w));
	map(0x32, 0x32).rw(FUNC(pc8801_state::misc_ctrl_r), FUNC(pc8801_state::misc_ctrl_w));
//  map(0x33, 0x33) PC8001mkIISR port, mirror on PC8801?
	// TODO: ALU not installed on pre-mkIISR machines
	// NB: anything after 0x32 reads 0xff on a PC8801MA real HW test
	map(0x34, 0x34).w(FUNC(pc8801_state::alu_ctrl1_w));
	map(0x35, 0x35).w(FUNC(pc8801_state::alu_ctrl2_w));
//  map(0x35, 0x35).r <unknown>, accessed by cancanb during OP, mistake? Mirror for intended HW?
	map(0x40, 0x40).rw(FUNC(pc8801_state::port40_r), FUNC(pc8801_state::port40_w));
//  map(0x44, 0x47).rw internal OPN/OPNA sound card for 8801mkIISR and beyond
//  uPD3301
	map(0x50, 0x51).rw(m_crtc, FUNC(upd3301_device::read), FUNC(upd3301_device::write));

	map(0x52, 0x52).w(FUNC(pc8801_state::bgpal_w));
	map(0x53, 0x53).w(FUNC(pc8801_state::layer_masking_w));
	map(0x54, 0x5b).w(FUNC(pc8801_state::palram_w));
	map(0x5c, 0x5c).r(FUNC(pc8801_state::vram_select_r));
	map(0x5c, 0x5f).w(FUNC(pc8801_state::vram_select_w));
//  i8257
	map(0x60, 0x68).rw(m_dma, FUNC(i8257_device::read), FUNC(i8257_device::write));

//  map(0x6e, 0x6f) clock settings (8801FH and later)
	map(0x70, 0x70).rw(FUNC(pc8801_state::window_bank_r), FUNC(pc8801_state::window_bank_w));
	map(0x71, 0x71).rw(FUNC(pc8801_state::ext_rom_bank_r), FUNC(pc8801_state::ext_rom_bank_w));
	map(0x78, 0x78).w(FUNC(pc8801_state::window_bank_inc_w));
//  map(0x82, 0x82).w access window for PC8801-16
//  map(0x8e, 0x8e).r <unknown>, accessed by scruiser on boot (a board ID?)
//  map(0x90, 0x9f) PC-8801-31 CD-ROM i/f (8801MC)
//  map(0xa0, 0xa3) GSX-8800 or network board
//  map(0xa8, 0xad).rw expansion OPN (Sound Board) or OPNA (Sound Board II)
//  map(0xb0, 0xb3) General Purpose I/O
//  map(0xb4, 0xb4) PC-8801-17 Video art board
//  map(0xb5, 0xb5) PC-8801-18 Video digitizing unit
//  map(0xbc, 0xbf) External mini floppy disk I/F (i8255), PC-8801-13 / -20 / -22
//  map(0xc0, 0xc3) USART RS-232C ch. 1 / ch. 2
//  map(0xc4, 0xc7) PC-8801-10 Music interface board (MIDI), GSX-8800 PIT?
//  map(0xc8, 0xc8) RS-232C ch. 1 "prohibited gate" (?)
//  map(0xca, 0xca) RS-232C ch. 2 "prohibited gate" (?)
//  map(0xc8, 0xcd) JMB-X1 OPM / SSG chips
//  map(0xd0, 0xdf) GP-IB
//  map(0xd3, 0xd4) PC-8801-10 Music interface board (MIDI)
//  map(0xdc, 0xdf) PC-8801-12 MODEM (built-in for mkIITR)
	// $e2-$e3 are standard for mkIIMR, MH / MA / MA2 / MC
	// also used by expansion boards -02 / -02N, -22,
	// and -17 video art board (transfers from RAM?)
	map(0xe2, 0xe2).rw(FUNC(pc8801_state::extram_mode_r), FUNC(pc8801_state::extram_mode_w));
	map(0xe3, 0xe3).rw(FUNC(pc8801_state::extram_bank_r), FUNC(pc8801_state::extram_bank_w));
	map(0xe4, 0xe4).w(FUNC(pc8801_state::irq_level_w));
	map(0xe6, 0xe6).w(FUNC(pc8801_state::irq_mask_w));
//  map(0xe7, 0xe7).noprw(); /* arcus writes here, mirror of above? */
	map(0xe8, 0xeb).rw(FUNC(pc8801_state::kanji_r<0>), FUNC(pc8801_state::kanji_w<0>));
	map(0xec, 0xef).rw(FUNC(pc8801_state::kanji_r<1>), FUNC(pc8801_state::kanji_w<1>));
//  map(0xf0, 0xf1) dictionary bank (8801MA and later)
//  map(0xf3, 0xf3) DMA floppy (direct access like PC88VA?)
//  map(0xf4, 0xf7) DMA 5'25-inch floppy (?)
//  map(0xf8, 0xfb) DMA 8-inch floppy (?)
	map(0xfc, 0xff).m(m_pc80s31, FUNC(pc80s31_device::host_map));
}

void pc8801mk2sr_state::main_io(address_map &map)
{
	pc8801_state::main_io(map);
	map(0x44, 0x45).rw(m_opn, FUNC(ym2203_device::read), FUNC(ym2203_device::write));
}

void pc8801fh_state::main_io(address_map &map)
{
	pc8801_state::main_io(map);
	map(0x44, 0x47).rw(m_opna, FUNC(ym2608_device::read), FUNC(ym2608_device::write));

	map(0x6e, 0x6e).r(FUNC(pc8801fh_state::cpuclock_r));
	map(0x6f, 0x6f).rw(FUNC(pc8801fh_state::baudrate_r), FUNC(pc8801fh_state::baudrate_w));
}

void pc8801ma_state::main_io(address_map &map)
{
	pc8801fh_state::main_io(map);
	map(0xf0, 0xf0).w(FUNC(pc8801ma_state::dic_bank_w));
	map(0xf1, 0xf1).w(FUNC(pc8801ma_state::dic_ctrl_w));
}

void pc8801mc_state::main_io(address_map &map)
{
	pc8801ma_state::main_io(map);
