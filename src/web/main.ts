import type { ROMID } from "../flavours.js";
import { getLogger } from "../log.js";
import { type PC88Config } from "../machines/config.js";
import { type BootRequest, renderBootScreen } from "./boot-screen.js";
import { CanvasTextRenderer } from "./canvas-renderer.js";
import { openStore } from "./opfs.js";
import {
  BreakpointsPanel,
  DisasmPanel,
  MemoryPanel,
  RegistersPanel,
  ReplPanel,
  StackPanel,
  WatchesPanel,
} from "./panels.js";
import type { WorkerInbound, WorkerOutbound } from "./protocol.js";

const log = getLogger("web");

// Web entry. Renders the boot screen, spawns the emulator worker on
// boot, and forwards user actions (run/pause/step/reset) as protocol
// messages. The worker owns the CPU loop end-to-end; the main thread
// only renders frame updates posted back as `tick` / `stopped`.

async function main(): Promise<void> {
  const store = await openStore();

  const root = document.getElementById("app");
  if (!root) throw new Error("missing #app element");

  await renderBootScreen(root, {
    store,
    onBoot: (req) => {
      void boot(req, root);
    },
  });
}

interface RunningUI {
  renderer: CanvasTextRenderer;
  asciiPre: HTMLPreElement;
  status: HTMLElement;
  runButton: HTMLButtonElement;
  pauseButton: HTMLButtonElement;
  stepButton: HTMLButtonElement;
  resetButton: HTMLButtonElement;
  registers: RegistersPanel;
  disasm: DisasmPanel;
  memory: MemoryPanel;
  breakpoints: BreakpointsPanel;
  watches: WatchesPanel;
  stack: StackPanel;
  repl: ReplPanel;
}

async function boot(req: BootRequest, root: HTMLElement): Promise<void> {
  const config = applyDipOverrides(req.config, req.port30, req.port31);
  log.info(`booting ${config.model}`);

  const worker = new Worker(new URL("./worker.js", import.meta.url), {
    type: "module",
  });

  root.innerHTML = "";
  const ui = renderRunningView(root, config, worker);

  worker.addEventListener("message", (ev: MessageEvent<WorkerOutbound>) => {
    const msg = ev.data;
    switch (msg.type) {
      case "ready":
        break;
      case "tick":
        renderFrame(ui, msg.chars, msg.cols, msg.rows, msg.ascii);
        ui.registers.render(msg.cpu);
        ui.disasm.render(msg.pc, msg.disasm, msg.debug.breakpoints);
        ui.breakpoints.render(msg.debug.breakpoints);
        ui.watches.render(msg.debug.ramWatches, msg.debug.portWatches);
        ui.stack.render(msg.debug.callStack);
        ui.status.textContent = `${msg.running ? "running" : "paused"} pc=${formatU16(msg.pc)} cycles=${msg.cycles} ops=${msg.ops}${msg.halted ? " halted" : ""}`;
        setRunUi(ui, msg.running);
        break;
      case "stopped":
        renderFrame(ui, msg.chars, msg.cols, msg.rows, msg.ascii);
        ui.registers.render(msg.cpu);
        ui.disasm.render(msg.pc, msg.disasm, msg.debug.breakpoints);
        ui.breakpoints.render(msg.debug.breakpoints);
        ui.watches.render(msg.debug.ramWatches, msg.debug.portWatches);
        ui.stack.render(msg.debug.callStack);
        ui.status.textContent = `stopped (${msg.reason}) pc=${formatU16(msg.pc)} cycles=${msg.cycles} ops=${msg.ops}`;
        setRunUi(ui, false);
        break;
      case "memory":
        ui.memory.render(msg.addr, new Uint8Array(msg.bytes));
        break;
      case "out":
        ui.repl.appendOutput(msg.text);
        break;
      case "error":
        ui.status.textContent = `worker error: ${msg.message}`;
        setRunUi(ui, false);
        break;
    }
  });

  ui.runButton.addEventListener("click", () => send(worker, { type: "run" }));
  ui.pauseButton.addEventListener("click", () =>
    send(worker, { type: "pause" }),
  );
  ui.stepButton.addEventListener("click", () => send(worker, { type: "step" }));
  ui.resetButton.addEventListener("click", () =>
    send(worker, { type: "reset" }),
  );

  // Copy each ROM into a fresh ArrayBuffer so the boot screen's cached
  // bytes survive the transfer. Transferring detaches the buffer on
  // the sender side; the boot-screen state still references it (in
  // case the user comes back via the back button).
  const romEntries: Array<[ROMID, ArrayBuffer]> = [];
  const transferList: Transferable[] = [];
  for (const [id, bytes] of req.roms) {
    const copy = new Uint8Array(bytes.byteLength);
    copy.set(bytes);
    romEntries.push([id, copy.buffer]);
    transferList.push(copy.buffer);
  }
  worker.postMessage({ type: "boot", config, roms: romEntries }, transferList);
  send(worker, { type: "run" });
}

