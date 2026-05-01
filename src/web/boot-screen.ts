import type { MD5Sum, ROMID } from "../flavours.js";
import {
  type PC88Config,
  PORT30,
  PORT31,
  type ROMDescriptor,
  type ROMManifest,
} from "../machines/config.js";
import { VARIANTS, variantSlug } from "../machines/variants/index.js";
import { md5 } from "./md5.js";
import { type BootSettings, type OpfsStore, type RomIndex } from "./opfs.js";

// Bit-name labels for the DIP-switch checkboxes on the boot screen.
// Order matches bit position; each entry maps the bit value to a
// short human label. Bits 6-7 of port30/31 are documented as
// "model-specific" so they stay as a hex input rather than checkboxes.
const PORT30_BITS: { mask: number; label: string }[] = [
  { mask: PORT30.COLS_80, label: "80-column text" },
  { mask: PORT30.MONO, label: "Monochrome" },
  { mask: PORT30.CARRIER_MARK, label: "Serial carrier mark" },
  { mask: PORT30.CASSETTE_MOTOR, label: "Cassette motor on" },
];

const PORT31_BITS: { mask: number; label: string }[] = [
  { mask: PORT31.LINES_200, label: "200 lines (else 400)" },
  { mask: PORT31.MMODE_RAM, label: "Boot from RAM (else ROM)" },
  { mask: PORT31.RMODE_N80, label: "N-BASIC (else N88-BASIC)" },
  { mask: PORT31.GRPH, label: "Graphics enabled" },
  { mask: PORT31.HCOLOR, label: "High-res colour" },
  { mask: PORT31.HIGHRES, label: "High-resolution mode" },
];

// USART rate selector — bits 4-5 of port30. Encoded as a radio group
// rather than two independent checkboxes since only the four named
// patterns are meaningful.
const USART_RATES: { mask: number; label: string }[] = [
  { mask: PORT30.USART_CMT600, label: "CMT 600 baud" },
  { mask: PORT30.USART_CMT1200, label: "CMT 1200 baud" },
  { mask: PORT30.USART_RS232, label: "RS-232C" },
  { mask: PORT30.USART_RS232_HIGH, label: "RS-232C (alt)" },
];

export interface BootRequest {
  config: PC88Config;
  port30: number;
  port31: number;
  roms: Map<ROMID, Uint8Array>;
}

export interface BootScreenDeps {
  store: OpfsStore;
  onBoot: (req: BootRequest) => void;
}

interface RomState {
  descriptor: ROMDescriptor;
  slot: keyof ROMManifest;
  cached: Uint8Array | null;
  uploaded: { bytes: Uint8Array; md5: MD5Sum } | null;
}

