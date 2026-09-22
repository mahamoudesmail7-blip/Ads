# Disaster Recovery Runbook

This is the playbook for bringing production back online if code, database, or
deployment configuration is lost or broken. It exists because of a real
incident — read that first if you haven't.

## The 2026-09-13 incident (why this document exists)

`prisma migrate diff --shadow-database-url "$DATABASE_URL"` was run with the
**real production connection string** passed as the disposable "shadow"
database parameter. Prisma replays the entire migration history into a shadow
database to compute a diff — pointing that at production wiped every row in
all 78 tables (schema stayed intact; data did not). Recovery was via Neon
Point-in-Time Recovery to `2026-09-13 11:44:00 UTC`, which worked because the
incident was caught and reported within minutes.

**The absolute rule that came out of this:** never pass `DATABASE_URL` as a
Prisma shadow database, and never treat a production connection string as
disposable/scratch infrastructure for any command. See
`backend/src/scripts/dbSafetyGuard.js` for the enforced guard.

---

## The three independent recovery layers

1. **GitHub** — every deployed version of the application code.
2. **Neon** — the production Postgres database (Point-in-Time Recovery +
   an independent logical backup, see Phase 2 below).
3. **Railway environment variables** — the secrets and configuration that
   connect the code to the database and to every third-party API
   (OpenAI, Meta, Easy Orders, etc.).

If all three are intact (or recoverable), production can always be rebuilt
from scratch. This runbook assumes you may be recovering from a state where
one or more of these is partially or fully lost.

---

## PHASE 1 — Git code protection

### Current state (audited 2026-09-13)

- Branch: `main`
- HEAD: `4c711855b9de9de725833bcff103a89de2ff744d`
- `origin/main`: same commit (nothing local unpushed)
- Working tree: clean
- Production deployed commit: `4c711855b9de9de725833bcff103a89de2ff744d`
  (confirmed live via `/health` after the safety-guard deploy)
- No `backup-YYYY-MM-DD-HHMM` tags exist yet — see the tagging procedure
  below for how one gets created (only ever with explicit approval).

### Backup tag procedure

Before any major/risky change (a schema migration, a large refactor, an AI
provider migration, etc.), tag the current known-good commit:

```bash
git tag -a backup-2026-09-13-1600 -m "Known-good before <describe the change>"
git push origin backup-2026-09-13-1600
```

**Never create or push a tag without first showing exactly what commit it
points to and what it contains** (`git log -1 <commit>`, `git diff
<previous-tag>..<commit> --stat`) and getting explicit approval. A tag is a
promise that this is a *known-good* state — tagging a broken commit defeats
the whole point.

### Restoring code from a previous tag/commit (without deploying)

To inspect or recover code from a known-good point **without touching the
live `main` branch or triggering a deploy**:

```bash
# Look at the code as of a tag/commit, in a separate local branch:
git fetch origin
git checkout -b recovery-inspect backup-2026-09-13-1600

# Or just view a single file as of that point without checking anything out:
git show backup-2026-09-13-1600:backend/src/server.js

# Or produce a diff against the current main to see exactly what changed since:
git diff backup-2026-09-13-1600..main
```

To actually **roll production back** to a known-good tag (this DOES deploy —
only do this with explicit approval and after confirming the target commit
is really what you want):

```bash
git checkout main
git revert --no-commit <bad-commit>..HEAD   # preferred: keeps history, reversible
# OR, if a hard reset is truly necessary (destroys forward history on main):
# git reset --hard backup-2026-09-13-1600
git push origin main
```

Prefer `git revert` over `git reset --hard` + force-push whenever possible —
it never rewrites shared history, so it can't strand anyone else's clone or
conflict with what Railway/GitHub already have recorded.

---

## PHASE 2 — Database backup / Neon

### What this audit could verify vs. what needs manual confirmation

This audit has **no access to the Neon dashboard or Neon's management API**
— everything below about your specific plan/retention needs to be confirmed
by you in the Neon console (console.neon.tech → your project → Backups /
Restore).

**A) Neon Point-in-Time Recovery (PITR)** — Neon retains a window of write-
ahead log history that lets you restore the whole database (or a branch) to
any timestamp within that window, without needing a separate backup file.
This is what recovered the 2026-09-13 incident. **Confirm in your dashboard:**
what your current plan's retention window actually is — it varies by Neon
plan and can be as short as a few hours on some tiers or as long as 30 days
on others. This incident is direct proof that a short window is a real risk,
not a theoretical one.

**B) Scheduled snapshots** — whether your current Neon plan includes
scheduled/managed snapshots beyond PITR is plan-dependent; check your
dashboard's Backups section. This audit does not assume any specific
feature is enabled and does not change your Neon configuration.

