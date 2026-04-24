# api-server integration tests

These tests run against a real Postgres database via the same `@workspace/db`
pool the api-server uses.

## How isolation works

`pnpm test` invokes `tsx ./test/setup.ts`. That wrapper:

1. Connects to `DATABASE_URL` (or `TEST_DATABASE_URL`, if set) as an admin
   connection.
2. Issues `CREATE DATABASE <basename>_test_<random>` to mint a fresh,
   private database for this run.
3. Runs `pnpm --filter @workspace/db push-force` against that new database
   to apply the current schema.
4. Spawns the actual `tsx --test` runner (`./test/run.ts`) as a child
   process with `DATABASE_URL` pointing at the new database. That way
   `@workspace/db`'s connection pool — constructed at module init from
   `process.env.DATABASE_URL` — binds to the per-run test DB before any
   query runs.
5. Waits for the child to exit, drops the per-run database, and forwards
   the exit code.

A wrapper subprocess (rather than top-level await inside the test entry) is
required because ESM modules with top-level await let sibling modules
evaluate concurrently. Mutating `process.env.DATABASE_URL` from a TLA in
the test entry would race against `@workspace/db`'s pool construction.

This means:

- Tests can run with `--test-concurrency` > 1 without rows from one test
  leaking into another's view (e.g. the unscoped `GET /api/shift/live`
  aggregation).
- Two `pnpm test` invocations can execute in parallel — each gets its own
  database.
- Running the suite while the dev server is up no longer pollutes the dev
  database.
- A crash leaves at most one orphan `<basename>_test_<hex>` database —
  easy to spot and `DROP DATABASE` manually if needed.

## Environment

- `DATABASE_URL` — required. Used both as the admin connection that creates
  and drops the per-run database, and as the template for the per-run URL
  (only the database-name segment is replaced).
- `TEST_DATABASE_URL` — optional. If set, used in place of `DATABASE_URL`
  for the admin connection. Useful on CI when you want to point tests at a
  separate, non-production cluster.

## Running

```sh
pnpm --filter @workspace/api-server test
```

The schema push at startup adds a few seconds to the run; everything
afterwards is identical to before.
