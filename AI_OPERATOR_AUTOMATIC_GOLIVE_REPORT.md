# AI Operator — AUTOMATIC go-live preparation (release + rollback plan)

Status when written: **prepared locally, NOT pushed, NOT deployed, AUTOMATIC NOT active.** Production (`e45f223`) is unchanged by this work: no Meta write, no policy saved, no setting changed.

## Commits to approve (on top of `e45f223`)
1. `f042bc5` — Activation decision sheet (read-only), AUTOMATIC journey test on the Meta mock, `budgetUiTest` flake fix.
2. *(next commit)* — Global automation rules + inheritance with provenance, stock policy (unknown = WARNING, out-of-stock = BLOCK, strict mode optional), product `maxChangesPerDay`, bulk overview / bulk drafts / bulk preview / gated bulk activation, the AUTOMATIC control panel, Media-library sync warning fix, multi-instance test.

## What changed (and what did not)
| Area | Change |
|---|---|
| Storage | **No schema change, no migration.** New keys live inside the existing `amb_operator_config.limits_json`: `automationRules` (global rules). Product policies gain one optional field `budget.maxChangesPerDay`. |
| Global rules | Versioned, draft ≠ active, ADMIN + confirm, refused if an active product policy would become incoherent. Never carries a mode and never enrols a product. |
| Inheritance | product value ← wins over → global value; campaign value wins over both. Every effective value is labelled CAMPAIGN / PRODUCT / GLOBAL(vN) / DEFAULT / UNSET (`GET /api/operator/product-rules/:id/effective`). |
| Stock | `STOCK_UNKNOWN` = warning (readiness check shown as not required); `OUT_OF_STOCK` still blocks; `stockPolicy: BLOCK` (per product or in the global rules) brings back the strict check. |
| Engine | Per-product `maxChangesPerDay` enforced in the automation tick (`PRODUCT_MAX_CHANGES_PER_DAY`). Nothing else in the execution path was loosened; every write still passes the central gate, caps, cooldown, manual-override protection and the independent read-back. |
| Bulk | `GET /automation/overview` (READY / NEEDS_CONFIGURATION / BLOCKED), `POST /automation/bulk/{preview,configure,activate}`. Bulk activation needs the EXACT numbers the preview computed, `confirmAutomatic`, an account daily exposure cap, each product's daily cap, an approved pause policy and READY products; it activates **policies only**. |
| UI | `js/opx-automation-console.js` (control panel inside «الأتمتة»), `js/opx-activation.js` (one-screen decision sheet). |
| Fix | Media-library sync warning «unexpected end of hex escape» (half-emoji text rejected by Prisma) reproduced by a test, then fixed (`wellFormed` / `safeSlice`). |

## Tests (local PostgreSQL + Neon test branch + Meta mock + real browser)
FULL regression after the last change: **65/65 suites, 3371 assertions, 0 failures** (Neon subset: 9 suites including the AUTOMATIC journey and the bulk activation; UI: opxUiTest 222, budgetUiTest 28).
New suites: `automaticJourneyTest` (23 — open → pause → increase → reduce → independent read-back → Execution History → Emergency Stop → release → multi-instance), `globalRulesTest` (25), `bulkActivationTest` (29), `activationSheetTest` (22), `mediaLibrarySanitizeTest` (5). The Meta mock is not proof of a real execution.

## Review checklist done
- Diff reviewed; secrets scan of added lines: no keys / tokens / URLs.
- DB compatibility: no migration; older code ignores the new JSON keys (closed-schema normaliser drops the unknown field when it re-saves a product draft).
- Production audit (read-only, with the new code against production data): 54 products → READY 0 · NEEDS_CONFIGURATION 45 · BLOCKED 9; 36 campaigns excluded (unconfirmed mapping / NO_AUTOMATION); running budgets 4200/day; production unchanged by the audit (18 actions before and after, config byte-identical).

## Rollback plan
1. **Immediate stop (no deploy):** Emergency Stop in the UI, or set `OPERATOR_ALLOW_META_WRITES=false` on Railway (motivated-adventure → Ads). Both are independent of this release.
2. **Disable the new behaviour without a deploy:** deactivate the global rules (`/automation/global-rules/deactivate`) — products fall back to their own values only; deactivate any product policy from «قواعد المنتجات».
3. **Code rollback:** `git revert` the two commits above (or redeploy `e45f223`) — Railway redeploys; no DB step is needed because there is no migration. The `automationRules` JSON key stays inert under the older code.
4. After a rollback re-verify read-only: `writesLocked`, the four permissions, mode, `amb_actions` count unchanged, Meta sync running.

## Not done / needs the owner
- Nothing is activated: no global rules saved, no product policy activated, no AUTOMATIC mode, no write opened.
- Values only the owner can decide are listed in the decision form (see the final message): account daily exposure cap, product caps, CPA scale / reduce, zero-order spend, % changes, budgets, schedule, changes per day, pause policy approval, mapping confirmations.

## Addendum (after the first deploy `a2992be`) — NOT deployed yet
- Pause policy: **per-product HIGH_CPA limit** (the product's own Hard Stop CPA wins over the global figure; with no global figure only products that have their own Hard Stop are covered) and **recent-improvement protection** (a high 3-day CPA does not pause when TODAY already recovered: ≥ N orders at a CPA inside the limit; zero-order and stock-out are never softened).
- Budget optimizer: the product's Hard Stop CPA is the start of its HIGH_CPA zone.
- UI: pause form has the recent-improvement toggle.
- Production draft prepared by the owner's request (inactive): global rules DRAFT only — schedule 00:00/13:00, increase/decrease 20%, cooldown 24h, manual-override 24h, unknown stock = WARN. No CPA, cap or budget figure. `economics-bulk-form.csv` = the one bulk form of saved economics (blank = unknown).
- Tests: clean FULL run 64/65 (the one failure was a UI assertion that relied on the old validation; fixed and re-run: opxUiTest 223, budgetUiTest 28). Neon 9/9.
