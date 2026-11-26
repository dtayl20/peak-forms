-- Peak Forms — seed data
-- Apply: wrangler d1 execute peak-forms-db --remote --file seed.sql

INSERT OR IGNORE INTO sites (id, name, slug) VALUES (1, 'Example Water Co', 'example-water');

-- delivery-deal: mirrors the live Gravity Form (f=2) field set on example.com/delivery-deal
-- Prefill params match the existing URL scheme (?fpc=4165&fsuburb=...&fstate=...&flat=...&flng=...)
INSERT OR IGNORE INTO forms (id, site_id, slug, title, status, config, created_at, updated_at)
VALUES (1, 1, 'delivery-deal', 'Delivery Deal Enquiry', 'published', '{
  "fields": [
    {"id":"f1","type":"text","name":"first_name","label":"First","required":true,"placeholder":"","help":"","options":[],"defaultValue":"","prefillParam":"","hidden":false,"width":"half"},
    {"id":"f2","type":"text","name":"last_name","label":"Last","required":true,"placeholder":"","help":"","options":[],"defaultValue":"","prefillParam":"","hidden":false,"width":"half"},
    {"id":"f3","type":"phone","name":"phone","label":"Phone","required":true,"placeholder":"","help":"We may call to confirm your details.","options":[],"defaultValue":"","prefillParam":"","hidden":false,"width":"half"},
    {"id":"f4","type":"email","name":"email","label":"Email","required":true,"placeholder":"","help":"","options":[],"defaultValue":"","prefillParam":"","hidden":false,"width":"half"},
    {"id":"f5","type":"text","name":"street","label":"Street Address","required":true,"placeholder":"","help":"","options":[],"defaultValue":"","prefillParam":"","hidden":false,"width":"full"},
    {"id":"f6","type":"text","name":"suburb","label":"Suburb","required":true,"placeholder":"","help":"","options":[],"defaultValue":"","prefillParam":"fsuburb","hidden":false,"width":"half"},
    {"id":"f7","type":"text","name":"state","label":"State","required":true,"placeholder":"","help":"","options":[],"defaultValue":"","prefillParam":"fstate","hidden":false,"width":"half"},
    {"id":"f8","type":"text","name":"postcode","label":"Post Code","required":true,"placeholder":"","help":"","options":[],"defaultValue":"","prefillParam":"fpc","hidden":false,"width":"half"},
    {"id":"f9","type":"text","name":"latitude","label":"Latitude","required":false,"placeholder":"","help":"","options":[],"defaultValue":"","prefillParam":"flat","hidden":true,"width":"full"},
    {"id":"f10","type":"text","name":"longitude","label":"Longitude","required":false,"placeholder":"","help":"","options":[],"defaultValue":"","prefillParam":"flng","hidden":true,"width":"full"},
    {"id":"f11","type":"select","name":"bottles_per_month","label":"About how many bottles will you need each month?","required":true,"placeholder":"Select...","help":"","options":[{"label":"1–4 bottles","value":"1-4"},{"label":"5–9 bottles","value":"5-9"},{"label":"10–19 bottles","value":"10-19"},{"label":"20+ bottles","value":"20+"}],"defaultValue":"","prefillParam":"","hidden":false,"width":"full"},
    {"id":"f12","type":"radio","name":"payment_method","label":"Preferred payment method","required":true,"placeholder":"","help":"","options":[{"label":"Credit/Debit Card","value":"card"},{"label":"Cash on Delivery","value":"cash"},{"label":"Direct Debit","value":"direct-debit"}],"defaultValue":"","prefillParam":"","hidden":false,"width":"full"},
    {"id":"f13","type":"radio","name":"start_preference","label":"When would you like to start?","required":true,"placeholder":"","help":"","options":[{"label":"Start ASAP","value":"asap"},{"label":"I want some quotes first","value":"quotes"}],"defaultValue":"","prefillParam":"","hidden":false,"width":"full"}
  ],
  "settings": {
    "submitLabel": "Request My Delivery Deal",
    "successMessage": "Thanks! We will be in touch shortly to confirm your delivery.",
    "redirectUrl": "",
    "dataLayerEvent": "deliveryDealSubmit",
    "turnstile": {"enabled": false, "siteKey": ""}
  },
  "notifications": []
}', datetime('now'), datetime('now'));
