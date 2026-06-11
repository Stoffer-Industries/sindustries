import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  ATTR_SERVICE_NAME,
  ATTR_SERVICE_NAMESPACE,
} from '@opentelemetry/semantic-conventions';

const startFn = vi.fn();

vi.mock('@opentelemetry/sdk-node', () => ({
  NodeSDK: vi.fn(function MockNodeSDK() {
    return { start: startFn };
  }),
}));

describe('startOtel when SDK starts', () => {
  afterEach(async () => {
    vi.resetModules();
    vi.clearAllMocks();
    delete process.env.OTEL_SDK_DISABLED;
    delete process.env.OTEL_SERVICE_NAME;
    delete process.env.OTEL_SERVICE_NAMESPACE;
    delete process.env.OTEL_ENVIRONMENT;
    process.env.NODE_ENV = 'test';
  });

  async function load() {
    const { NodeSDK } = await import('@opentelemetry/sdk-node');
    const { startOtel } = await import('./index.js');
    return { NodeSDK, startOtel };
  }

  function getSdkResource(NodeSDK: Awaited<ReturnType<typeof load>>['NodeSDK']) {
    const cfg = vi.mocked(NodeSDK).mock.calls[0]?.[0];
    expect(cfg?.resource).toBeDefined();
    return cfg!.resource!;
  }

  it('builds resource from options and env', async () => {
    process.env.OTEL_SERVICE_NAMESPACE = 'my-ns';
    process.env.OTEL_ENVIRONMENT = 'staging';
    const { NodeSDK, startOtel } = await load();
    startOtel({ serviceName: 'api-test' });
    expect(startFn).toHaveBeenCalledTimes(1);
    const resource = getSdkResource(NodeSDK);
    expect(resource.attributes[ATTR_SERVICE_NAME]).toBe('api-test');
    expect(resource.attributes[ATTR_SERVICE_NAMESPACE]).toBe('my-ns');
    expect(resource.attributes['deployment.environment']).toBe('staging');
  });

  it('prefers options.serviceName over OTEL_SERVICE_NAME', async () => {
    process.env.OTEL_SERVICE_NAME = 'env-name';
    const { NodeSDK, startOtel } = await load();
    startOtel({ serviceName: 'opt-name' });
    const resource = getSdkResource(NodeSDK);
    expect(resource.attributes[ATTR_SERVICE_NAME]).toBe('opt-name');
  });

  it('uses OTEL_SERVICE_NAME when options omit serviceName', async () => {
    process.env.OTEL_SERVICE_NAME = 'tasks-api';
    const { NodeSDK, startOtel } = await load();
    startOtel();
    const resource = getSdkResource(NodeSDK);
    expect(resource.attributes[ATTR_SERVICE_NAME]).toBe('tasks-api');
  });

  it('defaults service name and namespace', async () => {
    const { NodeSDK, startOtel } = await load();
    startOtel();
    const resource = getSdkResource(NodeSDK);
    expect(resource.attributes[ATTR_SERVICE_NAME]).toBe('unknown-service');
    expect(resource.attributes[ATTR_SERVICE_NAMESPACE]).toBe('sindustries');
  });

  it('falls back deployment.environment to NODE_ENV', async () => {
    delete process.env.OTEL_ENVIRONMENT;
    process.env.NODE_ENV = 'production';
    const { NodeSDK, startOtel } = await load();
    startOtel();
    const resource = getSdkResource(NodeSDK);
    expect(resource.attributes['deployment.environment']).toBe('production');
  });

  it('is idempotent: only one SDK construction and start', async () => {
    const { NodeSDK, startOtel } = await load();
    startOtel({ serviceName: 'once' });
    startOtel({ serviceName: 'ignored' });
    expect(NodeSDK).toHaveBeenCalledTimes(1);
    expect(startFn).toHaveBeenCalledTimes(1);
  });
});