// Render the boot-screen form into `container`. The form lets the
// user pick a variant, see which ROMs are required + cached, drop
// missing ROMs as files, override DIP bits, and click Boot to hand
// off to the emulator. The form is the only UI surface visible
// before boot; once `onBoot` is called the caller is expected to
// hide `container` and reveal the running-emulator panels.
export async function renderBootScreen(
  container: HTMLElement,
  deps: BootScreenDeps,
): Promise<void> {
  const settings = (await deps.store.readJSON<BootSettings>("settings")) ?? {};
  const lastSlug = settings.variant;
  const initialVariant =
    VARIANTS.find((v) => variantSlug(v) === lastSlug) ?? VARIANTS[0];
  if (!initialVariant) throw new Error("variants list is empty");

  let currentVariant: PC88Config = initialVariant;
  let port30 = settings.port30Override ?? currentVariant.dipSwitches.port30;
  let port31 = settings.port31Override ?? currentVariant.dipSwitches.port31;
  const romState = new Map<ROMID, RomState>();

  container.innerHTML = "";
  container.classList.add("boot-screen");

  const heading = document.createElement("h1");
  heading.textContent = "PC-88 Emulator";
  container.appendChild(heading);

  if (!deps.store.persistent) {
    const banner = document.createElement("p");
    banner.className = "warn";
    banner.textContent =
      "OPFS unavailable — ROMs and settings will be lost on reload.";
    container.appendChild(banner);
  }

  // --- variant picker -----------------------------------------------
  const variantLabel = document.createElement("label");
  variantLabel.textContent = "Machine: ";
  const variantSelect = document.createElement("select");
  for (const v of VARIANTS) {
    const opt = document.createElement("option");
    opt.value = variantSlug(v);
    opt.textContent = `${v.model} (${v.releaseYear})`;
    if (v === currentVariant) opt.selected = true;
    variantSelect.appendChild(opt);
  }
  variantLabel.appendChild(variantSelect);
  container.appendChild(variantLabel);

  // --- ROM checklist -------------------------------------------------
  const romSection = document.createElement("section");
  romSection.className = "rom-section";
  const romHeading = document.createElement("h2");
  romHeading.textContent = "ROMs";
  romSection.appendChild(romHeading);
  const romList = document.createElement("ul");
  romList.className = "rom-list";
  romSection.appendChild(romList);
  container.appendChild(romSection);

  // --- DIP switches --------------------------------------------------
  const dipSection = document.createElement("section");
  dipSection.className = "dip-section";
  const dipHeading = document.createElement("h2");
  dipHeading.textContent = "DIP switches";
  dipSection.appendChild(dipHeading);
  container.appendChild(dipSection);

  const port30Box = makeDipBox(
    "Port 0x30 (port30)",
    PORT30_BITS,
    () => port30,
    (v) => {
      port30 = v;
      void persist();
    },
    USART_RATES,
    PORT30.USART_MASK,
  );
  const port31Box = makeDipBox(
    "Port 0x31 (port31)",
    PORT31_BITS,
    () => port31,
    (v) => {
      port31 = v;
      void persist();
    },
  );
  dipSection.appendChild(port30Box.element);
  dipSection.appendChild(port31Box.element);

  // --- boot button ---------------------------------------------------
  const bootRow = document.createElement("div");
  bootRow.className = "boot-row";
  const bootButton = document.createElement("button");
  bootButton.type = "button";
  bootButton.textContent = "Boot";
  bootButton.disabled = true;
  bootRow.appendChild(bootButton);
  const bootStatus = document.createElement("span");
  bootStatus.className = "boot-status";
  bootRow.appendChild(bootStatus);
  container.appendChild(bootRow);

  // --- behaviour -----------------------------------------------------
  variantSelect.addEventListener("change", () => {
    const slug = variantSelect.value;
    const next = VARIANTS.find((v) => variantSlug(v) === slug);
    if (!next) return;
    currentVariant = next;
    port30 = next.dipSwitches.port30;
    port31 = next.dipSwitches.port31;
    port30Box.refresh();
    port31Box.refresh();
    void rebuildRomList();
    void persist();
  });

  bootButton.addEventListener("click", () => {
    const roms = collectRoms();
    if (!roms) return;
    deps.onBoot({ config: currentVariant, port30, port31, roms });
  });

  function collectRoms(): Map<ROMID, Uint8Array> | null {
    const out = new Map<ROMID, Uint8Array>();
    for (const state of romState.values()) {
      const data = state.uploaded?.bytes ?? state.cached;
      if (!data) {
        if (state.descriptor.required) return null;
        continue;
      }
      out.set(state.descriptor.id, data);
    }
    return out;
  }

  async function persist(): Promise<void> {
    const next: BootSettings = {
      variant: variantSlug(currentVariant),
      port30Override: port30,
      port31Override: port31,
    };
    await deps.store.writeJSON("settings", next);
  }

  async function rebuildRomList(): Promise<void> {
    romState.clear();
    romList.innerHTML = "";
    const index =
      (await deps.store.readJSON<RomIndex>(
        `index-${variantSlug(currentVariant)}`,
      )) ?? ({} as RomIndex);

    for (const [slot, descriptor] of Object.entries(currentVariant.roms) as [
      keyof ROMManifest,
      ROMDescriptor | undefined,
    ][]) {
      if (!descriptor) continue;
      const cachedMd5 = index[descriptor.id];
      const cached = cachedMd5 ? await deps.store.readRom(cachedMd5) : null;
      // Validate cached bytes still md5 to the descriptor — protects
      // against ROMs whose checksums shifted after the descriptor
      // was tightened.
      const usable = cached && md5(cached) === descriptor.md5 ? cached : null;

      const state: RomState = {
        descriptor,
        slot,
        cached: usable,
        uploaded: null,
      };
      romState.set(descriptor.id, state);
      romList.appendChild(makeRomRow(state, index));
    }
    refreshBootButton();
  }

  function makeRomRow(state: RomState, index: RomIndex): HTMLLIElement {
    const li = document.createElement("li");
    li.className = "rom-row";

    const status = document.createElement("span");
    status.className = "rom-status";
    li.appendChild(status);

    const meta = document.createElement("span");
    meta.className = "rom-meta";
    meta.textContent = `${state.descriptor.id} (${state.descriptor.size} KB${
      state.descriptor.required ? "" : ", optional"
    })`;
    li.appendChild(meta);

    const fileInput = document.createElement("input");
    fileInput.type = "file";
    fileInput.accept = ".rom,application/octet-stream";
    fileInput.addEventListener("change", async () => {
      const file = fileInput.files?.[0];
      if (!file) return;
      const bytes = new Uint8Array(await file.arrayBuffer());
      const hash = md5(bytes);
      if (bytes.length !== state.descriptor.size * 1024) {
        status.textContent = `wrong size: ${bytes.length}`;
        status.className = "rom-status err";
        return;
      }
      if (hash !== state.descriptor.md5) {
        status.textContent = `md5 mismatch: ${hash}`;
        status.className = "rom-status err";
        return;
      }
      state.uploaded = { bytes, md5: hash };
      await deps.store.writeRom(hash, bytes);
      index[state.descriptor.id] = hash;
      await deps.store.writeJSON(`index-${variantSlug(currentVariant)}`, index);
      updateRowStatus(status, state);
      refreshBootButton();
    });
    li.appendChild(fileInput);

    updateRowStatus(status, state);
    return li;
  }

  function updateRowStatus(status: HTMLElement, state: RomState): void {
    if (state.uploaded) {
      status.textContent = "[uploaded]";
      status.className = "rom-status ok";
    } else if (state.cached) {
      status.textContent = "[cached]";
      status.className = "rom-status ok";
    } else if (state.descriptor.required) {
      status.textContent = "[missing]";
      status.className = "rom-status err";
    } else {
      status.textContent = "[optional, missing]";
      status.className = "rom-status warn";
    }
  }

  function refreshBootButton(): void {
    const missing: string[] = [];
    for (const state of romState.values()) {
      if (state.descriptor.required && !state.uploaded && !state.cached) {
        missing.push(state.descriptor.id);
      }
    }
    bootButton.disabled = missing.length > 0;
    bootStatus.textContent =
      missing.length === 0 ? "Ready." : `Missing: ${missing.join(", ")}`;
  }

  await rebuildRomList();
}

