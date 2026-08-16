/** @type {import('ts-jest').JestConfigWithTsJest} */
module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  roots: ['<rootDir>/tests'],
  transform: {
    // event-replay.ts carries pre-existing `RawRow` narrowing errors unrelated
    // to any test — excluding it from diagnostics lets its pure functions be
    // tested without ts-jest refusing to compile the file over them.
    '^.+\\.tsx?$': [
      'ts-jest',
      { tsconfig: 'tsconfig.json', diagnostics: { exclude: ['**/event-replay.ts'] } },
    ],
  },
  testMatch: ['**/*.test.ts'],
  moduleFileExtensions: ['ts', 'tsx', 'js', 'json'],
};
