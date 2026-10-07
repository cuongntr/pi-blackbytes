import * as fsSync from "node:fs";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { getAgentHomePath } from "./agent-home.js";
import { isSeatMode } from "./seat-mode.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type LogLevel = "debug" | "info" | "warn" | "error";

export interface Logger {
  debug(msg: string, meta?: Record<string, unknown>): void;
  info(msg: string, meta?: Record<string, unknown>): void;
  warn(msg: string, meta?: Record<string, unknown>): void;
  error(msg: string, meta?: Record<string, unknown>): void;
  flush(): Promise<void>;
}

export interface LoggerOptions {
  logDir?: string;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const LOG_FILE_NAME = "pi-blackbytes.log";
const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10 MB
const FLUSH_INTERVAL_MS = 5_000;
const BUFFER_SIZE_THRESHOLD = 4 * 1024; // 4 KB

const SECRET_KEYS = new Set(["api_key", "authorization", "exa_api_key", "tavily_api_key"]);

// ---------------------------------------------------------------------------
// Secret redaction
// ---------------------------------------------------------------------------

function redactMeta(meta: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(meta)) {
    result[key] = SECRET_KEYS.has(key.toLowerCase()) ? "***" : value;
  }
  return result;
}

// ---------------------------------------------------------------------------
// Logger implementation
// ---------------------------------------------------------------------------

class BufferedLogger implements Logger {
  private readonly logDir: string;
  private readonly logPath: string;
  private buffer: string[] = [];
  private bufferSize = 0;
  private currentDate: string = todayString();
  private timer: ReturnType<typeof setInterval> | null = null;
  private flushing = false;

  constructor(logDir: string) {
    this.logDir = logDir;
    this.logPath = path.join(logDir, LOG_FILE_NAME);
    this.startTimer();
  }

  debug(msg: string, meta?: Record<string, unknown>): void {
    this.enqueue("debug", msg, meta);
  }

  info(msg: string, meta?: Record<string, unknown>): void {
    this.enqueue("info", msg, meta);
  }

  warn(msg: string, meta?: Record<string, unknown>): void {
    this.enqueue("warn", msg, meta);
  }

  error(msg: string, meta?: Record<string, unknown>): void {
    this.enqueue("error", msg, meta);
  }

  async flush(): Promise<void> {
    if (this.flushing) return;
    this.flushing = true;
    try {
      await this.doFlush();
    } finally {
      this.flushing = false;
    }
  }

  // -------------------------------------------------------------------------
  // Private helpers
  // -------------------------------------------------------------------------

  private enqueue(level: LogLevel, msg: string, meta?: Record<string, unknown>): void {
    const redacted = meta ? redactMeta(meta) : undefined;
    const metaPart = redacted ? ` ${JSON.stringify(redacted)}` : "";
    const line = `[${new Date().toISOString()}] [${level.toUpperCase()}] ${msg}${metaPart}\n`;

    this.buffer.push(line);
    this.bufferSize += line.length;

    if (this.bufferSize >= BUFFER_SIZE_THRESHOLD) {
      // fire-and-forget flush (errors swallowed in doFlush)
      void this.flush();
    }
  }

  private async doFlush(): Promise<void> {
    if (this.buffer.length === 0) return;

    // Swap out the buffer
    const lines = this.buffer;
    this.buffer = [];
    this.bufferSize = 0;

    const content = lines.join("");

    try {
      await this.ensureDir();
      await this.maybeRotate();
      await fs.appendFile(this.logPath, content, "utf8");
    } catch {
      // swallow — logging must never throw
    }
  }

  private async ensureDir(): Promise<void> {
    await fs.mkdir(this.logDir, { recursive: true });
  }

  private async maybeRotate(): Promise<void> {
    // Date-based rotation
    const today = todayString();
    if (today !== this.currentDate) {
      await this.rotateTo(this.currentDate);
      this.currentDate = today;
      return;
    }

    // Size-based rotation
    try {
      const stat = await fs.stat(this.logPath);
      if (stat.size >= MAX_FILE_SIZE) {
        await this.rotateTo(today);
      }
    } catch {
      // file doesn't exist yet — fine
    }
  }

  private async rotateTo(suffix: string): Promise<void> {
    try {
      // If a file with this suffix already exists, add a counter
      let dest = path.join(this.logDir, `pi-blackbytes.${suffix}.log`);
      let counter = 1;
      while (fsSync.existsSync(dest)) {
        dest = path.join(this.logDir, `pi-blackbytes.${suffix}.${counter}.log`);
        counter++;
      }
      await fs.rename(this.logPath, dest);
    } catch {
      // source may not exist — ignore
    }
  }

  private startTimer(): void {
    this.timer = setInterval(() => {
      void this.flush();
    }, FLUSH_INTERVAL_MS);

    // Don't keep process alive just for logging
    if (this.timer.unref) {
      this.timer.unref();
    }
  }

  /** Stop the background timer (useful in tests). */
  stopTimer(): void {
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function todayString(): string {
  return new Date().toISOString().slice(0, 10); // "YYYY-MM-DD"
}

/**
 * Default log directory.
 *
 * - Seat mode (`PASEO_ROOM_ROLE` set): `<agent dir>/logs`, so nothing is written
 *   outside the seat's own Pi directory.
 * - Otherwise: `~/.pi/logs` (legacy behaviour, unchanged).
 */
export function resolveDefaultLogDir(): string {
  if (isSeatMode()) {
    return path.join(getAgentHomePath(), "logs");
  }
  try {
    return path.join(os.homedir(), ".pi", "logs");
  } catch {
    return os.tmpdir();
  }
}

function resolveLogDir(opts?: LoggerOptions): string {
  if (opts?.logDir) return opts.logDir;
  return resolveDefaultLogDir();
}

// ---------------------------------------------------------------------------
// Public factory
// ---------------------------------------------------------------------------

export function createLogger(opts?: LoggerOptions): Logger {
  const logDir = resolveLogDir(opts);
  return new BufferedLogger(logDir);
}

/** Default singleton logger (lazy-initialised). */
let _defaultLogger: Logger | null = null;

export function getLogger(): Logger {
  if (!_defaultLogger) {
    _defaultLogger = createLogger();
  }
  return _defaultLogger;
}
