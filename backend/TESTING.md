# Testing — fast, parallel, isolated

All suites run against **throw-away databases**, never production. Two engines:

| Engine | Used for | Typical cost |
|---|---|---|
| **Local PostgreSQL** (`tools/localpg`, 127.0.0.1:54329, `optest_*` databases) | everything in FAST and FULL; one pristine copy per suite | ~1 s to clone a seeded copy; queries ≈ 0.2 ms |
| **Neon test branch** (`TEST_DATABASE_URL`) | the Neon-required subset in FULL (`testGuardTest` + the security/integration suites listed in `testSuites.mjs` → `NEON_REQUIRED`) | queries ≈ 100 ms+ (network) |

## Commands (from `backend/`)

```bash
npm run test:fast      # suites AFFECTED by your uncommitted changes + the whole security gate (always) — minutes
npm run test:full      # FULL REGRESSION before deploy: every suite on the local DB in parallel, then the Neon-required subset, then the real-browser UI test
npm run test:ui        # only the real-browser UI test (desktop + phone) against a local server on a pristine local database
npm run test:profile   # where the time goes: Neon vs local (round-trips, clone/reset/seed, server start, API timings)
node src/scripts/runTests.mjs a b c      # exactly these suites       ·  --parallel=N  ·  --since=<git-ref>  ·  --no-neon  ·  --neon-all (old behaviour: everything on Neon, sequential)
```

First run installs the local PostgreSQL into `%LOCALAPPDATA%\optest-pg` (the Windows binaries cannot start from a path with non-ASCII characters — this project's folder is Arabic) and builds the base database
(schema via `prisma db push` + the seeded fixtures: marker row, fake connected Meta account, fixture products, test owner). It is rebuilt only when `prisma/schema.prisma` or `testDb.mjs` changes.

## Why parallel is safe
* every suite gets its **own database** (`CREATE DATABASE … TEMPLATE optest_base`) and drops it afterwards — suites cannot see each other's rows;
* mock servers (fake Meta Graph API, in-process express apps) bind to port 0;
* the UI test is the only user of port 4000 and runs alone, after the suites.

## What cannot be skipped
`SECURITY_GATE` (write gates, permissions, executor guards, approvals, the test guard) is part of **every** FAST run, whatever changed. FULL runs all 42 suites — nothing is removed to save time.

## Guard rails (`_testGuard.js`)
* Neon target: `TEST_DATABASE_URL` must not share an endpoint with any production URL, must be a direct (non-pooler) URL and the database must carry the test marker row.
* Local target (`TEST_DB_TARGET=local`, set only by the runner): `LOCAL_TEST_DATABASE_URL` must be a **loopback** host and a database named **`optest_*`**, and must carry the marker row. It never falls back to Neon or to `DATABASE_URL`.
* `testGuardTest` verifies both targets (23 assertions, including every refusal case).

## Mock vs real
No suite talks to the real Meta Graph API: the Meta client points at a loopback mock (`META_GRAPH_MOCK=1`, loopback URL only). A passing mock suite is **not** proof of a real Meta write — real proof is a separate, owner-approved step.
