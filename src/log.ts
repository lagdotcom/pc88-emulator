import Log from "debug-level";

const activeLoggers: Log[] = [];

export function getLogger(namespace: string) {
  const log = new Log(namespace);
  activeLoggers.push(log);
  return log;
}

export function logToStream(stream: NodeJS.WriteStream, colors = false) {
  Log.options({ stream, colors });
  for (const log of activeLoggers) {
    log.stream = stream;
    log.opts.colors = colors;
  }
}
