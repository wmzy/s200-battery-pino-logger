# s200-battery-pino-logger

[s200](https://github.com/wmzy/s200) request logs as [pino](https://getpino.io) records — one structured JSON line per request, through the `s200/logger` sink/format seams. The first third-party s200 battery, and deliberately tiny:

- **1.4 kB gzipped** (measured: `gzip -9 dist/index.js | wc -c` → `1461` bytes; the emitted `dist/index.js` is 4455 bytes)
- **Zero runtime dependencies** — `pino` is a peer dependency (`^9.0.0 || ^10.0.0`), injected by you
- **Tree-shakable** — `"sideEffects": false`, two pure functions, no classes, no module-level state

## Install

```sh
npm install s200-battery-pino-logger
# pino is a peer dependency — bring your own:
npm install pino
```

## Usage

```ts
import { createApp, routes } from 's200';
import { logger } from 's200/logger';
import { createPinoSink, formatPino } from 's200-battery-pino-logger';
import pino from 'pino';

const pinoLogger = pino();
const app = createApp();
routes(app)
  .use(
    logger({
      sink: createPinoSink(pinoLogger, {
        level: (fields) =>
          fields !== undefined && (fields.res.statusCode ?? 0) >= 500 ? 'error' : 'info',
      }),
      format: formatPino(),
    })
  )
  .get('/hello', () => new Response('hi'));
```

Every request — 200s, 404/405 fallbacks, and 500s included — lands as one pino record in the [pino-http](https://github.com/pinojs/pino-http) field shape, so redaction rules, transports, and dashboards written for pino-http keep working:

```json
{
  "level": 30,
  "time": 1793016000000,
  "pid": 1234,
  "hostname": "box",
  "req": { "method": "POST", "url": "/users?role=admin" },
  "res": { "statusCode": 201 },
  "responseTime": 1.25,
  "msg": "request completed"
}
```

## The `s200/logger` contract

`s200/logger`'s options are two pluggable seams, and this battery is exactly one implementation of each:

| Seam | Type | This battery |
| ---- | ---- | ------------ |
| `format` | `(ctx: Ctx, durationMs: number) => string` | `formatPino()` — one JSON envelope per request |
| `sink` | `(line: string) => void` | `createPinoSink(logger, options)` — parse the envelope, hand pino a record |

Things the contract guarantees, and the battery relies on:

- **One line per request, every request.** The middleware measures the downstream chain and calls `sink(format(ctx, duration))` once on the unwind. Because s200 materializes the 404/405/500 fallbacks *inside* the chain, the observed status is always the real one — that is why the level picker above can route 500s to `error`.
- **The sink receives a string.** Fields cross the seam as JSON (that is the only thing a string can carry); `createPinoSink` parses it back — one `JSON.parse` per request. A line that is not the envelope (s200's default `ISO METHOD path status duration` format, or any custom format you bring) is logged verbatim as the record's message, never rejected.
- **Errors are not swallowed.** Like `s200/logger`'s own sink, `createPinoSink` propagates anything thrown by the injected logger or level picker.
- **`ctx.res` can be absent** mid-chain; the envelope then carries `res: {}` (no `statusCode`).

The battery types its format against a structural slice of `Ctx`, not the `s200` package — `s200` is a dev dependency here, used only by the test suite to prove the seam integration end-to-end.

## API

### `formatPino(): (ctx, durationMs: number) => string`

The `format` option. Serializes `req.method`, `req.url` (pathname + search), `res.statusCode`, and `responseTime` (ms, unrounded) as one JSON object per request.

### `createPinoSink(logger: pino.BaseLogger, options?): (line: string) => void`

The `sink` option. Any pino instance (or anything shaped like `pino.BaseLogger`).

- `level` — `'trace' | 'debug' | 'info' | 'warn' | 'error' | 'fatal'`, or a picker `(fields | undefined) => string`. `undefined` fields means the line was plain (not the envelope). Defaults to `'info'`; unknown names fall back to `'info'`.
- `message` — the structured record's `msg`. Defaults to `'request completed'` (pino-http's wording).

## Develop

```sh
npm install
npm test        # typecheck (tsc --noEmit against real s200 types) + build + node --test
```

Tests run a real pino instance over an in-memory destination against a real s200 app driven in-process (`s200/test`), asserting every field survives the round trip.

## License

[MIT](./LICENSE)
