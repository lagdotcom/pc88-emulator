import type { CPUSnapshot, DisasmLine } from "./protocol.js";

// Hex helpers — duplicated from src/tools.ts since the web bundle
// already pays for this small format work and importing the Node-
// flavoured helper drags in unrelated branding noise.
function w(v: number): string {
  return v.toString(16).padStart(4, "0");
}
function b(v: number): string {
  return v.toString(16).padStart(2, "0");
}

// 8-letter flag string for an F byte. Order matches the Z80
// convention (S Z Y H X P/V N C, MSB→LSB) so it scans like a
// debugger trace.
function flags(f: number): string {
  const bits = ["S", "Z", "Y", "H", "X", "P", "N", "C"];
  let out = "";
  for (let i = 0; i < 8; i++) {
    const bit = (f >> (7 - i)) & 1;
    out += bit ? bits[i]! : ".";
  }
  return out;
}

export class RegistersPanel {
  readonly element: HTMLElement;
  private readonly grid: HTMLElement;

  constructor() {
    this.element = document.createElement("section");
    this.element.className = "panel registers-panel";
    const heading = document.createElement("h2");
    heading.textContent = "Registers";
    this.element.appendChild(heading);
    this.grid = document.createElement("div");
    this.grid.className = "registers-grid";
    this.element.appendChild(this.grid);
  }

  render(cpu: CPUSnapshot): void {
    const f = cpu.AF & 0xff;
    const a = (cpu.AF >> 8) & 0xff;
    const f_ = cpu.AF_ & 0xff;
    const a_ = (cpu.AF_ >> 8) & 0xff;
    const rows = [
      ["PC", w(cpu.PC), "SP", w(cpu.SP)],
      ["A", b(a), "F", `${b(f)} ${flags(f)}`],
      ["BC", w(cpu.BC), "DE", w(cpu.DE)],
      ["HL", w(cpu.HL), "IX", w(cpu.IX)],
      ["IY", w(cpu.IY), "I:R", `${b(cpu.I)}:${b(cpu.R)}`],
      ["A'", b(a_), "F'", `${b(f_)} ${flags(f_)}`],
      ["BC'", w(cpu.BC_), "DE'", w(cpu.DE_)],
      ["HL'", w(cpu.HL_), "IM", String(cpu.im)],
      [
        "IFF",
        `${cpu.iff1 ? "1" : "."}${cpu.iff2 ? "2" : "."}`,
        "halted",
        cpu.halted ? "yes" : "no",
      ],
      ["cycles", String(cpu.cycles), "", ""],
    ];
    this.grid.textContent = "";
    for (const row of rows) {
      for (const cell of row) {
        const div = document.createElement("div");
        div.textContent = cell;
        this.grid.appendChild(div);
      }
    }
  }
}

export class DisasmPanel {
  readonly element: HTMLElement;
  private readonly pre: HTMLPreElement;

  constructor() {
    this.element = document.createElement("section");
    this.element.className = "panel disasm-panel";
    const heading = document.createElement("h2");
    heading.textContent = "Disassembly";
    this.element.appendChild(heading);
    this.pre = document.createElement("pre");
    this.pre.className = "disasm-pre";
    this.element.appendChild(this.pre);
  }

  render(pc: number, lines: DisasmLine[]): void {
    const out: string[] = [];
    for (const ln of lines) {
      const marker = ln.pc === pc ? "►" : " ";
      const bytesStr = ln.bytes.map(b).join(" ").padEnd(11);
      out.push(`${marker} ${w(ln.pc)}  ${bytesStr}  ${ln.mnemonic}`);
    }
    this.pre.textContent = out.join("\n");
  }
}

export interface MemoryPeekRequest {
  addr: number;
  count: number;
}

export class MemoryPanel {
  readonly element: HTMLElement;
  private readonly addrInput: HTMLInputElement;
  private readonly countInput: HTMLInputElement;
  private readonly out: HTMLPreElement;

  constructor(onPeek: (req: MemoryPeekRequest) => void) {
    this.element = document.createElement("section");
    this.element.className = "panel memory-panel";

    const heading = document.createElement("h2");
    heading.textContent = "Memory";
    this.element.appendChild(heading);

    const form = document.createElement("form");
    form.className = "memory-form";

    this.addrInput = document.createElement("input");
    this.addrInput.type = "text";
    this.addrInput.placeholder = "addr (e.g. 0x8000)";
    this.addrInput.value = "0x0000";
    this.addrInput.size = 10;

    this.countInput = document.createElement("input");
    this.countInput.type = "text";
    this.countInput.placeholder = "count";
    this.countInput.value = "64";
    this.countInput.size = 4;

    const submit = document.createElement("button");
    submit.type = "submit";
    submit.textContent = "Peek";

    form.appendChild(this.addrInput);
    form.appendChild(this.countInput);
    form.appendChild(submit);
    form.addEventListener("submit", (ev) => {
      ev.preventDefault();
      const addr = parseAddr(this.addrInput.value);
      const count = parseAddr(this.countInput.value);
      if (addr === null || count === null) return;
      onPeek({ addr, count });
    });
    this.element.appendChild(form);

    this.out = document.createElement("pre");
    this.out.className = "memory-out";
    this.element.appendChild(this.out);
  }

