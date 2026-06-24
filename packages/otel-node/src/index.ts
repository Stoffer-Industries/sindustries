import { getNodeAutoInstrumentations } from '@opentelemetry/auto-instrumentations-node';
import { OTLPMetricExporter } from '@opentelemetry/exporter-metrics-otlp-http';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { Resource } from '@opentelemetry/resources';
import { NodeSDK } from '@opentelemetry/sdk-node';
import { PeriodicExportingMetricReader } from '@opentelemetry/sdk-metrics';
import {
  ATTR_SERVICE_NAME,
  ATTR_SERVICE_NAMESPACE,
} from '@opentelemetry/semantic-conventions';

export type StartOtelOptions = {
  /** Overrides OTEL_SERVICE_NAME when set. */
  serviceName?: string;
};

let started = false;

/**
 * Registers OpenTelemetry for Node. Call once, before loading HTTP/Express.
 * No-op when OTEL_SDK_DISABLED is 1/true.
 */
export function startOtel(options?: StartOtelOptions): void {
  if (started) {
    return;
  }
  const disabled = process.env.OTEL_SDK_DISABLED;
  if (disabled === '1' || disabled === 'true') {
    return;
  }

  const serviceName =
    options?.serviceName ??
    process.env.OTEL_SERVICE_NAME ??
    'unknown-service';
  const namespace = process.env.OTEL_SERVICE_NAMESPACE ?? 'sindustries';
  const environment =
    process.env.OTEL_ENVIRONMENT ?? process.env.NODE_ENV ?? 'development';

  const resource = new Resource({
    [ATTR_SERVICE_NAME]: serviceName,
    [ATTR_SERVICE_NAMESPACE]: namespace,
    'deployment.environment': environment,
  });

  const traceExporter = new OTLPTraceExporter();
  const metricExporter = new OTLPMetricExporter();
  const metricReader = new PeriodicExportingMetricReader({
    exporter: metricExporter,
    exportIntervalMillis: 15_000,
  });

  const sdk = new NodeSDK({
    resource,
    traceExporter,
    metricReader,
    instrumentations: [
      getNodeAutoInstrumentations({
        '@opentelemetry/instrumentation-fs': { enabled: false },
      }),
    ],
  });

  sdk.start();
  started = true;
}
