# OmniCore AI deployment-readiness audit

Audit date: 2026-11-07  
Scope: `workers/` Cloudflare Worker adaptation on `cloudflare-adaptation`.

## Overall decision

**NOT READY FOR DEPLOYMENT.** The Worker is a development gateway scaffold with automated tests. It is not production-certified. Keep deployment disabled until all blocking gates below are closed and a separate deployment approval is recorded.

## Readiness matrix

| Gate | Status | Evidence / remaining work |
|---|---|---|
| Upstream preservation | PASS | Original `release/v3.8.54` branch is not the development target. All current engineering changes are on `cloudflare-adaptation`. |
| Source validation | PASS WITH PENDING LATEST CI | Node unit tests, Wrangler dry-run and migration validation have passed on prior commits; rerun against the final candidate commit. |
| API-key lifecycle | IMPLEMENTED | Managed keys default to 90 days, support 1–365 days, store only hashes, and support batch rotation/revocation. Legacy keys receive a 90-day backfill. |
| Provider reliability | PARTIAL | Ordered fallback, bounded retry, D1 circuit state and admin diagnostics exist. Live provider tests and single-flight half-open probes remain outstanding. |
| D1 integration | PENDING | Miniflare/Workers Vitest integration suite is being added. Remote D1 validation has not been performed. |
| Database resource | BLOCKED | `wrangler.toml` still has an all-zero placeholder database ID. No D1 resource has been provisioned. |
| Secrets | BLOCKED | No admin/provider secrets have been provisioned. Bootstrap `OMNICORE_API_KEY` must be removed after managed-key verification. |
| Provider economics and terms | BLOCKED | Confirm current model/provider pricing, free quotas, regional availability, and terms before live calls. |
| Security review | PARTIAL | See `SECURITY_REVIEW.md`. Independent penetration testing, remote outage tests, streaming interruption tests and retention policy remain. |
| Operations | BLOCKED | No remote backup/restore rehearsal, alerting, incident runbook, log/usage retention policy or scheduled-cleanup verification. |
| Domain and CORS | NOT CONFIGURED | Exact CORS origins are unset by default. Confirm final public origin and access model before enabling. |
| Legal / notices | REVIEW REQUIRED | Preserve MIT LICENSE and THIRD_PARTY_NOTICES; complete dependency/native-component notice review before redistribution. |

## Required pre-deployment sequence

1. Close all unit, migration/backfill, local D1 integration and Wrangler dry-run checks on one pinned candidate commit.
2. Review the security residuals and agree on retention, rate/budget limits, admin-secret rotation and bootstrap-key removal.
3. Separately approve a dedicated staging D1 resource; verify its plan, location, quotas and cost before creation.
4. Apply migrations to staging, verify migration history, backups, restore and rollback procedures.
5. Configure high-entropy Worker secrets through the Cloudflare dashboard/approved secret workflow. Never commit them.
6. Validate each provider's credentials, model mapping, quotas, rate limits, Retry-After, fallback and streaming behavior in staging.
7. Exercise authentication, key expiry/rotation/revocation, concurrent rate limits, D1 outage behavior, circuit state and Cron cleanup.
8. Complete independent security review and confirm privacy/retention/logging policy.
9. Review the final diff against upstream notices and confirm only the intended Worker adaptation is in the release candidate.
10. Obtain separate explicit approval before production resource creation, secret activation, billing-impacting actions or deployment.

## Explicitly not done

- No Cloudflare D1 database or other remote resource has been created.
- No Worker secrets/provider credentials have been written.
- No billing, paid service, custom domain, DNS, production route or deployment has been activated.
- No production data or customer traffic has been used.
- No changes have been made to the upstream release branch.

## Supporting records

- [D1 integration testing strategy](D1_INTEGRATION_TEST_PLAN.md)
- [Security review](SECURITY_REVIEW.md)
- [Project README](README.md)
