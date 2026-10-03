# Security Review

Review date: 2026-10-03. Scope: the SR crafting calculator working tree, its recipe scraper and updater workflow, dependency advisories, repository history secrets, and public response headers. No changes were pushed or deployed.

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