declare module "log/lib/emitter" {
  // The medikoo/log package's emitter is an event-emitter instance
  // shared by every log writer. We only use `on(event, handler)` to
  // tap into the same stream as log-node and tee to a file.
  interface LogEvent {
    message: string;
    [k: string]: unknown;
  }

  interface LogEmitter {
    on(event: "log", handler: (event: LogEvent) => void): void;
    off(event: "log", handler: (event: LogEvent) => void): void;
  }

  const emitter: LogEmitter;
  export default emitter;
}
