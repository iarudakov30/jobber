import { NodeSDK } from '@opentelemetry/sdk-node';

jest.mock('@opentelemetry/sdk-node', () => ({
  NodeSDK: jest.fn().mockImplementation(() => ({ start: jest.fn() })),
}));

describe('startTracing', () => {
  const env = process.env;

  beforeEach(() => {
    jest.mocked(NodeSDK).mockClear();
    process.env = { ...env };
  });
  afterAll(() => {
    process.env = env;
  });

  async function freshStartTracing() {
    let start!: typeof import('./tracing').startTracing;
    await jest.isolateModulesAsync(async () => {
      start = (await import('./tracing')).startTracing;
    });
    return start;
  }

  it('does nothing without an OTLP endpoint', async () => {
    delete process.env['OTEL_EXPORTER_OTLP_ENDPOINT'];

    (await freshStartTracing())('jobs');

    expect(NodeSDK).not.toHaveBeenCalled();
  });

  it('does nothing when the SDK is disabled', async () => {
    process.env['OTEL_EXPORTER_OTLP_ENDPOINT'] = 'http://localhost:4318';
    process.env['OTEL_SDK_DISABLED'] = 'true';

    (await freshStartTracing())('jobs');

    expect(NodeSDK).not.toHaveBeenCalled();
  });

  it('starts once with the service name', async () => {
    process.env['OTEL_EXPORTER_OTLP_ENDPOINT'] = 'http://localhost:4318';
    const startTracing = await freshStartTracing();

    startTracing('jobs');
    startTracing('jobs');

    expect(NodeSDK).toHaveBeenCalledTimes(1);
    expect(jest.mocked(NodeSDK).mock.calls[0][0]).toMatchObject({
      serviceName: 'jobs',
    });
    expect(jest.mocked(NodeSDK).mock.results[0].value.start).toHaveBeenCalled();
  });
});
