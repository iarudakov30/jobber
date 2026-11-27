module.exports = {
  displayName: 'market',
  preset: '../../jest.preset.js',
  testEnvironment: 'node',
  // Tests against Testcontainers PostgreSQL, Redis and RabbitMQ: the failover test waits for a
  // leader lock to expire, and containers start slowly when every project runs at once.
  testTimeout: 30_000,
  // Nothing in the suite reaches the internet, whatever apps/market/.env says.
  setupFiles: ['<rootDir>/src/testing/offline.ts'],
  transform: {
    '^.+\\.[tj]s$': ['ts-jest', { tsconfig: '<rootDir>/tsconfig.spec.json' }],
  },
  moduleFileExtensions: ['ts', 'js', 'html'],
  coverageDirectory: '../../coverage/apps/market',
};