**C) Independent logical backup (built in this task, plan-independent)** —
`backend/src/scripts/logicalBackup.js`. Read-only against the database
(paginated `findMany()` calls only, never writes), dumps every table to
newline-delimited JSON under `backend/backups/<timestamp>/` (git-ignored —
this contains real customer names/phones/addresses, never commit it) plus a
`manifest.json` with row counts and the git commit at backup time.

```bash
cd backend
npm run backup:logical                    # every table
npm run backup:logical -- --only=user,product   # just some tables
npm run backup:logical -- --out=/path/to/external/drive
```

This layer exists specifically because PITR alone is not enough for
long-term recovery confidence (proven by this incident) — it's a second,
completely independent copy of the data that doesn't depend on Neon's
retention window at all, as long as you store the output somewhere durable
(an encrypted external drive, a private cloud bucket — never inside this
git repo).

### Recommended retention

| Backup | Cadence | Where |
|---|---|---|
| Neon PITR | continuous (automatic) | Neon's own storage — confirm your plan's window in the dashboard |
| Daily logical backup | once every 24h | `npm run backup:logical`, copied off-machine (encrypted external storage / private bucket) |
| Weekly logical backup | once every 7 days, kept longer than daily | same mechanism, longer retention (e.g. keep the last 8 weekly backups even after daily ones roll off) |
| Before-major-change backup | manually, right before any schema migration, bulk data operation, or risky refactor | same mechanism, kept indefinitely alongside the corresponding git tag |

If your current Neon plan's PITR window is shorter than 24 hours, the daily
logical backup becomes your real safety net, not a nice-to-have — treat it
as mandatory until/unless you upgrade the Neon plan (a decision for you to
make; this task does not enable or change any paid Neon feature).

---

## PHASE 3 — Environment / secret backup

**This runbook never contains real secret values.** `backend/.env.example`
has every variable name the backend reads from `process.env` (audited
directly from source, not guessed), with empty/placeholder values only.

### Checklist: securely backing up the REAL Railway variables

1. In the Railway dashboard, open the backend service → **Variables** tab.
2. Use Railway's own "Raw Editor" / export view to copy the current
   variable set as text.
3. **Do not paste this into Slack, email, a git repo, a shared doc, or any
   AI chat (including this one).** Save it into a password manager (1Password,
   Bitwarden, etc.) as a secure note, or an encrypted file
   (`gpg -c railway-vars-backup.txt` → keep only the encrypted `.gpg` file,
   delete the plaintext).
4. Label it with the date and the git commit that was live at the time
   (see `backup-manifest.json` → `code.knownGoodCommit`), so you know which
   code version it matches.
5. Repeat this after every time you add/change a production variable —
   a stale variable backup is nearly as bad as none, since Scenario C below
   depends on it being current.
6. Never store the plaintext backup file anywhere this repo's `.gitignore`
   doesn't already exclude, and never store it unencrypted on a shared drive.

---

## PHASE 4 — Pre-flight safety guards for dangerous operations

Three layers, all in `backend/src/scripts/`:

- **`dbSafetyGuard.js`** — the shared rules: `assertSafeShadowUrl` (shadow
  vs. production URL comparison), `classifyDangerousPrismaCommand` (flags
  `migrate reset`, `db push`, `migrate diff --shadow-database-url`),
  `classifyDangerousSql` (flags `DROP DATABASE`/`DROP SCHEMA`/`DROP TABLE`/
  `TRUNCATE`/WHERE-less `DELETE`/`UPDATE`), and `assertConfirmed` (the
  confirmation gate every dangerous op must pass).
- **`prismaMigrateDiffSafe.js`** — safe wrapper specifically for
  `migrate diff --shadow-database-url`; refuses to run unless
  `SHADOW_DATABASE_URL` is genuinely separate (different host AND different
  database name) from `DATABASE_URL`.
- **`guardedPrismaCommand.js`** — general wrapper for any `prisma` CLI
  command; classifies it first and requires
  `CONFIRM_DESTRUCTIVE_DB_OP=I_UNDERSTAND_THIS_IS_DESTRUCTIVE` (set inline,
  never exported persistently) before running anything destructive.
- **`guardedDbExecute.js`** — wrapper for `prisma db execute --file <sql>`;
  scans the SQL file content for destructive keywords before running it,
  same confirmation requirement.

No environment is ever implicitly trusted as "safe" — every destructive
operation requires the exact confirmation string for that one invocation,
regardless of which database it targets. This deliberately avoids hardcoding
or hashing the real production host/database name into source.

Run `npm run db:safety-test` in `backend/` any time these files change —
33 tests, 100% fake URLs/commands/SQL, zero database access.

---

## PHASE 5 — Backup manifest

