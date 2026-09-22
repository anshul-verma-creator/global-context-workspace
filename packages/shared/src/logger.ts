/**
 * Structured logger interface.
 * All log calls should include correlation IDs per spec §23.
 */
export interface LogContext {
  workspaceId?: string;
  repositoryId?: string;
  capsuleId?: string;
  sessionId?: string;
  eventId?: string;
  requestId?: string;
  [key: string]: string | number | boolean | undefined;
}

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface Logger {
  debug(message: string, context?: LogContext): void;
  info(message: string, context?: LogContext): void;
  warn(message: string, context?: LogContext): void;
  error(message: string, context?: LogContext, error?: Error): void;
  child(bindings: LogContext): Logger;
}

/**
 * Console-based structured logger for development.
 * In production, replace with a structured logging library (pino, winston, etc.).
 */
class StructuredLogger implements Logger {
  private readonly bindings: LogContext;
  private readonly level: LogLevel;

  constructor(bindings: LogContext = {}, level: LogLevel = 'info') {
    this.bindings = bindings;
    this.level = level;
  }

  private shouldLog(messageLevel: LogLevel): boolean {
    const levels: LogLevel[] = ['debug', 'info', 'warn', 'error'];
    return levels.indexOf(messageLevel) >= levels.indexOf(this.level);
  }

  private format(
    level: LogLevel,
    message: string,
    context?: LogContext,
    error?: Error,
  ): string {
    const entry: Record<string, unknown> = {
      timestamp: new Date().toISOString(),
      level,
      message,
      ...this.bindings,
      ...context,
    };
    if (error !== undefined) {
      entry['error'] = {
        message: error.message,
        name: error.name,
        stack: error.stack,
      };
    }
    return JSON.stringify(entry);
  }

  debug(message: string, context?: LogContext): void {
    if (this.shouldLog('debug')) {
      process.stderr.write(this.format('debug', message, context) + '\n');
    }
  }

  info(message: string, context?: LogContext): void {
    if (this.shouldLog('info')) {
      process.stderr.write(this.format('info', message, context) + '\n');
    }
  }

  warn(message: string, context?: LogContext): void {
    if (this.shouldLog('warn')) {
      process.stderr.write(this.format('warn', message, context) + '\n');
    }
  }

  error(message: string, context?: LogContext, error?: Error): void {
    if (this.shouldLog('error')) {
      process.stderr.write(this.format('error', message, context, error) + '\n');
    }
  }

  child(bindings: LogContext): Logger {
    return new StructuredLogger({ ...this.bindings, ...bindings }, this.level);
  }
}

let _rootLogger: Logger | undefined;

export function getRootLogger(): Logger {
  if (_rootLogger === undefined) {
    const level = (process.env['LOG_LEVEL'] as LogLevel | undefined) ?? 'info';
    _rootLogger = new StructuredLogger({}, level);
  }
  return _rootLogger;
}

export function setRootLogger(logger: Logger): void {
  _rootLogger = logger;
}

export function createLogger(bindings: LogContext): Logger {
  return getRootLogger().child(bindings);
}
