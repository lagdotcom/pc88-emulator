import { readFile } from "node:fs/promises";
import { createInterface } from "node:readline/promises";

import type { FilesystemPath } from "../flavours.js";
import type { PC88Machine } from "../machines/pc88.js";
import {
  type DebugOptions,
  type DebugState,
  dispatch,
  type DispatchCtx,
  installWatchHooks,
  makeDebugState,
  printPromptSummary,
  setDebugWriter,
} from "./debug.js";
import { type DebugSymbols, loadDebugSymbols } from "./debug-symbols.js";

// Default writer for the CLI: write straight to stdout. Installed
// before any debugger output so the user sees the banner.
setDebugWriter((s) => {
  process.stdout.write(s);
});

async function runScript(
  path: FilesystemPath,
  ctx: DispatchCtx,
): Promise<{ quit: boolean }> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (e) {
    process.stdout.write(
      `  failed to read script ${path}: ${(e as Error).message}\n`,
    );
    return { quit: false };
  }
  for (const rawLine of text.split(/\r?\n/)) {
    const trimmed = rawLine.trim();
    if (!trimmed) continue;
    process.stdout.write(`script> ${trimmed}\n`);
    const result = await dispatch(rawLine, ctx);
    if (result.quit) return { quit: true };
  }
  return { quit: false };
}

// REPL — reads commands, dispatches, re-prompts. Returns when the
// user types `quit` or stdin closes (e.g. Ctrl-D). When opts.script
// is set, that script runs first; if it ends with `quit`, the REPL
// is skipped — handy for "boot, dump state, exit" automation.
export async function runDebug(
  machine: PC88Machine,
  opts: DebugOptions = {},
): Promise<void> {
  const state: DebugState = makeDebugState(opts.initialBreakpoints ?? []);

  // Symbol files are optional — synthetic-ROM tests don't pass
  // `loadedRoms`. When present, the resolver feeds disassembly and
  // the `label` / `unlabel` / `labels` commands; when absent,
  // those commands print a friendly diagnostic instead of crashing.
  const syms: DebugSymbols | null = opts.loadedRoms
    ? await loadDebugSymbols(machine, opts.loadedRoms)
    : null;
  if (syms) {
    let count = 0;
    for (const e of syms.byRomId.values()) count += e.file.byAddr.size;
    process.stdout.write(
      `pc88 debugger — paused at reset. ${count} labels loaded across ${syms.byRomId.size} ROMs. ` +
        `Type "help" for commands.\n`,
    );
  } else {
    process.stdout.write(
      `pc88 debugger — paused at reset. Type "help" for commands.\n`,
    );
  }

  const hooks = installWatchHooks(machine, state, syms);
  try {
    const ctx: DispatchCtx = { machine, state, syms, opts };

    if (opts.script) {
      const result = await runScript(opts.script, ctx);
      if (result.quit) return;
    }

    const rl = createInterface({
      input: process.stdin,
      output: process.stdout,
    });
    while (true) {
      printPromptSummary(machine, syms);
      const raw = await rl.question("> ");
      const result = await dispatch(raw, ctx);
      if (result.quit) {
        rl.close();
        return;
      }
    }
  } finally {
    hooks.uninstall();
  }
}
