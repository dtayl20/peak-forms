# Security

Peak Forms stores form submissions — names, emails, phone numbers, sometimes addresses.
Treat every deployment as a system holding personal data.

## Trust boundaries

| Surface | Exposure | Protection |
|---|---|---|
| `/widget.js`, `/api/forms/<slug>` (published config) | public | read-only; only `status = published` forms are returned |
| `/api/forms/<slug>/submit` | **public** | Turnstile (optional), honeypot, per-IP rate limit, field validation, blocklist |
| `/manage*` (builder) | private | Cloudflare Access; admin API additionally requires `X-Admin-Key` |
| `/api/admin/*` | private | Access + `X-Admin-Key`, so a misconfigured route is not silently open |
| Webhooks (outbound) | n/a | fixed JSON contract, fired via `waitUntil`; never trusts incoming form data as a URL |

`X-Admin-Key` is a second layer, not the authentication layer. Access is. If the
Access application is mis-scoped, the key is all that stands between a stranger and
the submissions table — so scope the Access app to the whole hostname, not just
`/manage`.

## Submission handling

- Server-side validation is authoritative; client validation is convenience only.
- Consent wording and the acceptance timestamp are stored with each submission.
- File uploads go to R2 through the `UPLOADS` binding, not to the Worker's memory.
- Spam path: Turnstile verification when configured, a honeypot field that is dropped
  silently, and a per-IP counter in D1.

## Secrets

Set in the Cloudflare Pages project (Settings → Variables and Secrets), never in the repo:

| Secret | Purpose |
|---|---|
| `ADMIN_KEY` | admin API header |
| `TURNSTILE_SECRET` | spam protection |
| `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_VERIFY_SERVICE_SID` | SMS OTP |
| `META_CAPI_TOKEN`, `META_DATASET_ID`, `META_CRM_SECRET` | Conversions API forwarding |

`.dev.vars` and `.env*` are gitignored; `.env.example` documents names only.
`wrangler.toml` deliberately has no `[vars]` block: Pages git builds read that file,
so a placeholder var would ship to production.

## Known limits

- One deployment serves one operator; there is no tenant isolation between sites.
- Submissions are not encrypted at rest beyond D1's defaults.
- No user accounts, so no password reset or session management surface.

## Reporting

Please do not open a public issue. Use GitHub's private vulnerability reporting on
this repository (Security → Report a vulnerability).

This is a portfolio/demo project, not a hosted service, and there is no bug bounty.