`backup-manifest.json` (repo root) is a small, non-secret pointer file:
current known-good commit, the database provider/name (not the connection
string), the deployment provider, and where the safety guards live. Update
`code.knownGoodCommit` and `code.tag` whenever you create a new backup tag.
**Never add passwords, tokens, connection strings, or API keys to it** — it
is committed to git.

---

## PHASE 6 — Recovery scenarios

Every scenario ends with the same verification checklist (Phase "Verification"
below) — don't declare recovery complete until you've actually run it.

### Scenario A — Bad code deployment

1. Identify the last known-good commit or tag (`backup-manifest.json` →
   `code.knownGoodCommit`, or `git log --oneline` / `git tag -l`).
2. Roll back:
   ```bash
   git checkout main
   git revert --no-commit <bad-commit>..HEAD
   git commit -m "Revert to known-good state after bad deploy"
   git push origin main
   ```
   (Railway auto-deploys from `main` — this push triggers the rollback
   deploy. If you need it instantly and revert isn't safe/fast enough, use
   Railway's own "redeploy a previous deployment" button in its dashboard
   instead of touching git at all.)
3. Verify (see the Verification checklist below).

### Scenario B — Database data deleted/corrupted

1. **STOP WRITES immediately** — pause the Railway service (or otherwise
   stop traffic) so nothing writes new data on top of the corrupted/empty
   state while you investigate.
2. Identify the incident time as precisely as possible (check recent
   command history, deploy logs, or error reports — the 2026-09-13 incident
   was pinpointed from a file timestamp left by the destructive command).
3. In the Neon console, use "Restore" / point-in-time recovery preview to
   look at historical data **before restoring** — Neon lets you preview a
   past point before committing to a restore.
4. Verify the previewed historical state actually looks right: spot-check
   `users`, `products`, recent `easyorders_orders` — do the counts and most
   recent rows look plausible for a timestamp just before the incident?
5. Restore to a timestamp a minute or two before the incident (not
   exactly at it — leave margin).
6. Resume the Railway service.
7. Run the full Verification checklist below.

### Scenario C — Railway project/environment lost

1. Deploy code from the known-good Git tag/commit
   (`backup-manifest.json` → `code.knownGoodCommit`) to a new Railway
   project/service.
2. Recreate environment variables from your secure offline backup (Phase 3
   checklist) — paste them into the new service's Variables tab. Never
   type them from memory; use the encrypted backup as the source of truth.
3. Point `DATABASE_URL` at the restored/existing Neon database.
4. Deploy, then run the Verification checklist below.

### Scenario D — Complete disaster (GitHub + Neon + Railway all lost)

1. Recover GitHub: if the repo itself is gone, restore from any team
   member's local clone (`git remote add origin <new-url> && git push
   --all && git push --tags`) or from your GitHub org's own backup/export
   if one exists.
2. Recover Neon: create a new Neon project/database, then restore from the
   most recent **independent logical backup** (Phase 2C) — since Neon's own
   PITR history is gone if the Neon project itself was deleted:
   ```bash
   # Per table, from the NDJSON dump — this is a starting point, not a
   # one-liner: write a small script (or extend logicalBackup.js) that reads
   # each .ndjson file and createMany()s it back in, table by table, in an
   # order that respects foreign keys (users/products before anything that
   # references them). Do this against a NEW, empty database — never against
   # a database you're not certain is safe to write to.
   ```
3. Recover Railway: follow Scenario C above against the newly-restored
   Neon database.
4. Run the Verification checklist below — this scenario deserves the most
   thorough check since every layer was rebuilt.

---

## Verification checklist (run after EVERY recovery scenario)

Don't declare recovery complete just because the app loads. Confirm:

- [ ] `GET /health` returns `{"status":"ok","db":"connected"}`
- [ ] `users` table has a plausible row count (compare against your last
      known backup manifest or logical backup — don't hard-code a specific
      number as permanently "correct", data grows over time)
- [ ] `products` table has a plausible row count
- [ ] `easyorders_orders` has recent rows (check the most recent `date`)
- [ ] `meta_connections` has the expected connection(s)
- [ ] `meta_performance_snapshots` has recent rows (check the most recent
      `date_start`) and a real, non-zero spend aggregate
- [ ] `amb_products` / `pmc_profiles` have plausible counts
- [ ] A real user can log in (don't create a new user to "test" this —
      confirm an existing account works)
- [ ] No Prisma schema-mismatch errors in the server logs
- [ ] No unrelated behavior changed (Meta write actions, Clone, Scheduling,
      Easy Orders integration — spot-check they still work as before)

Use these as a **comparison reference**, not a fixed pass/fail number —
real production data changes every day, so "does this look like a healthy,
continuously-growing dataset" matters more than matching an exact count.
