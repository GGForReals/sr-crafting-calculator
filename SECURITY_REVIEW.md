# Security Review

Review date: 2026-10-03. Scope: the SR crafting calculator working tree, its recipe scraper and updater workflow, dependency advisories, repository history secrets, and public response headers. No changes were pushed or deployed.

## Release Refresh: 2026-10-11

- Reviewed the pending graph, pooled-feed expansion, cost guard, URL/data handling, SVG escaping, and workflow changes. No new concrete injection vulnerability was identified. This is a scoped review, not proof that every input or availability edge case is safe; the work-budget heuristic is not a guaranteed browser resource bound.
- `npm audit --json`: zero known advisories across runtime and development dependencies. External scripts and browser binaries are not covered by this audit.
- Gitleaks v8.30.1: no detected secrets across all 476 local commits or the current worktree, including untracked files. Reports used redaction and the directory scan used a 2 MB per-file limit. Pattern-based detection and local history coverage have limits.
- `npm test`: 23/23 tests passed, including hostile-input browser tests and graph regressions. `node scripts/validate-recipes.mjs` validated 96 recipes, including alternate recipes and dependency cycles. `git diff --check` was clean.
- Production HTTP HEAD followed a redirect to HTTPS and returned 200. HTTPS HEAD still lacked HSTS, CSP, X-Frame-Options, X-Content-Type-Options, Referrer-Policy, and Permissions-Policy.
- Nuclei v3.11.1 with official templates v10.5.0 ran only three reviewed signed templates: `http-missing-security-headers`, `robots-txt`, and `security-txt`. Target: `https://starrupturecraftingcalculator.com`; concurrency 1, rate limit 2 requests/second, external callbacks disabled, no fuzzing/code/headless templates or third-party targets. The completed scan reported 10 informational missing-header matches; the two public-file templates produced no matches. This was not a broad CVE or exploit scan. Not every reported header is necessarily appropriate for this site; cross-origin isolation policies need compatibility review.
- Separate public GET checks of `/.git/config`, `/.git/HEAD`, and `/.env` each returned 404. Response bodies and potential secrets were not printed.
- Scanner archives were downloaded from pinned official GitHub releases to a temporary folder and matched the published SHA-256 checksum files. This checks download integrity against the release source, not an independent assessment of scanner safety. Redacted Gitleaks reports and the Nuclei JSONL report are outside the repository in the temporary `srcc-security-refresh-20261011` folder.
- actionlint was not available on PATH and was not rerun in this refresh; the earlier result remains historical. The recipe workflow's successful publish path, branch protections, and GitHub Pages configuration were not verified in this pass. No code was committed, pushed, or deployed. Production checks assess the currently deployed site, not the pending local graph changes.

Remaining follow-up: plan a compatible response-header policy on the hosting layer, verify the recipe workflow and publishing configuration, and smoke-test the deployed release after publication. The previously accepted Ko-fi script trust remains unchanged. No new demonstrated release-blocking exploit was found in these checks, but the missing defense-in-depth headers remain an open hardening gap.

### Release Preparation Follow-Up: 2026-10-11

