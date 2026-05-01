// Browser-side replacement for the `log` package. The Node bundle
// keeps using medikoo/log + log-node; the web bundle aliases `"log"`
// and `"log/lib/emitter"` to this module via esbuild so we don't pull
// `log`'s transitive deps (es5-ext, sprintf-kit, etc.) into the
// browser bundle.
//
// API surface kept compatible with the `logLib.get(name).debug(...)`
// pattern used throughout `src/chips/`, `src/core/`, and
// `src/machines/`. Anything beyond that (level filtering,
// per-namespace enables, structured fields) lives in the user's
// browser devtools, not in this shim.

type Listener = (event: {
  logger: string;
  level: Level;
  message: string;
}) => void;

type Level = "debug" | "info" | "notice" | "warn" | "error";

const listeners = new Set<Listener>();

function format(args: unknown[]): string {
  if (args.length === 0) return "";
  const [first, ...rest] = args;
  if (typeof first !== "string" || rest.length === 0) {
    return args.map(stringify).join(" ");
  }
  // Minimal printf — supports %s (string), %d/%i (decimal), %x (hex),
  // %o/%O (object). Matches what the existing log calls use without
  // pulling in sprintf-kit.
  let i = 0;
  return first.replace(/%([sdiOoxX%])/g, (_, ch: string) => {
    if (ch === "%") return "%";
    const v = rest[i++];
    switch (ch) {
      case "s":
        return String(v);
      case "d":
      case "i":
        return String(Math.trunc(Number(v)));
      case "x":
        return Number(v).toString(16);
      case "X":
        return Number(v).toString(16).toUpperCase();
      default:
        return stringify(v);
    }
  });
}

function stringify(v: unknown): string {
  if (typeof v === "string") return v;
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}

export interface Logger {
  debug: (...args: unknown[]) => void;
  info: (...args: unknown[]) => void;
  notice: (...args: unknown[]) => void;
  warn: (...args: unknown[]) => void;
  error: (...args: unknown[]) => void;
  get: (sub: string) => Logger;
}

const cache = new Map<string, Logger>();

function emit(name: string, level: Level, args: unknown[]): void {
  const message = format(args);
  for (const fn of listeners) fn({ logger: name, level, message });
}

function makeLogger(name: string): Logger {
  return {
    debug: (...a) => emit(name, "debug", a),
    info: (...a) => emit(name, "info", a),
    notice: (...a) => emit(name, "notice", a),
    warn: (...a) => emit(name, "warn", a),
    error: (...a) => emit(name, "error", a),
    get(sub) {
      return getLogger(name ? `${name}:${sub}` : sub);
    },
  };
}

export function getLogger(name: string): Logger {
  let l = cache.get(name);
  if (!l) {
    l = makeLogger(name);
    cache.set(name, l);
  }
  return l;
}

// Subscribe to every log line. The browser entry uses this both to
// forward to console and to mirror lines into the on-page log pane.
export function onLog(fn: Listener): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

// Default emitter that pipes every line to the dev console. The web
// entry calls this once on startup; without it, log calls are silent.
export function installConsoleListener(): () => void {
  return onLog(({ logger, level, message }) => {
    const text = logger ? `${logger}: ${message}` : message;
    const fn =
      level === "error"
        ? console.error
        : level === "warn"
          ? console.warn
          : level === "debug"
            ? console.debug
            : console.log;
    fn.call(console, text);
  });
}

// `log/lib/emitter`-shaped object so `import emitter from
// "log/lib/emitter"` keeps working when aliased here.
export const emitter = {
  on(_event: "log", handler: (e: { message: string }) => void): void {
    onLog(({ message }) => handler({ message }));
  },
  off(): void {
    // No-op: the emitter pattern in `log` is fire-and-forget; the
    // Node side uses `off` to detach the file-tee writer at process
    // exit, which doesn't matter in a browser tab.
  },
};

// Default export shape: `logLib.get("name")` is the entry point used
// across the codebase.
const logLib = {
  get: getLogger,
};
export default logLib;