  render(addr: number, bytes: Uint8Array): void {
    const lines: string[] = [];
    const width = 16;
    for (let off = 0; off < bytes.length; off += width) {
      const lineAddr = (addr + off) & 0xffff;
      let hex = "";
      let ascii = "";
      for (let i = 0; i < width; i++) {
        const v = bytes[off + i];
        if (v === undefined) {
          hex += "   ";
          ascii += " ";
        } else {
          hex += b(v) + (i === 7 ? "  " : " ");
          ascii += v >= 0x20 && v < 0x7f ? String.fromCharCode(v) : ".";
        }
      }
      lines.push(`${w(lineAddr)}  ${hex.trimEnd().padEnd(48)}  ${ascii}`);
    }
    this.out.textContent = lines.join("\n");
  }
}

function parseAddr(s: string): number | null {
  const t = s.trim().toLowerCase();
  if (t.length === 0) return null;
  const v = t.startsWith("0x") ? parseInt(t.slice(2), 16) : parseInt(t, 16);
  return Number.isNaN(v) ? null : v & 0xffff;
}

// On-page REPL pane. Each typed line goes through the same
// dispatch() the CLI debugger uses; output streams back as `out`
// envelopes. The pane keeps a bounded history so a long-running
// `continue` with chatty watch logs doesn't blow up the DOM.
const REPL_MAX_LINES = 2000;

export class ReplPanel {
  readonly element: HTMLElement;
  private readonly input: HTMLInputElement;
  private readonly out: HTMLPreElement;
  private readonly history: string[] = [];
  private historyCursor = 0;

  constructor(onCommand: (line: string) => void) {
    this.element = document.createElement("section");
    this.element.className = "panel repl-panel";

    const heading = document.createElement("h2");
    heading.textContent = "Debugger REPL";
    this.element.appendChild(heading);

    this.out = document.createElement("pre");
    this.out.className = "repl-out";
    this.element.appendChild(this.out);

    const form = document.createElement("form");
    form.className = "repl-form";
    const prompt = document.createElement("span");
    prompt.className = "repl-prompt";
    prompt.textContent = ">";
    this.input = document.createElement("input");
    this.input.type = "text";
    this.input.spellcheck = false;
    this.input.autocomplete = "off";
    form.appendChild(prompt);
    form.appendChild(this.input);
    form.addEventListener("submit", (ev) => {
      ev.preventDefault();
      const line = this.input.value;
      if (line.trim().length === 0) return;
      this.append(`> ${line}\n`);
      this.history.push(line);
      this.historyCursor = this.history.length;
      this.input.value = "";
      onCommand(line);
    });
    this.input.addEventListener("keydown", (ev) => {
      if (ev.key === "ArrowUp") {
        if (this.historyCursor > 0) {
          this.historyCursor--;
          this.input.value = this.history[this.historyCursor] ?? "";
          ev.preventDefault();
        }
      } else if (ev.key === "ArrowDown") {
        if (this.historyCursor < this.history.length - 1) {
          this.historyCursor++;
          this.input.value = this.history[this.historyCursor] ?? "";
          ev.preventDefault();
        } else if (this.historyCursor === this.history.length - 1) {
          this.historyCursor = this.history.length;
          this.input.value = "";
          ev.preventDefault();
        }
      }
    });
    this.element.appendChild(form);
  }

  // Worker output arrives as arbitrary chunks. Append straight to
  // the <pre> and trim from the front when we exceed the history
  // cap — a long `continue` with chatty watch logs would otherwise
  // grow the DOM unboundedly.
  appendOutput(text: string): void {
    this.append(text);
  }

  private append(text: string): void {
    this.out.textContent = (this.out.textContent ?? "") + text;
    this.trim();
    this.out.scrollTop = this.out.scrollHeight;
  }

  private trim(): void {
    const content = this.out.textContent ?? "";
    const lines = content.split("\n");
    if (lines.length > REPL_MAX_LINES) {
      this.out.textContent = lines
        .slice(lines.length - REPL_MAX_LINES)
        .join("\n");
    }
  }

  focus(): void {
    this.input.focus();
  }
}
