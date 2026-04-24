# api-server integration tests

These tests run against a real Postgres database via the same `@workspace/db`
pool the api-server uses.

## How isolation works

`pnpm test` invokes `tsx ./test/setup.ts`. That wrapper:

1. Connects to `DATABASE_URL` (or `TEST_DATABASE_URL`, if set) as an admin
   connection and **sweeps any leftover per-run `<basename>_test_<hex>`
   databases older than 1 hour** (orphans from a prior run that was killed
   before its cleanup `finally` could run — SIGKILL, OOM, container
   teardown). The sweep logs what it dropped (or that there was nothing
   to drop). The cached template DB (see below) has a fixed name and is
   never touched by the sweep.
2. Makes sure a cached **template database** named
   `<basename>_test_template` exists with the current schema applied. We
   hash the drizzle schema source (everything under `lib/db/src/schema/`,
   plus `drizzle.config.ts` and `scripts/prepare-push.mjs`) and compare it
   against a stamp stored inside the template DB itself. The expensive
   `pnpm --filter @workspace/db push-force` only runs when the stamp is
   missing or stale; on a warm cache this step is a single `SELECT`.
3. Issues `CREATE DATABASE <basename>_test_<hex> TEMPLATE
   <basename>_test_template` to mint a fresh, private database for this
   run by cloning the template. Postgres clones a small schema in well
   under a second. The hex suffix on the per-run name is
   `<8 hex unix-seconds><8 hex random>` so the sweeper can recover the
   creation time from the name without needing `pg_stat_file` or any
   elevated privileges.
4. Spawns the actual `tsx --test` runner (`./test/run.ts`) as a child
   process with `DATABASE_URL` pointing at the new database. That way
   `@workspace/db`'s connection pool — constructed at module init from
   `process.env.DATABASE_URL` — binds to the per-run test DB before any
   query runs.
5. Waits for the child to exit, drops the per-run database (the template
   sticks around for the next run), and forwards the exit code.

A wrapper subprocess (rather than top-level await inside the test entry) is
required because ESM modules with top-level await let sibling modules
evaluate concurrently. Mutating `process.env.DATABASE_URL` from a TLA in
the test entry would race against `@workspace/db`'s pool construction.

The template refresh and the per-run clone are both serialized via a
Postgres advisory lock keyed on the template name, so two concurrent
`pnpm test` invocations can't both decide to rebuild the template — and
neither can clone from a template that's mid-rebuild.

This means:

- Tests can run with `--test-concurrency` > 1 without rows from one test
  leaking into another's view (e.g. the unscoped `GET /api/shift/live`
  aggregation).
- Two `pnpm test` invocations can execute in parallel — each gets its own
  per-run database, both cloned from the shared template.
- Running the suite while the dev server is up no longer pollutes the dev
  database.
- A hard crash (SIGKILL, OOM, container teardown) may leave one orphan
  `<basename>_test_<hex>` per-run database behind because the cleanup
  `finally` doesn't run. The next `pnpm test` invocation sweeps any such
  orphan older than 1 hour, so they don't accumulate over time.
  Concurrent in-flight runs are unaffected because the threshold is well
  above any realistic suite duration. The template DB is safe to drop
  manually too; the next run will rebuild it.

## Environment

- `DATABASE_URL` — required. Used both as the admin connection that
  creates and drops the template and per-run databases, and as the
  template for those URLs (only the database-name segment is replaced).
- `TEST_DATABASE_URL` — optional. If set, used in place of `DATABASE_URL`
  for the admin connection. Useful on CI when you want to point tests at a
  separate, non-production cluster.

## Running

```sh
pnpm --filter @workspace/api-server test
```

On a cold cache (first run, or after a schema change) the wrapper spends
a couple of seconds rebuilding the template. Every subsequent run reuses
that template and starts the test process in well under a second.
