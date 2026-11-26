# Setup

Peak Forms is a drag-and-drop form builder plus an embeddable widget that runs
in the host page's DOM (not an iframe), so analytics and pixels actually see
submissions.

Stack: React + Vite builder, ~15 KB vanilla widget, Cloudflare Pages Functions,
D1 for storage, R2 for file uploads, Turnstile for spam.

---

## Prerequisites

- Node.js 20+ and npm
- A Cloudflare account with Pages + D1 (free plan is enough)
- Optional: Turnstile keys, Twilio Verify (for SMS OTP), Meta Conversions API

---

## 1. Clone and install

```bash
git clone https://github.com/dtayl20/peak-forms.git
cd peak-forms
npm install            # installs the root workspace and app/
```

---

## 2. Local database

`wrangler` simulates D1 locally — no Cloudflare account needed yet.

```bash
npm run db:init:local     # applies schema.sql
npm run db:seed:local     # optional demo site + form
```

Both scripts target the `peak-forms-db` binding declared in `wrangler.toml`.

---

## 3. Secrets for local dev

```bash
cp .env.example .dev.vars     # local Pages Functions
cp .env.example .env.local    # Vite console (VITE_* only)
```

Minimum to boot:

| Var | Purpose | Dev value |
|---|---|---|
| `ADMIN_KEY` | second-layer admin header (`X-Admin-Key`) | any string |
| `TURNSTILE_SECRET` | spam protection | leave empty to disable |
| `TWILIO_*` | SMS OTP for one-time forms | leave empty unless testing OTP |
| `META_*` | Conversions API forwarding | leave empty |

Admin access is Cloudflare Access **plus** the `ADMIN_KEY` header. Access is the
real gate; the key is a deterrent against a misconfigured route.

---

## 4. Run it

Two processes:

```bash
# terminal 1 — builder (Vite serves at the root in dev)
npm run dev:app          # http://localhost:5173

# terminal 2 — Pages Functions + local D1
npm run build            # the Functions serve from dist/
npm run dev:api          # http://localhost:8788
```

Open <http://localhost:5173>. The SPA calls `/api/*`, which Vite proxies to
`localhost:8788` (see `app/vite.config.js`). Change the proxy target there if
you move the API port. In a production build the same app is served under
`/manage/`.

---

## 5. How a form gets embedded

```html
<div id="peak-form"></div>
<script src="https://your-domain/widget.js" data-form="your-form-slug" async></script>
```

`widget.js` fetches the published config, renders into a Shadow DOM root,
prefills from URL parameters, and POSTs to `/api/forms/<slug>/submit`.
No iframe means no height hacks and no analytics blind spot.

Widget builds are stamped against the git SHA, so a stale embed is detectable
rather than silently cached.

---

## 6. Deploy

```bash
npx wrangler login
npx wrangler d1 create peak-forms-db     # paste the id into wrangler.toml
npx wrangler r2 bucket create form-uploads
npm run db:init                          # remote schema
npm run build
npx wrangler pages deploy dist --project-name peak-forms
```

Then set the production secrets on the Pages project
(Settings → Variables and Secrets): `ADMIN_KEY`, `TURNSTILE_SECRET`, and any
Twilio/Meta values you use. Put a Cloudflare Access application in front of
`/manage*` and `/api/admin/*`.

> `wrangler.toml` deliberately has no `[vars]` block: Pages git builds read
> this file, so a placeholder var would ship to production.

---

## 7. Verify

```bash
curl -s http://localhost:8788/api/forms/<slug>        # public config, 200
curl -s -X POST http://localhost:8788/api/forms/<slug>/submit \
  -H 'content-type: application/json' \
  -d '{"fields":{}}'                                   # validation error, not 500
```

Submit the form in a browser and confirm the row appears in
`/manage/ → Submissions`.

---

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| `/manage` 404 on Pages | SPA fallback not configured | ensure `_routes.json` / Pages SPA setting points at `dist` |
| Admin API 401 | missing `X-Admin-Key` or Access JWT | send the header; check the Access app covers the route |
| Submissions silently dropped | Turnstile secret set but widget absent | either render Turnstile or unset the secret |
| Webhook never fires | endpoint rejects the payload | webhooks are fire-and-forget via `waitUntil`; check the receiver's logs and the documented JSON contract |
| Uploads fail | R2 binding missing | bind `UPLOADS` to an R2 bucket |

---

## Layout

```
app/            builder SPA (Vite, base /manage/)
functions/      Pages Functions — public + admin APIs
  api/forms/    public config + submit
  api/admin/    CRUD behind Access
  _lib/         db, validation, scoring, settings, otp, files
schema.sql      D1 schema
seed.sql        demo data
```