function send(w: Worker, msg: WorkerInbound): void {
  w.postMessage(msg);
}

function renderRunningView(
  root: HTMLElement,
  config: PC88Config,
  worker: Worker,
): RunningUI {
  root.classList.remove("boot-screen");
  root.classList.add("running");

  // Title row: model name on the left, back-to-boot button on the
  // right. The button terminates the worker before re-rendering so
  // a second boot doesn't spawn an additional one alongside.
  const titleRow = document.createElement("div");
  titleRow.className = "title-row";
  const heading = document.createElement("h1");
  heading.textContent = config.model;
  titleRow.appendChild(heading);
  const back = document.createElement("button");
  back.type = "button";
  back.textContent = "Back to boot screen";
  back.className = "back-button";
  back.addEventListener("click", () => {
    worker.terminate();
    void main();
  });
  titleRow.appendChild(back);
  root.appendChild(titleRow);

  const controls = document.createElement("div");
  controls.className = "run-controls";

  const runButton = makeButton("Run");
  const pauseButton = makeButton("Pause");
  const stepButton = makeButton("Step");
  const resetButton = makeButton("Reset");
  controls.appendChild(runButton);
  controls.appendChild(pauseButton);
  controls.appendChild(stepButton);
  controls.appendChild(resetButton);
  root.appendChild(controls);

  const status = document.createElement("div");
  status.className = "run-status";
  status.textContent = "booting…";
  root.appendChild(status);

  const screen = document.createElement("canvas");
  screen.className = "screen";
  root.appendChild(screen);
  const renderer = new CanvasTextRenderer(screen);

  // Debugger panels live in a side-by-side row under the canvas so
  // the screen stays the focal point and the panels share a stable
  // monospace lane width.
  const panels = document.createElement("div");
  panels.className = "panels";
  const registers = new RegistersPanel();
  const disasm = new DisasmPanel();
  const memory = new MemoryPanel((req) => {
    send(worker, { type: "peek", addr: req.addr & 0xffff, count: req.count });
  });
  const sendCommand = (line: string) => send(worker, { type: "command", line });
  const breakpoints = new BreakpointsPanel(sendCommand);
  const watches = new WatchesPanel(sendCommand);
  const stack = new StackPanel();
  const repl = new ReplPanel(sendCommand);
  panels.appendChild(registers.element);
  panels.appendChild(disasm.element);
  panels.appendChild(memory.element);
  panels.appendChild(breakpoints.element);
  panels.appendChild(watches.element);
  panels.appendChild(stack.element);
  panels.appendChild(repl.element);
  root.appendChild(panels);

  // ASCII fallback panel — same content the canvas renders, but as
  // selectable text. Useful for copy-paste of BASIC banners and for
  // sanity-checking that the canvas matches the underlying frame.
  const fallback = document.createElement("details");
  fallback.className = "ascii-fallback";
  const summary = document.createElement("summary");
  summary.textContent = "ASCII dump (selectable)";
  fallback.appendChild(summary);
  const pre = document.createElement("pre");
  pre.className = "tvram-dump";
  fallback.appendChild(pre);
  root.appendChild(fallback);

  return {
    renderer,
    asciiPre: pre,
    status,
    runButton,
    pauseButton,
    stepButton,
    resetButton,
    registers,
    disasm,
    memory,
    breakpoints,
    watches,
    stack,
    repl,
  };
}

function renderFrame(
  ui: RunningUI,
  charsBuf: ArrayBuffer,
  cols: number,
  rows: number,
  ascii: string,
): void {
  ui.renderer.render(new Uint8Array(charsBuf), cols, rows);
  ui.asciiPre.textContent = ascii;
}

function makeButton(label: string): HTMLButtonElement {
  const b = document.createElement("button");
  b.type = "button";
  b.textContent = label;
  return b;
}

function setRunUi(ui: RunningUI, running: boolean): void {
  ui.runButton.disabled = running;
  ui.pauseButton.disabled = !running;
  ui.stepButton.disabled = running;
  ui.resetButton.disabled = false;
}

function formatU16(v: number): string {
  return v.toString(16).padStart(4, "0");
}

function applyDipOverrides(
  base: PC88Config,
  port30: number,
  port31: number,
): PC88Config {
  return { ...base, dipSwitches: { port30, port31 } };
}

void main();