interface DipBox {
  element: HTMLElement;
  refresh: () => void;
}

function makeDipBox(
  title: string,
  bits: { mask: number; label: string }[],
  read: () => number,
  write: (next: number) => void,
  enumGroup?: { mask: number; label: string }[],
  enumMask?: number,
): DipBox {
  const wrap = document.createElement("fieldset");
  const legend = document.createElement("legend");
  legend.textContent = title;
  wrap.appendChild(legend);

  const checkboxes = bits.map((bit) => {
    const label = document.createElement("label");
    const cb = document.createElement("input");
    cb.type = "checkbox";
    cb.addEventListener("change", () => {
      const next = cb.checked ? read() | bit.mask : read() & ~bit.mask;
      write(next);
    });
    label.appendChild(cb);
    label.appendChild(document.createTextNode(` ${bit.label}`));
    wrap.appendChild(label);
    return { cb, mask: bit.mask };
  });

  const enumRadios =
    enumGroup && enumMask !== undefined
      ? enumGroup.map((opt) => {
          const label = document.createElement("label");
          const radio = document.createElement("input");
          radio.type = "radio";
          radio.name = `${title}-enum`;
          radio.addEventListener("change", () => {
            if (!radio.checked) return;
            write((read() & ~enumMask) | opt.mask);
          });
          label.appendChild(radio);
          label.appendChild(document.createTextNode(` ${opt.label}`));
          wrap.appendChild(label);
          return { radio, mask: opt.mask };
        })
      : [];

  // Hex view of bits 6-7 (model-specific) so the user can see + tweak
  // the upper byte directly. The value is the full byte; we leave
  // formatting to the user to dial in if they care.
  const hexLabel = document.createElement("label");
  hexLabel.textContent = "Raw byte (hex): ";
  const hexInput = document.createElement("input");
  hexInput.type = "text";
  hexInput.size = 4;
  hexInput.addEventListener("change", () => {
    const v = parseInt(hexInput.value, 16);
    if (!Number.isNaN(v) && v >= 0 && v <= 0xff) write(v);
    else refresh();
  });
  hexLabel.appendChild(hexInput);
  wrap.appendChild(hexLabel);

  function refresh(): void {
    const cur = read();
    for (const { cb, mask } of checkboxes) {
      cb.checked = (cur & mask) !== 0;
    }
    for (const { radio, mask } of enumRadios) {
      radio.checked = enumMask !== undefined && (cur & enumMask) === mask;
    }
    hexInput.value = cur.toString(16).padStart(2, "0");
  }
  refresh();

  return { element: wrap, refresh };
}
