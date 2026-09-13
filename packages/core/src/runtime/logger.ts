import { TypedEmitter } from '../util/events.js';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface LogEntry {
  timestamp: number;
  level: LogLevel;
  scope: string;
  message: string;
}

export interface LoggerEvents {
  entry: LogEntry;
}

const LEVEL_ORDER: Record<LogLevel, number> = { debug: 0, info: 1, warn: 2, error: 3 };

/** Ring-buffered logger; the UI log panel renders {@link Logger.entries}. */
export class Logger {
  readonly events = new TypedEmitter<LoggerEvents>();
  private buffer: LogEntry[] = [];

  constructor(
    private readonly scope = 'bot',
    private minLevel: LogLevel = 'info',
    private readonly capacity = 2000,
  ) {}

  /** A logger that shares this one's event stream but tags a different scope. */
  child(scope: string): Logger {
    const child = new Logger(`${this.scope}:${scope}`, this.minLevel, this.capacity);
    child.events.on('entry', (entry) => {
      this.push(entry);
      this.events.emit('entry', entry);
    });
    return child;
  }

  setLevel(level: LogLevel): void {
    this.minLevel = level;
  }

  get entries(): readonly LogEntry[] {
    return this.buffer;
  }

  clear(): void {
    this.buffer = [];
  }

  debug(message: string): void {
    this.write('debug', message);
  }
  info(message: string): void {
    this.write('info', message);
  }
  warn(message: string): void {
    this.write('warn', message);
  }
  error(message: string): void {
    this.write('error', message);
  }

  private write(level: LogLevel, message: string): void {
    if (LEVEL_ORDER[level] < LEVEL_ORDER[this.minLevel]) return;
    const entry: LogEntry = { timestamp: Date.now(), level, scope: this.scope, message };
    this.push(entry);
    this.events.emit('entry', entry);
  }

  private push(entry: LogEntry): void {
    this.buffer.push(entry);
    if (this.buffer.length > this.capacity) {
      this.buffer.splice(0, this.buffer.length - this.capacity);
    }
  }
}
