#!/usr/bin/env node
/**
 * redact-output.test.mjs — contract for the ONE credential redactor that
 * every operator surface uses (task 219fb673, PR #937).
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * Two surfaces show flyctl's output to an operator, and that output gets
 * pasted into task comments on a PUBLIC repo:
 *
 *   - `infra/cloud/bin/status` (shell, via the module's CLI mode)
 *   - `infra/cloud/platform/platform-provision-secrets.mjs` (Node, via the
 *     module's export)
 *
 * They used to carry different masking rules, so a credential shape one
 * of them did not know about printed in the clear — a `postgres://` DSN
 * and an `Authorization: Bearer …` header both did. The rules now live in
 * `infra/cloud/platform/redact-output.mjs`, and this file is the contract
 * for THAT module: every shape below is asserted here, and the shell
 * surface's regression cases live next to it in
 * `infra/cloud/bin/tests/status.test.sh`.
 *
 * Run:
 *   node --test infra/cloud/platform/tests/redact-output.test.mjs
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { operatorText, redactOutput } from '../redact-output.mjs';

describe('redactOutput', () => {
  it('masks URL and DSN credentials', () => {
    assert.equal(
      redactOutput('postgres://staging:***@db.example.test/staging'),
      'postgres://[redacted]@db.example.test/staging'
    );
    assert.equal(
      redactOutput('https://user:***@api.fly.io/'),
      'https://[redacted]@api.fly.io/'
    );
  });

  it('masks JSON credential fields', () => {
    assert.equal(
      redactOutput('{"token":"SECRET","actor":"staging"}'),
      '{"token":"[redacted]","actor":"staging"}'
    );
  });

  it('masks Authorization headers', () => {
    assert.equal(
      redactOutput('Authorization: Bearer ***'),
      'Authorization: Bearer [redacted]'
    );
    assert.equal(
      redactOutput('Authorization: Basic ***'),
      'Authorization: Basic [redacted]'
    );
  });

  it("masks Fly's own FlyV1 authorization header", () => {
    assert.equal(
      redactOutput('FlyV1 fm2_SECRETVALUE'),
      'FlyV1 [redacted]'
    );
  });

  it('masks environment-style assignments', () => {
    assert.equal(
      redactOutput('FLY_API_TOKEN=SECRET'),
      'FLY_API_TOKEN=[redacted]'
    );
    assert.equal(
      redactOutput('TASKS_API_APPROVAL_SERVICE_CREDENTIALS=abc123'),
      'TASKS_API_APPROVAL_SERVICE_CREDENTIALS=[redacted]'
    );
  });

  it('masks credential keywords in both the assignment and the bare forms', () => {
    assert.equal(redactOutput('token SECRET'), 'token [redacted]');
    assert.equal(redactOutput('password=SECRET'), 'password=[redacted]');
    assert.equal(redactOutput('secret: SECRET'), 'secret: [redacted]');
    assert.equal(redactOutput('api_key=SECRET'), 'api_key=[redacted]');
  });

  it("masks Fly's token form", () => {
    assert.equal(redactOutput('fly_abc1234567890xyz'), '[redacted]');
    assert.equal(
      redactOutput('Error: failed (token=fly_ABCDEFGH1234)'),
      'Error: failed (token=[redacted])'
    );
  });

  it('keeps closing punctuation outside the masked value', () => {
    // The operator reads this line to diagnose a TLS or auth failure, so
    // it must not lose characters.
    assert.equal(
      redactOutput('Error: failed (token=fly_ABCDEFGH1234)'),
      'Error: failed (token=[redacted])'
    );
    assert.equal(
      redactOutput('FLY_API_TOKEN=SECRET.'),
      'FLY_API_TOKEN=[redacted].'
    );
    assert.equal(
      redactOutput('{"token":"SECRET"}'),
      '{"token":"[redacted]"}'
    );
    assert.equal(
      redactOutput('Authorization: Bearer ***)'),
      'Authorization: Bearer [redacted])'
    );
  });

  it('masks a value whole, punctuation inside it included', () => {
    // A trailing "." belongs to the sentence; a "." INSIDE the value does
    // not, and a secret that contains one must not be half-masked.
    assert.equal(
      redactOutput('PASSWORD=sk_live.abc'),
      'PASSWORD=[redacted]'
    );
  });

  it('is idempotent: redacting twice changes nothing', () => {
    const shapes = [
      'postgres://staging:***@db.example.test/staging',
      '{"token":"SECRET","actor":"staging"}',
      'Authorization: Bearer ***',
      'FlyV1 fm2_SECRETVALUE',
      'FLY_API_TOKEN=SECRET.',
      'token=fly_ABCDEFGH1234)',
      'TOKEN=[redacted]',
    ];
    for (const shape of shapes) {
      const once = redactOutput(shape);
      assert.equal(redactOutput(once), once, shape);
    }
  });

  it('leaves ordinary text alone', () => {
    assert.equal(
      redactOutput('Fly app sindustries-platform-staging already exists'),
      'Fly app sindustries-platform-staging already exists'
    );
    assert.equal(
      redactOutput('tls: x509: certificate is not trusted'),
      'tls: x509: certificate is not trusted'
    );
  });

  it('is a no-op for empty or non-string input', () => {
    assert.equal(redactOutput(''), '');
    assert.equal(redactOutput(undefined), '');
    assert.equal(redactOutput(null), '');
  });
});

describe('operatorText', () => {
  it('flattens a multi-line diagnostic to one line', () => {
    assert.equal(
      operatorText('first line\nsecond line\n'),
      'first line second line'
    );
  });

  it('redacts before it truncates, so a cap cannot expose a secret', () => {
    const text = `x${'y'.repeat(500)} FLY_API_TOKEN=SECRET`;
    const out = operatorText(text, 40);
    assert.ok(out.length <= 40, out.length);
    assert.ok(!out.includes('SECRET'), out);
  });

  it('caps the length at the documented default', () => {
    const out = operatorText('z'.repeat(1000));
    assert.equal(out.length, 400);
  });
});
