type Level = "debug" | "info" | "warn" | "error";

const LEVEL_WEIGHT: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };

/** Log'a asla yazılmaması gereken anahtar adları. */
const SENSITIVE_KEY_PATTERN =
  /(authorization|api[-_]?key|api[-_]?secret|secret|password|passwd|token|cookie|credential)/i;

/** Değer içinde geçebilecek gizli kalıplar (Basic/Bearer başlıkları, bağlantı adresleri). */
const SENSITIVE_VALUE_PATTERN = /\b(Basic|Bearer)\s+[A-Za-z0-9+/=._-]+/gi;
const CONNECTION_STRING_PATTERN = /postgres(?:ql)?:\/\/\S+/gi;

function currentLevel(): Level {
  const raw = (process.env.LOG_LEVEL ?? "info").toLowerCase();
  return (["debug", "info", "warn", "error"] as const).includes(raw as Level)
    ? (raw as Level)
    : "info";
}

/**
 * Log meta verisini temizler: hassas anahtarlar "***" ile maskelenir, Basic/Bearer
 * kimlik bilgileri metin içinden silinir.
 */
export function redact(value: unknown, depth = 0): unknown {
  if (depth > 4) return "[derin]";
  if (value === null || value === undefined) return value;
  if (typeof value === "string") {
    return value
      .replace(SENSITIVE_VALUE_PATTERN, "$1 ***")
      .replace(CONNECTION_STRING_PATTERN, "postgresql://***");
  }
  if (typeof value === "number" || typeof value === "boolean") return value;
  if (value instanceof Error) {
    return { name: value.name, message: redact(value.message) };
  }
  if (Array.isArray(value)) return value.map((item) => redact(item, depth + 1));
  if (typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
      out[key] = SENSITIVE_KEY_PATTERN.test(key) ? "***" : redact(val, depth + 1);
    }
    return out;
  }
  return "[bilinmeyen]";
}

function emit(level: Level, scope: string, message: string, meta?: Record<string, unknown>): void {
  if (LEVEL_WEIGHT[level] < LEVEL_WEIGHT[currentLevel()]) return;

  const line = {
    ts: new Date().toISOString(),
    level,
    scope,
    msg: String(redact(message)),
    ...(meta ? { meta: redact(meta) } : {}),
  };

  const text = JSON.stringify(line);
  if (level === "error") console.error(text);
  else if (level === "warn") console.warn(text);
  else console.log(text);
}

export interface Logger {
  debug(message: string, meta?: Record<string, unknown>): void;
  info(message: string, meta?: Record<string, unknown>): void;
  warn(message: string, meta?: Record<string, unknown>): void;
  error(message: string, meta?: Record<string, unknown>): void;
}

/** Kapsam (scope) bazlı logger. Meta verisi otomatik olarak maskelenir. */
export function createLogger(scope: string): Logger {
  return {
    debug: (message, meta) => emit("debug", scope, message, meta),
    info: (message, meta) => emit("info", scope, message, meta),
    warn: (message, meta) => emit("warn", scope, message, meta),
    error: (message, meta) => emit("error", scope, message, meta),
  };
}

export const logger = createLogger("app");
