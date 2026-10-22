import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { ROUTES } from '../src/server.js';

const spec = JSON.parse(readFileSync(new URL('../docs/api/openapi.json', import.meta.url), 'utf8'));
const METHODS = new Set(['get', 'put', 'post', 'delete', 'patch', 'head', 'options']);

function specOperations() {
  return Object.entries(spec.paths).flatMap(([path, item]) =>
    Object.keys(item)
      .filter((key) => METHODS.has(key))
      .map((method) => ({ key: `${method.toUpperCase()} ${path}`, op: item[method] })),
  );
}

test('spec is OpenAPI 3.x', () => {
  assert.match(spec.openapi, /^3\.\d+\.\d+$/);
});

test('every served route is documented and every documented route is served', () => {
  const served = ROUTES.map((r) => `${r.method} ${r.path}`).sort();
  const documented = specOperations().map((o) => o.key).sort();
  assert.deepEqual(documented, served);
});

test('every operation has an operationId, a summary and a 2xx response', () => {
  const ids = new Set();
  for (const { key, op } of specOperations()) {
    assert.ok(op.operationId, `${key} lacks operationId`);
    assert.ok(!ids.has(op.operationId), `duplicate operationId ${op.operationId}`);
    ids.add(op.operationId);
    assert.ok(op.summary, `${key} lacks summary`);
    assert.ok(Object.keys(op.responses).some((code) => code.startsWith('2')), `${key} lacks a 2xx response`);
  }
});

test('JSON request bodies carry an example', () => {
  for (const { key, op } of specOperations()) {
    const media = op.requestBody?.content?.['application/json'];
    if (media) assert.ok(media.example ?? media.examples, `${key} request body lacks an example`);
  }
});

test('run endpoint documents the dry_run default and the 403 live refusal', () => {
  const run = spec.paths['/api/v1/experiments/run'].post;
  assert.equal(spec.components.schemas.RunRequest.properties.mode.default, 'dry_run');

  const forbidden = run.responses['403'];
  assert.ok(forbidden, 'POST /api/v1/experiments/run lacks a 403 response');
  const schema = forbidden.content['application/json'].schema;
  assert.ok(schema.required.includes('code'), '403 body must carry an error code');
  assert.deepEqual(schema.properties.code.enum, ['LIVE_MODE_DISABLED']);
  assert.match(forbidden.description, /CHAOS_LIVE_ENABLED/);
});
