module.exports = {
  displayName: 'realtime',
  preset: '../../jest.preset.js',
  testEnvironment: 'node',
  // Gateway replicas against a Testcontainers RabbitMQ, which starts slowly when every project
  // runs at once.
  testTimeout: 30_000,
  transform: {
    '^.+\\.[tj]s$': ['ts-jest', { tsconfig: '<rootDir>/tsconfig.spec.json' }],
  },
  moduleFileExtensions: ['ts', 'js', 'html'],
  coverageDirectory: '../../coverage/apps/realtime',
};
