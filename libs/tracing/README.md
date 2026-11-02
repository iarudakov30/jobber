# tracing

OpenTelemetry bootstrap for the backend apps. Call `startTracing(<service>)` right after `module-alias/register` in `main.ts`, before anything imports NestJS, http, gRPC or pg: instrumentations patch those modules when they are first required. Does nothing unless `OTEL_EXPORTER_OTLP_ENDPOINT` is set.
