import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

describe('CJS preload', () => {
  it('starts the OpenTelemetry SDK when loaded with --require', () => {
    const registerPath = fileURLToPath(new URL('./register.cjs', import.meta.url));
    const result = spawnSync(
      process.execPath,
      ['--require', registerPath, '--eval', 'process.stdout.write("ready")'],
      {
        encoding: 'utf8',
        env: {
          ...process.env,
          NODE_ENV: 'test',
          OTEL_SERVICE_NAME: 'otel-register-test',
        },
        timeout: 10_000,
      },
    );

    expect(result.error).toBeUndefined();
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toBe('ready');
  });
});
