/**
 * s200-battery-pino-logger — s200's per-request log lines as pino records.
 *
 * Two pure functions that plug into the `s200/logger` seams: `formatPino()`
 * is the `format` option (one JSON envelope per request, pino-http field
 * shape), `createPinoSink(logger)` is the `sink` option (parses that
 * envelope back and hands a structured record to pino). Lines produced by
 * any other format — s200's default included — are logged as the message,
 * so the sink never rejects a logger it did not shape itself.
 *
 * @module
 */

import type { BaseLogger } from 'pino';

/**
 * The structural slice of s200's `Ctx` that {@link formatPino} reads. Local
 * on purpose: the battery couples to the `s200/logger` seam, not to the
 * package — any `Ctx` satisfies it.
 */
export type PinoLogCtx = {
  readonly req: { readonly method: string };
  readonly url: { readonly pathname: string; readonly search: string };
  readonly res: { readonly status: number } | undefined;
};

/**
 * One structured request record, in the pino-http field shape (`req`,
 * `res`, `responseTime`) — redaction rules, transports, and dashboards
 * written for pino-http keep working.
 */
export type PinoRequestFields = {
  readonly req: { readonly method: string; readonly url: string };
  readonly res: { readonly statusCode: number | undefined };
  readonly responseTime: number;
};

/** Options for {@link createPinoSink}. */
export type PinoSinkOptions = {
  /**
   * Level of the request record: a fixed name or a per-record picker. The
   * picker sees the parsed fields — `undefined` when the line was plain
   * (not the JSON envelope) — so `500`s can be routed to `error`.
   * Defaults to `info`; unknown names fall back to `info`.
   */
  readonly level?: string | ((fields: PinoRequestFields | undefined) => string);
  /** Message of the structured record. Defaults to `'request completed'` (pino-http's wording). */
  readonly message?: string;
};

/**
 * Format half of the pair: emits one JSON envelope per request carrying
 * the pino-http field shape — `req.method`, `req.url` (path + query),
 * `res.statusCode`, `responseTime`. Hand to `s200/logger`'s `format`
 * option. The envelope crosses to the sink as a string (that is the seam's
 * contract); the sink parses it back.
 */
export function formatPino(): (ctx: PinoLogCtx, durationMs: number) => string {
  return (ctx, durationMs) =>
    JSON.stringify({
      req: { method: ctx.req.method, url: ctx.url.pathname + ctx.url.search },
      res: { statusCode: ctx.res === undefined ? undefined : ctx.res.status },
      responseTime: durationMs,
    });
}

const LEVELS: readonly string[] = ['trace', 'debug', 'info', 'warn', 'error', 'fatal'];
type LevelName = 'trace' | 'debug' | 'info' | 'warn' | 'error' | 'fatal';

function isLevelName(value: string): value is LevelName {
  return LEVELS.includes(value);
}

/**
 * Parse a line back into request fields. `undefined` when the line is not
 * the JSON envelope {@link formatPino} writes — plain lines stay plain.
 */
function parseFields(line: string): PinoRequestFields | undefined {
  if (!line.startsWith('{')) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return undefined;
  }
  if (typeof parsed !== 'object' || parsed === null) return undefined;
  const rec = parsed as Record<string, unknown>;
  const { req, res } = rec;
  if (typeof req !== 'object' || req === null) return undefined;
  if (typeof res !== 'object' || res === null) return undefined;
  const reqRec = req as Record<string, unknown>;
  const resRec = res as Record<string, unknown>;
  if (typeof reqRec.method !== 'string') return undefined;
  if (typeof reqRec.url !== 'string') return undefined;
  if (typeof rec.responseTime !== 'number') return undefined;
  return {
    req: { method: reqRec.method, url: reqRec.url },
    res: { statusCode: typeof resRec.statusCode === 'number' ? resRec.statusCode : undefined },
    responseTime: rec.responseTime,
  };
}

function emitRecord(logger: BaseLogger, level: LevelName, fields: PinoRequestFields, msg: string): void {
  switch (level) {
    case 'fatal': logger.fatal(fields, msg); return;
    case 'error': logger.error(fields, msg); return;
    case 'warn': logger.warn(fields, msg); return;
    case 'debug': logger.debug(fields, msg); return;
    case 'trace': logger.trace(fields, msg); return;
    default: logger.info(fields, msg); return;
  }
}

function emitLine(logger: BaseLogger, level: LevelName, line: string): void {
  switch (level) {
    case 'fatal': logger.fatal(line); return;
    case 'error': logger.error(line); return;
    case 'warn': logger.warn(line); return;
    case 'debug': logger.debug(line); return;
    case 'trace': logger.trace(line); return;
    default: logger.info(line); return;
  }
}

/**
 * Sink half of the pair: hands every `s200/logger` line to a pino logger
 * (or anything shaped like one). Lines that are the JSON envelope of
 * {@link formatPino} become structured records; every other line — s200's
 * default format, any custom format — is logged as the message verbatim.
 * Hand to `s200/logger`'s `sink` option.
 *
 * Like `s200/logger`'s own sink, this does not swallow errors thrown by
 * the injected logger or level picker.
 */
export function createPinoSink(
  logger: BaseLogger,
  options: PinoSinkOptions = {}
): (line: string) => void {
  const { level = 'info', message = 'request completed' } = options;
  return (line) => {
    const fields = parseFields(line);
    const raw = typeof level === 'function' ? level(fields) : level;
    const name = typeof raw === 'string' && isLevelName(raw) ? raw : 'info';
    if (fields === undefined) {
      emitLine(logger, name, line);
      return;
    }
    emitRecord(logger, name, fields, message);
  };
}
