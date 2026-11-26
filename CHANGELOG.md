# Peak Forms — Change Log

Newest first.

## 2026-11-13 — Quiz scoring, result screens, score-aware webhook

- **Quiz scoring.** Optional per-option points, knockout bands, follow-up flag and
  payment-plan routing. The server computes points/percent/band from the published config;
  the widget mirrors it locally for an instant result. Enable in **Settings → Quiz scoring**;
  per-option controls live in the field inspector.
- **Result screen.** Gauge (default), traffic lights or none; optional score number;
  optional auto-redirect. A knockout forces the band and the gauge lights that band without
  a needle, with a note that the score is not decisive.
- **Submit webhook.** The contract gains `score_points`, `score_percent`, `score_band`,
  `followup` and `funding_route`. The admin **Send test payload** now includes the same keys,
  built from the form's real fields, so receivers can map them before live traffic.
- **Correction:** "Not ready for a call yet" no longer sets `followup = no_call`; timing
  answers now affect the score only. `no_call` is reserved for an explicit opt-out.
- **Plan copy.** A payment-plan choice no longer overrides the headline when the band is
  `not_eligible`; the band's own copy wins and only the CTA points at the plan page.

## 2026-11-01 — Site folders + anonymous funnel analytics

- **Forms are grouped by site.** The Forms list renders one collapsible folder per site,
  with a site filter and per-site subtotal (forms, submissions 30d, views 30d). Sites are
  unchanged in the data model — this is a console view over the existing `site_id`.
- **Funnel telemetry from the widget.** Additive migration `migrations/0006_form_events.sql`
  adds `form_events` (form, anonymous session id, event, step, page_url, referrer, utm, ip, ua).
  The widget beacons `view`, `start`, `page`, `submit` and `abandon` (sendBeacon on `pagehide`)
  to the new public `POST /api/forms/<slug>/event`; the endpoint whitelists events, caps
  per-IP writes at 240/min and answers 2xx even when storage is unavailable.
- **Per-form Analytics tab.** Distinct-session funnel (views → started → submitted), overall
  completion %, and a per-step table showing where sessions drop off, for 7/30/90 days.
  Forms list adds Views (30d) and conversion.
- **Sessions, not people.** The id lives in `sessionStorage`, is never joined to a submission,
  and no field values are sent. Existing embeds are version-pinned: re-copy the snippet from
  the Embed tab for events to appear.

## 2026-10-08 — Consent capture + outbound submit webhook

- **Consent notice on every form.** The widget renders a notice beneath the submit button
  (default: "By submitting your details you consent to being contacted."). It is a notice,
  not a checkbox — submitting constitutes acceptance. Wording resolves
  **per-form override -> global default -> built-in fallback**, so no form ever ends up
  without one. The widget is told the exact resolved text by the public config endpoint.
- **Consent recorded with the submission.** Additive migration
  `migrations/0001_consent_and_webhook.sql` adds `consent_text` + `consent_at` to
  `submissions` (existing rows untouched) and a `app_settings` key/value table. The submit
  endpoint stores the exact wording shown and the ISO acceptance time.
- **Outbound submit webhook.** Per-form (`settings.submitWebhook`) or global default
  (`app_settings`): on a successful submission the API POSTs the fixed contract JSON
  (`form_slug, submission_id, email, first_name, last_name, phone, consent{accepted,text,at}, fields`)
  from `waitUntil` with an 8s timeout and swallowed errors — it can never fail, slow down or
  change the visitor's submission/redirect. Delivery outcome is written back to the row
  (`webhook_status`, `webhook_at`). Honeypot-dropped submissions return ok but store nowhere
  and never fire the webhook. Token is sent as `Authorization: Bearer <token>` and
  `X-Webhook-Token` (the fixed body carries no token).
- **Admin console.** New global **Settings** tab (`/api/admin/settings`) edits the default
  consent wording and the default submit webhook, with a test-payload button
  (`/api/admin/webhook-test`). Per-form override + test live in the form editor's Settings tab.
  The private webhook URL/token are stripped from the public config response.

## 2026-09-04 — Multi-page forms ("add pages to long forms")

- Config can now carry `pages: [{id, title, description}]`; each field has a
  0-based `page` index. More than one page = step-by-step form; omitted/empty
  pages = the original single long form (fully backward compatible — the
  seeded delivery-deal form renders exactly as before).
- Builder (`/manage/`): page tabs above the canvas — add / delete pages,
  fields drag onto the active page, a Page picker in the field inspector moves
  fields between pages, page title/description edit when nothing is selected,
  preview shows all steps stacked with step markers. Deleting a page migrates
  its fields to the previous page.
- Widget: one page at a time with Step x of y indicator, Next / Back (values
  persist across pages — all pages stay in the DOM), per-page validation before
  advancing, Turnstile renders lazily when the final page is shown, and a 422
  from the server jumps the visitor to the page with the error. Hidden fields
  render once globally and ride along with every submission.
- Server: `sanitizePages()` + page clamping in `sanitizeConfig()` (stray/out-of-
  range page indexes can't orphan fields); public GET serves `pages`;
  `type: hidden` now forces `hidden: true` on sanitize.

### Bugs found by the new browser E2E (pre-existing, would have broken live use)
- **Widget controls had no `name` attribute** — visible inputs/selects/textareas
  never set `.name`, so `collect()` returned empty data and the form could not
  actually submit in a real browser (API-level tests POST JSON directly and
  never caught it). Fixed in buildField.
- **Cross-origin POSTs failed CORS preflight** — public endpoints only exported
  GET/POST handlers; Pages Functions routes OPTIONS to `onRequestOptions`, which
  didn't exist, so any embedded widget submitting from a host page was blocked.
  Added `optionsHandler()` export to both public routes.

### Tests (local wrangler pages dev)
- `tmp/pages_api_test.py` — 24 checks: sanitize round-trip, page clamping,
  public GET shape, 422 partial-submit, full submit, honeypot, preflight CORS.
- `tmp/pages_widget_e2e.py` (Playwright, cross-origin harness on :8787) —
  26 checks: page visibility, step indicator, per-page required/radio gates,
  Back + value persistence, final submit success, legacy single-page form
  unchanged, zero page JS errors.

## 2026-09-03 — Field settings: prefill for all field types + default values

- "Prefill from URL param" now shows for every field type. Select/radio preselect
  the matching option (?payment=card); checkboxes accept comma-separated values
  (?tags=a,b). Hidden/text/email/phone/etc. as before.
- New "Default value" setting (text-ish + hidden fields) as a fallback when no
  URL param matches.

## 2026-09-03 — Fix: save wiped all fields (sanitizeConfig shape bug)

- Admin endpoints pass the fields *array* to `sanitizeConfig()`, but it only
  accepted a config object with `.fields` — so every save stripped all fields
  (empty canvas, no preview). Now accepts both shapes. Reproduced locally with
  a round-trip repro script before fixing.

## 2026-09-03 — Fix: entity slug generation used underscores (invalid)

- Client `slugify()` (used for auto-generating form + site slugs in the builder UI)
  was producing underscores (`gold_coast_spring_water`), but the server slug rule only
  allows lowercase letters, numbers and dashes — so creating a form from a multi-word
  title failed validation. Fixed to generate dashes (`gold-coast-spring-water`).
  Field *names* (data keys) still use underscores by design.

## 2026-09-03 — Initial build (commit ea9bfb7)
