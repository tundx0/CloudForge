export type LogFields = Record<string, unknown>;

export type Logger = {
  info(event: string, fields?: LogFields): void;
  warn(event: string, fields?: LogFields): void;
  error(event: string, fields?: LogFields): void;
};

/**
 * One JSON object per line: easy to grep locally and to ship to any log
 * pipeline. Events are stable dotted names (`job.transition`), so dashboards
 * can match them without parsing prose. See docs/adr/0005-observability.md.
 */
export function createJsonLogger(
  write: (line: string) => void = (line) => process.stdout.write(`${line}\n`),
  base: LogFields = {},
): Logger {
  const emit = (level: string, event: string, fields: LogFields = {}) => {
    write(JSON.stringify({ time: new Date().toISOString(), level, event, ...base, ...fields }));
  };
  return {
    info: (event, fields) => emit("info", event, fields),
    warn: (event, fields) => emit("warn", event, fields),
    error: (event, fields) => emit("error", event, fields),
  };
}

export const silentLogger: Logger = {
  info: () => {},
  warn: () => {},
  error: () => {},
};
