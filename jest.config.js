module.exports = {
  testEnvironment: 'node',
  testMatch: ['**/tests/**/*.test.js'],
  testPathIgnorePatterns: ['/tests/database.integration.test.js'],
  collectCoverageFrom: ['src/**/*.js', '!src/server.js']
};
