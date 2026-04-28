declare module "log-node" {
  interface LoggerOptions {
    defaultNamespace: string;
  }

  function initialize(options?: Partial<LoggerOptions>): void;

  export default initialize;
}
