module.exports = {
  displayName: 'executor',
  preset: '../../jest.preset.js',
  testEnvironment: 'node',
  // The email worker tests run RabbitMQ, Redis and Mailpit in Testcontainers.
  testTimeout: 30_000,
  transform: {
    '^.+\\.[tj]s$': ['ts-jest', { tsconfig: '<rootDir>/tsconfig.spec.json' }],
  },
  moduleFileExtensions: ['ts', 'js', 'html'],
  coverageDirectory: '../coverage/executor',
};
