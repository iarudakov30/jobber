module.exports = {
  displayName: 'wallet',
  preset: '../../jest.preset.js',
  testEnvironment: 'node',
  // Tests against a Testcontainers PostgreSQL: 200-way concurrency tests need more than the
  // 5 s default when every project's tests run at once.
  testTimeout: 30_000,
  transform: {
    '^.+\\.[tj]s$': ['ts-jest', { tsconfig: '<rootDir>/tsconfig.spec.json' }],
  },
  moduleFileExtensions: ['ts', 'js', 'html'],
  coverageDirectory: '../../coverage/apps/wallet',
};
