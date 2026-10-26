/**
 * Compile-time assertions: the sink/format pair fits `s200/logger`'s option
 * seams, against the real s200 types. Checked by `tsc -p tsconfig.json`
 * (`npm run typecheck`); never executed.
 */
import type { LoggerOptions } from 's200/logger';

import { createPinoSink, formatPino, type PinoRequestFields } from '../src/index.js';

declare const pinoLogger: import('pino').BaseLogger;

// The battery's two halves, hand-in-hand with the real seam types.
const options: LoggerOptions = {
  sink: createPinoSink(pinoLogger),
  format: formatPino(),
};

// The structured record shape, as importers see it.
const fields: PinoRequestFields = {
  req: { method: 'GET', url: '/users?role=admin' },
  res: { statusCode: 200 },
  responseTime: 1.25,
};

void options;
void fields;
