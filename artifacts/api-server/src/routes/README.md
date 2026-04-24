# API server route conventions

Quick conventions for code in this folder. Keep it short — read before adding
new routes.

## Drizzle: never bind a JS array with `sql\`... = ANY(${arr})\``

Drizzle's tagged `sql` template flattens single-element JS arrays into a
**scalar** parameter. That means a query like:

```ts
// BAD — crashes with a 500 when `ids.length === 1`
.where(sql`${table.id} = ANY(${ids})`)
```

works while `ids.length > 1` (Postgres receives an array literal) and then
fails in production the moment exactly one row qualifies, because Postgres
gets a scalar where it expected an array. This bit us on
`/api/shift/live` — see the fix in `live.ts` (commit history) for the
real-world incident.

Always use the `inArray` helper instead, and short-circuit empty arrays so we
don't issue a no-op query:

```ts
import { inArray } from "drizzle-orm";

const rows = ids.length
  ? await db.select().from(table).where(inArray(table.id, ids))
  : [];
```

If you genuinely need raw SQL for something `inArray` can't express, bind the
array explicitly as a typed Postgres array, e.g.
`sql\`${table.id} = ANY(${sql.raw(`ARRAY[${ids.map(Number).join(",")}]::int[]`)})\``,
but prefer `inArray` in 99% of cases.
