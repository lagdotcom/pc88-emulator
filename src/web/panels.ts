import { byte as b, word as w } from "../tools.js";
import type {
  BreakpointSnapshot,
  CallFrameSnapshot,
  CPUSnapshot,
  DisasmLine,
  PortWatch,
  RamWatch,
} from "./protocol.js";

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

  render(pc: number, lines: DisasmLine[], breakpoints: number[]): void {
    const bps = new Set(breakpoints);
    const out: string[] = [];
    for (const ln of lines) {
      // Per-row label header: only emitted on exact matches, no
      // fuzzy `name+N` fall-through (that belongs in operand
      // resolution, not row headers — otherwise every mid-function
      // instruction would print its own header).
      if (ln.label !== undefined) out.push(`${ln.label}:`);
      // Two-character marker column: a red bullet for an active
      // breakpoint, then a play-head arrow for the current PC. Both
      // independent so a breakpoint at PC shows both glyphs.
      const bp = bps.has(ln.pc) ? "●" : " ";
      const cur = ln.pc === pc ? "►" : " ";
      const bytesStr = ln.bytes.map(b).join(" ").padEnd(11);
      out.push(`${bp}${cur} ${w(ln.pc)}  ${bytesStr}  ${ln.mnemonic}`);
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

  render(addr: number, bytes: Uint8Array, label?: string): void {
    const lines: string[] = [];
    if (label) lines.push(`${label}:`);
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

// Panels 4c — breakpoints / watches / stack — share the same shape:
// a heading + a list rendered into a scrollable region, optionally
// with an "add" form. Each list row exposes a × button that posts
// the appropriate REPL command back through the worker channel so
// state stays in lockstep with what the dispatcher would do via the
// REPL pane.

export interface PanelCommandSink {
  (line: string): void;
}

export class BreakpointsPanel {
  readonly element: HTMLElement;
  private readonly list: HTMLElement;
  private readonly addrInput: HTMLInputElement;

  constructor(private readonly send: PanelCommandSink) {
    this.element = document.createElement("section");
    this.element.className = "panel breakpoints-panel";

    const heading = document.createElement("h2");
    heading.textContent = "Breakpoints";
    this.element.appendChild(heading);

    const form = document.createElement("form");
    form.className = "panel-add-form";
    this.addrInput = document.createElement("input");
    this.addrInput.type = "text";
    this.addrInput.placeholder = "addr (e.g. 0x5550)";
    this.addrInput.size = 12;
    const submit = document.createElement("button");
    submit.type = "submit";
    submit.textContent = "+";
    form.appendChild(this.addrInput);
    form.appendChild(submit);
    form.addEventListener("submit", (ev) => {
      ev.preventDefault();
      const addr = parseAddr(this.addrInput.value);
      if (addr === null) return;
      this.send(`break 0x${w(addr)}`);
      this.addrInput.value = "";
    });
    this.element.appendChild(form);

    this.list = document.createElement("ul");
    this.list.className = "watch-list";
    this.element.appendChild(this.list);
  }

  render(breakpoints: BreakpointSnapshot[]): void {
    this.list.textContent = "";
    if (breakpoints.length === 0) {
      const empty = document.createElement("li");
      empty.className = "watch-empty";
      empty.textContent = "(no breakpoints)";
      this.list.appendChild(empty);
      return;
    }
    const sorted = [...breakpoints].sort((a, b) => a.addr - b.addr);
    for (const bp of sorted) {
      const li = document.createElement("li");
      const text = document.createElement("span");
      text.textContent = bp.label
        ? `0x${w(bp.addr)} ${bp.label}`
        : `0x${w(bp.addr)}`;
      const remove = document.createElement("button");
      remove.type = "button";
      remove.textContent = "×";
      remove.title = "Remove breakpoint";
      remove.addEventListener("click", () => this.send(`bd 0x${w(bp.addr)}`));
      li.appendChild(text);
      li.appendChild(remove);
      this.list.appendChild(li);
    }
  }
}

export class WatchesPanel {
  readonly element: HTMLElement;
  private readonly ramList: HTMLElement;
  private readonly portList: HTMLElement;
  private readonly ramAddr: HTMLInputElement;
  private readonly ramMode: HTMLSelectElement;
  private readonly ramAction: HTMLSelectElement;
  private readonly portAddr: HTMLInputElement;
  private readonly portMode: HTMLSelectElement;
  private readonly portAction: HTMLSelectElement;

  constructor(private readonly send: PanelCommandSink) {
    this.element = document.createElement("section");
    this.element.className = "panel watches-panel";

    const heading = document.createElement("h2");
    heading.textContent = "Watches";
    this.element.appendChild(heading);

    const ramHeading = document.createElement("h3");
    ramHeading.textContent = "RAM";
    this.element.appendChild(ramHeading);
    const ramForm = document.createElement("form");
    ramForm.className = "panel-add-form";
    this.ramAddr = document.createElement("input");
    this.ramAddr.type = "text";
    this.ramAddr.placeholder = "addr";
    this.ramAddr.size = 8;
    this.ramMode = makeSelect(["rw", "r", "w"]);
    this.ramAction = makeSelect(["break", "log"]);
    const ramSubmit = document.createElement("button");
    ramSubmit.type = "submit";
    ramSubmit.textContent = "+";
    ramForm.appendChild(this.ramAddr);
    ramForm.appendChild(this.ramMode);
    ramForm.appendChild(this.ramAction);
    ramForm.appendChild(ramSubmit);
    ramForm.addEventListener("submit", (ev) => {
      ev.preventDefault();
      const addr = parseAddr(this.ramAddr.value);
      if (addr === null) return;
      // Always emit 0x-prefixed hex so debug.ts's parseAddr can't
      // re-interpret an all-digit address as decimal — `bw 0100 …`
      // means 0x0100 to the UI but 100-decimal to dispatch, and the
      // mismatch leaves the × button removing the wrong entry.
      this.send(
        `bw 0x${w(addr)} ${this.ramMode.value} ${this.ramAction.value}`,
      );
      this.ramAddr.value = "";
    });
    this.element.appendChild(ramForm);
    this.ramList = document.createElement("ul");
    this.ramList.className = "watch-list";
    this.element.appendChild(this.ramList);

    const portHeading = document.createElement("h3");
    portHeading.textContent = "Ports";
    this.element.appendChild(portHeading);
    const portForm = document.createElement("form");
    portForm.className = "panel-add-form";
    this.portAddr = document.createElement("input");
    this.portAddr.type = "text";
    this.portAddr.placeholder = "port";
    this.portAddr.size = 6;
    this.portMode = makeSelect(["rw", "r", "w"]);
    this.portAction = makeSelect(["break", "log"]);
    const portSubmit = document.createElement("button");
    portSubmit.type = "submit";
    portSubmit.textContent = "+";
    portForm.appendChild(this.portAddr);
    portForm.appendChild(this.portMode);
    portForm.appendChild(this.portAction);
    portForm.appendChild(portSubmit);
    portForm.addEventListener("submit", (ev) => {
      ev.preventDefault();
      const port = parseAddr(this.portAddr.value);
      if (port === null) return;
      this.send(
        `bp 0x${b(port & 0xff)} ${this.portMode.value} ${this.portAction.value}`,
      );
      this.portAddr.value = "";
    });
    this.element.appendChild(portForm);
    this.portList = document.createElement("ul");
    this.portList.className = "watch-list";
    this.element.appendChild(this.portList);
  }

  render(ram: RamWatch[], ports: PortWatch[]): void {
    this.ramList.textContent = "";
    if (ram.length === 0) {
      const empty = document.createElement("li");
      empty.className = "watch-empty";
      empty.textContent = "(no RAM watches)";
      this.ramList.appendChild(empty);
    } else {
      const sorted = [...ram].sort((a, b) => a.addr - b.addr);
      for (const w_ of sorted) {
        const li = document.createElement("li");
        const text = document.createElement("span");
        const labelTag = w_.label ? ` ${w_.label}` : "";
        text.textContent = `0x${w(w_.addr)}${labelTag} ${w_.mode} ${w_.action}`;
        const remove = document.createElement("button");
        remove.type = "button";
        remove.textContent = "×";
        remove.title = "Remove RAM watch";
        remove.addEventListener("click", () =>
          this.send(`unbw 0x${w(w_.addr)}`),
        );
        li.appendChild(text);
        li.appendChild(remove);
        this.ramList.appendChild(li);
      }
    }

    this.portList.textContent = "";
    if (ports.length === 0) {
      const empty = document.createElement("li");
      empty.className = "watch-empty";
      empty.textContent = "(no port watches)";
      this.portList.appendChild(empty);
    } else {
      const sorted = [...ports].sort((a, b) => a.port - b.port);
      for (const p of sorted) {
        const li = document.createElement("li");
        const text = document.createElement("span");
        const labelTag = p.label ? ` ${p.label}` : "";
        text.textContent = `0x${b(p.port)}${labelTag} ${p.mode} ${p.action}`;
        const remove = document.createElement("button");
        remove.type = "button";
        remove.textContent = "×";
        remove.title = "Remove port watch";
        remove.addEventListener("click", () =>
          this.send(`unbp 0x${b(p.port)}`),
        );
        li.appendChild(text);
        li.appendChild(remove);
        this.portList.appendChild(li);
      }
    }
  }
}

export class StackPanel {
  readonly element: HTMLElement;
  private readonly pre: HTMLPreElement;

  constructor() {
    this.element = document.createElement("section");
    this.element.className = "panel stack-panel";
    const heading = document.createElement("h2");
    heading.textContent = "Call stack";
    this.element.appendChild(heading);
    this.pre = document.createElement("pre");
    this.pre.className = "stack-pre";
    this.element.appendChild(this.pre);
  }

  render(frames: CallFrameSnapshot[]): void {
    if (frames.length === 0) {
      this.pre.textContent = "(empty)";
      return;
    }
    const lines: string[] = [];
    // Render top-of-stack first (most recent call is at the end of
    // the array; the user wants to see the deepest frame at the top).
    // Labels: prefer `target` over `from` because the called routine
    // name is more informative when scanning the stack. Fuzzy
    // `name+N` matches OK — they show where in the routine the call
    // landed (typically a CALL site near the start).
    const padTo = (s: string, n: number): string =>
      s.length >= n ? s : s + " ".repeat(n - s.length);
    let widestTarget = 0;
    for (const f of frames) {
      const tgt = `${w(f.target)}${f.targetLabel ? " " + f.targetLabel : ""}`;
      if (tgt.length > widestTarget) widestTarget = tgt.length;
    }
    for (let i = frames.length - 1; i >= 0; i--) {
      const f = frames[i]!;
      const tgt = `${w(f.target)}${f.targetLabel ? " " + f.targetLabel : ""}`;
      const from = f.fromLabel
        ? `${w(f.fromPC)} ${f.fromLabel}`
        : w(f.fromPC);
      lines.push(
        `${f.via.padEnd(4)} ${from} → ${padTo(tgt, widestTarget)}  ret=${w(f.expectedReturn)}  sp=${w(f.spAtCall)}`,
      );
    }
    this.pre.textContent = lines.join("\n");
  }
}

function makeSelect(options: string[]): HTMLSelectElement {
  const sel = document.createElement("select");
  for (const opt of options) {
    const o = document.createElement("option");
    o.value = opt;
    o.textContent = opt;
    sel.appendChild(o);
  }
  return sel;
}

// Upload + merge `.sym` files. Reads each picked file as text, posts
// to the worker as a single `importSyms` request (the worker handles
// destination matching by md5 → filename → explicit scope), and
// renders the per-file result.

export interface ImportSymsResult {
  fileName: string;
  scope: string | null;
  matchedBy: "md5" | "filename" | "explicit" | "none";
  merged: number;
  reason?: string;
}

export class ImportSymsPanel {
  readonly element: HTMLElement;
  private readonly out: HTMLPreElement;

  constructor(
    onUpload: (files: { name: string; text: string; scope?: string }[]) => void,
  ) {
    this.element = document.createElement("section");
    this.element.className = "panel import-syms-panel";

    const heading = document.createElement("h2");
    heading.textContent = "Import labels (.sym)";
    this.element.appendChild(heading);

    const form = document.createElement("form");
    form.className = "panel-add-form";
    const input = document.createElement("input");
    input.type = "file";
    input.multiple = true;
    input.accept = ".sym,text/plain";
    form.appendChild(input);
    input.addEventListener("change", () => {
      const files = Array.from(input.files ?? []);
      input.value = "";
      if (files.length === 0) return;
      void Promise.all(
        files.map(async (f) => ({ name: f.name, text: await f.text() })),
      ).then((payload) => onUpload(payload));
    });
    this.element.appendChild(form);

    this.out = document.createElement("pre");
    this.out.className = "import-syms-out";
    this.element.appendChild(this.out);
  }

  render(results: ImportSymsResult[]): void {
    if (results.length === 0) {
      this.out.textContent = "";
      return;
    }
    const lines = results.map((r) => {
      if (r.scope === null) {
        return `✗ ${r.fileName}: ${r.reason ?? "no destination"}`;
      }
      const tag = r.matchedBy === "md5" ? "(md5)" : `(${r.matchedBy})`;
      return `✓ ${r.fileName} → ${r.scope} ${tag}: ${r.merged} symbol${r.merged === 1 ? "" : "s"}${r.merged === 0 && r.reason ? ` — ${r.reason}` : ""}`;
    });
    this.out.textContent = lines.join("\n");
  }
}
