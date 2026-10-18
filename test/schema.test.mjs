import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validate, assertValid } from '../core/schema.mjs';

const schema = {
  type: 'object',
  required: ['task', 'acs'],
  additionalProperties: false,
  properties: {
    task: { type: 'string', pattern: '^[A-Z]+-[0-9]+$' },
    n: { type: 'integer', minimum: 1 },
    blocked: { type: ['string', 'null'] },
    acs: { type: 'array', items: { type: 'object', required: ['verdict'], properties: { verdict: { enum: ['pass', 'fail'] } } } },
  },
};

test('valid value has no errors', () => {
  assert.deepEqual(validate(schema, { task: 'PAD-1', n: 2, blocked: null, acs: [{ verdict: 'pass' }] }), []);
});

test('each keyword reports an error', () => {
  const errs = validate(schema, { task: 'pad', n: 0, blocked: 3, acs: [{ verdict: 'maybe' }, {}], extra: 1 });
  for (const part of ['$.task: does not match', '$.n: 0 < minimum', '$.blocked: expected', '$.acs[0].verdict', '$.acs[1].verdict: required', '$.extra: not allowed']) {
    assert.ok(errs.some((e) => e.startsWith(part)), `missing error ${part} in ${errs}`);
  }
  assert.ok(validate(schema, {}).includes('$.task: required'));
  assert.deepEqual(validate({ type: 'integer' }, 1.5), ['$: expected integer, got number']);
  assert.deepEqual(validate({ type: 'number' }, 2), []);
  assert.throws(() => assertValid(schema, {}, 'report'), /report is invalid/);
});
