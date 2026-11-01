export type Fields = Record<string, unknown>;
export type LogLevel = 'info' | 'warn' | 'error';
export type LogSink = (level: LogLevel, line: string) => void;

export interface Logger {
  info(message: string, fields?: Fields): void;
  warn(message: string, fields?: Fields): void;
  error(message: string, fields?: Fields): void;
  child(fields: Fields): Logger;
}

const SECRET_KEY =
  /authorization|token|secret|password|passwd|credential|cookie|connection.?string|account.?key|api.?key|^key$|signature|assertion|bearer/i;
const FREE_TEXT_KEY = /^(description|reason|comment|explanation|note|notes|text|prompt|payload|body)$/i;
const MAX_STRING = 300;
const MAX_ITEMS = 20;
const MAX_DEPTH = 4;

/** Removes secrets and free text from diagnostics. Values are replaced, never partially shown. */
export function redact(value: unknown, depth = 0, key = ''): unknown {
  // A counter such as `maxTokens` matches the secret-name pattern but cannot hold a credential.
  const isCounter = typeof value === 'number' || typeof value === 'boolean';
  if (!isCounter && SECRET_KEY.test(key)) return '[redacted]';
  if (typeof value === 'string') {
    if (FREE_TEXT_KEY.test(key)) return `[text:${value.length} chars]`;
    return value.length > MAX_STRING ? `${value.slice(0, MAX_STRING)}…` : value;
  }
  if (value === null || typeof value === 'number' || typeof value === 'boolean' || value === undefined) return value;
  if (typeof value === 'bigint') return value.toString();
  if (value instanceof Error) {
    const withCode = value as Error & { code?: unknown; status?: unknown; statusCode?: unknown };
    return {
      name: value.name,
      message: redact(value.message, depth + 1, 'message'),
      ...(withCode.code === undefined ? {} : { code: redact(withCode.code, depth + 1, 'code') }),
      ...(withCode.status === undefined && withCode.statusCode === undefined
        ? {}
        : { status: withCode.status ?? withCode.statusCode }),
    };
  }
  if (value instanceof Date) return value.toISOString();
  if (depth >= MAX_DEPTH) return '[truncated]';
  if (Array.isArray(value)) {
    const items = value.slice(0, MAX_ITEMS).map((item) => redact(item, depth + 1, key));
    return value.length > MAX_ITEMS ? [...items, `[+${value.length - MAX_ITEMS} more]`] : items;
  }
  if (typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [childKey, childValue] of Object.entries(value as Record<string, unknown>)) {
      out[childKey] = redact(childValue, depth + 1, childKey);
    }
    return out;
  }
  return '[unsupported]';
}

export const stdoutSink: LogSink = (level, line) => {
  (level === 'error' ? process.stderr : process.stdout).write(`${line}\n`);
};

export function createLogger(sink: LogSink, base: Fields = {}): Logger {
  const emit = (level: LogLevel, message: string, fields?: Fields): void => {
    const record = redact({ level, message, ...base, ...fields }) as Record<string, unknown>;
    sink(level, JSON.stringify({ ...record, time: new Date().toISOString() }));
  };
  return {
    info: (message, fields) => { emit('info', message, fields); },
    warn: (message, fields) => { emit('warn', message, fields); },
    error: (message, fields) => { emit('error', message, fields); },
    child: (fields) => createLogger(sink, { ...base, ...fields }),
  };
}

export function createMemoryLogger(): { logger: Logger; lines: string[] } {
  const lines: string[] = [];
  return { logger: createLogger((_level, line) => lines.push(line)), lines };
}
