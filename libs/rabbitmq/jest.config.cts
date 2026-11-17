module.exports = {
  displayName: 'rabbitmq',
  preset: '../../jest.preset.js',
  testEnvironment: 'node',
  // The tests run against a Testcontainers RabbitMQ and wait for real retry and delay TTLs.
  testTimeout: 30_000,
  transform: {
    '^.+\\.[tj]s$': ['ts-jest', { tsconfig: '<rootDir>/tsconfig.spec.json' }],
  },
  moduleFileExtensions: ['ts', 'js', 'html'],
  coverageDirectory: '../coverage/rabbitmq',
};
