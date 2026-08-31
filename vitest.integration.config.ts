import { defineConfig } from 'vitest/config';

/**
 * Integration tests run against real MySQL servers in Docker and live in a
 * separate Vitest project on purpose: `npm test` must stay fast and
 * dependency-free (no Docker, no network), while `npm run test:integration`
 * opts in to live servers plus the native `mysqldump`/`mysql` binaries that
 * ship inside those containers. See `docs/round-trip-testing.md`.
 *
 * When no server is reachable the suites skip themselves with a clear
 * message rather than failing — set `MYSQL_TEST_REQUIRED=1` (as CI should)
 * to turn "unreachable" into a hard error, so the tests can never silently
 * no-op in an environment that was supposed to run them.
 */
export default defineConfig({
  test: {
    include: ['integration/**/*.test.ts'],
    environment: 'node',
    // Several physical servers, and suites that create/drop databases on
    // them: run files sequentially so concurrent DDL never contends.
    fileParallelism: false,
    testTimeout: 300_000,
    hookTimeout: 300_000,
  },
});
