/**
 * Runtime tests: a real pino instance over an in-memory destination, a
 * real s200 app driven in-process (s200/test) — every request line must
 * land as a pino record with its fields intact.
 */
import { Writable } from 'node:stream';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import pino from 'pino';
import { createApp, routes } from 's200';
import { logger } from 's200/logger';
import { request } from 's200/test';

import { createPinoSink, formatPino } from '../dist/index.js';

/** In-memory pino destination: capture each serialized line. */
function capture() {
  const lines = [];
  const stream = new Writable({
    decodeStrings: false,
    write(chunk, _encoding, callback) {
      lines.push(typeof chunk === 'string' ? chunk : chunk.toString('utf8'));
      callback();
    },
  });
  return {
    /** Records, parsed once the stream's writes have settled. */
    async records() {
      await new Promise((resolve) => setImmediate(resolve));
      return lines.map((line) => JSON.parse(line));
    },
    stream,
  };
}

/** An app that logs every request through the battery's sink/format. */
function makeApp(sink, format) {
  const app = createApp();
  routes(app) // registration is immediate — the binding is sugar
    .use(format === undefined ? logger({ sink }) : logger({ sink, format }))
    .get('/hello', () => new Response('hi'))
    .post('/users', () => new Response('created', { status: 201 }))
    .get('/boom', () => {
      throw new Error('boom');
    });
  return app;
}

/** A formatPino envelope for a request that never ran through an app. */
function envelope(method, pathname, search, status, durationMs) {
  return formatPino()(
    { req: { method }, url: { pathname, search }, res: status === undefined ? undefined : { status } },
    durationMs
  );
}

describe('createPinoSink + formatPino over s200/logger', () => {
  it('emits one structured pino record per request', async () => {
    const cap = capture();
    const app = makeApp(createPinoSink(pino(cap.stream)), formatPino());
    const res = await request(app, '/hello');
    assert.equal(res.status, 200);

    const records = await cap.records();
    assert.equal(records.length, 1);
    const [record] = records;
    assert.equal(record.level, 30); // info
    assert.equal(record.msg, 'request completed');
    assert.equal(record.req.method, 'GET');
    assert.equal(record.req.url, '/hello');
    assert.equal(record.res.statusCode, 200);
    assert.equal(typeof record.responseTime, 'number');
    assert.ok(record.responseTime >= 0);
    assert.equal(typeof record.time, 'number'); // pino's own fields pass through
  });

  it('keeps method, query string, and non-200 statuses intact', async () => {
    const cap = capture();
    const app = makeApp(createPinoSink(pino(cap.stream)), formatPino());
    const res = await request(app, '/users?role=admin', { method: 'POST' });
    assert.equal(res.status, 201);

    const [record] = await cap.records();
    assert.equal(record.req.method, 'POST');
    assert.equal(record.req.url, '/users?role=admin');
    assert.equal(record.res.statusCode, 201);
  });

  it('routes 500s to a picked level — the fallback status is observable', async () => {
    const cap = capture();
    const sink = createPinoSink(pino(cap.stream), {
      level: (fields) =>
        fields !== undefined && (fields.res.statusCode ?? 0) >= 500 ? 'error' : 'info',
    });
    const app = makeApp(sink, formatPino());
    const res = await request(app, '/boom');
    assert.equal(res.status, 500);

    const [record] = await cap.records();
    assert.equal(record.level, 50); // error
    assert.equal(record.res.statusCode, 500);
    assert.equal(record.msg, 'request completed');
  });

  it('logs the default s200 format as the message, unchanged', async () => {
    const cap = capture();
    const app = makeApp(createPinoSink(pino(cap.stream))); // no format: s200 default
    const res = await request(app, '/hello');
    assert.equal(res.status, 200);

    const [record] = await cap.records();
    assert.equal(record.level, 30);
    assert.match(record.msg, /^\d{4}-\d{2}-\d{2}T\S+ GET \/hello 200 [\d.]+ms$/);
    assert.equal('req' in record, false);
    assert.equal('responseTime' in record, false);
  });

  it('falls back to a message record for anything but the envelope', async () => {
    const cap = capture();
    const sink = createPinoSink(pino(cap.stream));
    sink('{ "foo": 1 }'); // JSON, but not the request envelope
    sink('plain text, not json');
    sink('{"req":"not an object"}');
    sink('{"req":{"method":"GET","url":"/x"},"res":{}}'); // no responseTime
    sink('{truncated');

    const records = await cap.records();
    assert.equal(records.length, 5);
    const messages = records.map((record) => record.msg);
    assert.deepEqual(messages, [
      '{ "foo": 1 }',
      'plain text, not json',
      '{"req":"not an object"}',
      '{"req":{"method":"GET","url":"/x"},"res":{}}',
      '{truncated',
    ]);
    for (const record of records) {
      assert.equal(record.level, 30);
      assert.equal('req' in record, false);
    }
  });

  it('falls back to info for unknown level names, string or picked', async () => {
    const cap = capture();
    const line = envelope('GET', '/x', '', 200, 2);
    createPinoSink(pino(cap.stream), { level: 'loud' })(line);
    createPinoSink(pino(cap.stream), { level: () => 'noisy' })(line);

    const records = await cap.records();
    assert.deepEqual(records.map((record) => record.level), [30, 30]);
    assert.equal(records[0].msg, 'request completed');
  });

  it('honors the message option on structured records', async () => {
    const cap = capture();
    createPinoSink(pino(cap.stream), { message: 'req done' })(envelope('GET', '/x', '', 200, 1));
    const [record] = await cap.records();
    assert.equal(record.msg, 'req done');
    assert.equal(record.req.url, '/x');
  });

  it('omits statusCode when the response is not materialized', async () => {
    const line = envelope('GET', '/x', '', undefined, 1);
    assert.deepEqual(JSON.parse(line), {
      req: { method: 'GET', url: '/x' },
      res: {},
      responseTime: 1,
    });

    const cap = capture();
    createPinoSink(pino(cap.stream))(line);
    const [record] = await cap.records();
    assert.deepEqual(record.res, {});
    assert.equal(record.res.statusCode, undefined);
  });

  it('rounds nothing and drops nothing the app actually produced', async () => {
    const cap = capture();
    const app = makeApp(createPinoSink(pino(cap.stream)), formatPino());
    await request(app, '/hello');
    const [record] = await cap.records();
    // responseTime crosses the seam as a plain number — formatting is
    // pino's (or the reader's) business.
    assert.ok(!Number.isNaN(record.responseTime));
    assert.deepEqual(Object.keys(record.req).sort(), ['method', 'url']);
  });
});
