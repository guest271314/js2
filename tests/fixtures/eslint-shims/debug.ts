// #2693 no-op shim for `debug` — eslint uses it only for diagnostic logging.
// createDebug(namespace) -> no-op logger.
type Logger = ((...args: unknown[]) => void) & { enabled: boolean };
export default function createDebug(_namespace: string): Logger {
  const logger = ((..._args: unknown[]): void => {}) as Logger;
  logger.enabled = false;
  return logger;
}
