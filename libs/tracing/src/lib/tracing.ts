import { NodeSDK } from '@opentelemetry/sdk-node';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { ExpressInstrumentation } from '@opentelemetry/instrumentation-express';
import { GraphQLInstrumentation } from '@opentelemetry/instrumentation-graphql';
import { GrpcInstrumentation } from '@opentelemetry/instrumentation-grpc';
import { HttpInstrumentation } from '@opentelemetry/instrumentation-http';
import { NestInstrumentation } from '@opentelemetry/instrumentation-nestjs-core';
import { PgInstrumentation } from '@opentelemetry/instrumentation-pg';

let sdk: NodeSDK | undefined;

/**
 * Starts OpenTelemetry tracing for `serviceName`, exporting spans over OTLP/HTTP to
 * `OTEL_EXPORTER_OTLP_ENDPOINT` (e.g. Jaeger at http://localhost:4318). Does nothing when that
 * variable is unset or `OTEL_SDK_DISABLED=true`.
 *
 * Must run before NestJS, http, express, gRPC or pg are first required: the instrumentations
 * patch those modules on load, so anything required earlier goes untraced. In `main.ts` that
 * means the line right after `require('module-alias/register')`.
 *
 * Pulsar has no instrumentation; `@jobber/pulsar` and `@jobber/outbox` carry the trace context
 * in message properties themselves.
 */
export function startTracing(serviceName: string): void {
  if (
    sdk ||
    !process.env['OTEL_EXPORTER_OTLP_ENDPOINT'] ||
    process.env['OTEL_SDK_DISABLED'] === 'true'
  ) {
    return;
  }
  sdk = new NodeSDK({
    serviceName,
    traceExporter: new OTLPTraceExporter(),
    instrumentations: [
      new HttpInstrumentation(),
      new ExpressInstrumentation(),
      new NestInstrumentation(),
      // Field-level resolver spans would bury the interesting ones.
      new GraphQLInstrumentation({ ignoreTrivialResolveSpans: true }),
      new GrpcInstrumentation(),
      // Only queries inside a request or message: the outbox relay's background polling would
      // otherwise start a new trace every few hundred milliseconds.
      new PgInstrumentation({ requireParentSpan: true }),
    ],
  });
  sdk.start();
}
