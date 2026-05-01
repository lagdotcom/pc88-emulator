import Log from "debug-level";

const activeLoggers: Log[] = [];

export function getLogger(namespace: string) {
  const log = new Log(namespace);
  activeLoggers.push(log);
  return log;
}

// debug-level's stream slot is typed `NodeJS.WriteStream` (the
// process.stdout/stderr flavour with TTY methods) but only `.write()`
// is actually called. Accept the broader `NodeJS.WritableStream` so
// `fs.createWriteStream(...)` returns slot in cleanly.
export function logToStream(stream: NodeJS.WritableStream, colors = false) {
  const writeStream = stream as NodeJS.WriteStream;
  Log.options({ stream: writeStream, colors });
  for (const log of activeLoggers) {
    log.stream = writeStream;
    log.opts.colors = colors;
  }
}