- Authenticated read-only GitHub CLI queries verified Pages publishes `main` from `/`, with custom domain `starrupturecraftingcalculator.com`, HTTPS enforcement enabled, and status `built`. The latest published commit was `92d4db061c488c943b58ad132bb8fcb0230963df`; local HEAD and remote `main` both matched it before the pending release commit.
- Recipe workflow run [38052287389](https://github.com/GGForReals/sr-crafting-calculator/actions/runs/38052287389), created 2026-10-10, completed successfully. Both scrape and publish jobs succeeded, including artifact upload/download, revalidation, and the conditional commit/push step. Job success alone does not prove new recipe data was pushed; the step may take the no-change path. No workflow was triggered during release preparation.
- Live local Playwright smoke checks passed at 390 x 844 and 320 x 740, plus a Pixel 5 touch context: mode switching, selection and input/route highlights, tap-to-clear, pinch zoom, pan without accidental selection, Reset view, label visibility, and expensive-plan fallback. No page errors occurred in the touch check. Subsequent mobile polish made graph buttons at least 44 px tall and widened the fallback notice to 265 px at a 320 px viewport, with no horizontal overflow; automated regression coverage was added.
- Final full validation after mobile polish: `npm test` passed 23/23; dataset validation passed 96 recipes. The release inventory contains eight modified tracked files and three new files: `RAIL_PLANNING.md`, `lib/railPlanning.js`, and `rail-planning.test.mjs`. All three new files must accompany the app changes. Differing per-asset cache-version suffixes are not by themselves a cache defect; a changed asset needs its own URL version updated.
- Commit, push, and production deployment remain deferred by the site owner. After publishing, verify the Pages build for the new commit and smoke-test the production assets and representative Simple/Complex plans. Branch-protection settings and a compatible security-header policy remain outside these completed checks.

## Checks and Results

- Manual code review of HTML/SVG output encoding, shared URL parameters, recipe ingestion, graph handlers, clipboard use, remote scripts, scraper navigation, and workflow credentials.
- `npm audit --json`: zero known dependency advisories. This does not certify browser binaries or externally hosted scripts.
- Gitleaks v8.30.1: no detected secrets in 473 commits or the scanned working tree. Detection is pattern-based and cannot guarantee absence of secrets.
- actionlint v1.7.12: updater workflow passed. ShellCheck and Pyflakes were unavailable and disabled; the workflow has not yet executed on GitHub after these changes.
- `npm test`: 11 passing tests, including browser attack-input checks and recipe validation. Tests cover representative attacks, not exhaustive penetration testing.
- `node scripts/validate-recipes.mjs`: all 96 existing recipes passed.
- Ordinary HTTP GET and HEAD returned HTTP 200 without HTTPS redirection. HTTPS HEAD returned 200 with none of HSTS, CSP, X-Frame-Options, X-Content-Type-Options, Referrer-Policy, or Permissions-Policy.

## Local Hardening

- Shared validation runs before imported recipes are used, before scraper writes, and before workflow publishing. It checks base/alternate recipe fields, finite positive bounded quantities, names, dataset/input limits, and dependency cycles.
- Prototype-sensitive names are rejected, recipe lookup requires own properties, and scraper extraction maps use null prototypes. No visitor-triggered global prototype pollution exploit was demonstrated.
- Calculator rates must be finite, positive, and at most 1,000,000,000 units/minute. Unsupported shared rail values retain the existing supported default.
- Browser security tests verify malicious HTML/SVG recipe strings stay text, reserved names do not become recipes, malformed data fails closed, and bad rates do not generate graphs.
- Scraper item paths are constrained to the expected HTTPS origin and item path.
- The updater uses immutable Action SHAs verified against upstream tags, Node 24, non-persisted checkout credentials, concurrency control, and a read-only scrape job. A separate publish job receives only the generated artifact, revalidates it, and exposes the write token only to the commit/push step.

## Unresolved Before Release

### HTTPS Enforcement (Verified)

Follow-up on 2026-10-03: the site owner enabled **Enforce HTTPS** in GitHub Pages. An ordinary HTTP GET now redirects to `https://starrupturecraftingcalculator.com/` and returns 200 over HTTPS. The earlier HTTP 200 result above records the pre-fix state. HTTPS enforcement is no longer an unresolved release blocker. HSTS and other response headers still require a hosting layer that supports them; HTML cannot set HSTS, nosniff, or frame-ancestors.

### Third-Party Script Trust (Accepted)

The Ko-fi overlay is a remotely hosted executable script without integrity pinning. It has the same page access as the calculator's own scripts and loads additional resources. It is not covered by npm audit. No compromise was observed, but this trust boundary remains.

Decision on 2026-10-03: the site owner trusts Ko-fi and accepts this third-party script risk. Keep the existing widget; this is not an unresolved release blocker. Acceptance does not eliminate the risk or cover unrelated providers. Revisit if the provider, integration, or evidence of compromise changes.

### Production Browser Policy

There is currently no deployed CSP or other checked browser security headers. Design and test a policy on the chosen host, preferably in report-only mode first. The existing inline widget setup, injected styles/SVG, and Ko-fi resources need compatibility testing; a blanket policy could break the application. Do not claim a strict policy while broadly allowing arbitrary scripts.

### Operational Follow-Up

- Test-branch run `37143707761` passed installation and regression/security tests, but the upstream Search API returned HTTP 403 before scraping. Publishing was skipped. A full local scrape succeeded with 96 recipes and no dataset changes. Startup API failures now keep only a schema-validated previous dataset of at least 50 recipes, with an explicit warning and summary that no fresh data was generated. This preserves availability; it does not resolve upstream access restrictions or verify the publisher job.
- Run the updated Actions workflow manually after review and verify artifact publishing and the no-change path; local actionlint does not replace a real runner execution.
- Protect the default branch, require reviewed changes/checks where practical, restrict Actions permissions, enable dependency/security alerts and secret scanning where available, and use MFA for repository/domain accounts.
- The live scraper was not rerun during this review. Validation cannot detect plausible but factually incorrect upstream recipe data.
- Automated recipe publishing still trusts the upstream source for data accuracy and the pinned Actions/Node/Playwright toolchain. No system can promise immunity from malicious actors.

## Reproduce Local Checks

```sh
npm ci
npx playwright install chromium
npm audit
npm test
node scripts/validate-recipes.mjs
actionlint -shellcheck= -pyflakes= .github/workflows/update-recipes.yml
gitleaks git . --redact --log-opts=--all
gitleaks dir . --redact --max-target-megabytes=2
```