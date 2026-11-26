// Field type catalogue for the builder palette + default field factory.

export const FIELD_TYPES = [
  { type: 'text', label: 'Text', hint: 'Single line' },
  { type: 'email', label: 'Email', hint: 'Validated email' },
  { type: 'phone', label: 'Phone', hint: 'AU/international' },
  { type: 'textarea', label: 'Text Area', hint: 'Multi line' },
  { type: 'number', label: 'Number', hint: 'Numeric input' },
  { type: 'select', label: 'Dropdown', hint: 'Pick one' },
  { type: 'radio', label: 'Radio Buttons', hint: 'Pick one' },
  { type: 'checkbox', label: 'Checkboxes', hint: 'Pick many' },
  { type: 'date', label: 'Date', hint: 'Date picker' },
  { type: 'file', label: 'File Upload', hint: 'Secure upload' },
  { type: 'hidden', label: 'Hidden Field', hint: 'Prefill or tracking' },
];

const DEFAULT_OPTIONS = [
  { label: 'Option 1', value: 'option_1' },
  { label: 'Option 2', value: 'option_2' },
];

const TYPE_META = {
  text: { label: 'Text Field', name: 'text_field' },
  email: { label: 'Email', name: 'email' },
  phone: { label: 'Phone', name: 'phone' },
  textarea: { label: 'Message', name: 'message' },
  number: { label: 'Number', name: 'number' },
  select: { label: 'Select', name: 'select' },
  radio: { label: 'Radio Buttons', name: 'radio' },
  checkbox: { label: 'Checkboxes', name: 'checkbox' },
  date: { label: 'Date', name: 'date' },
  file: { label: 'File Upload', name: 'file_upload' },
  hidden: { label: 'Hidden Field', name: 'hidden_field' },
};

export function uniqueName(base, existingNames) {
  let name = slugForName(base);
  if (!name) name = 'field';
  let candidate = name;
  let i = 2;
  while (existingNames.has(candidate)) {
    candidate = `${name}_${i}`;
    i += 1;
  }
  return candidate;
}

export function slugForName(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    // Strip leading separators only. Trimming the trailing one on every
    // keystroke made it impossible to type "first_name": the "_" vanished
    // before the next letter could be typed.
    .replace(/^_+/, '')
    .replace(/^([0-9])/, 'field_$1')
    .slice(0, 50);
}

// Option values are data, not identifiers: no "field_" prefix and a leading
// digit is fine (e.g. "18-24" → "18_24"). Field names still use slugForName.
export function slugForValue(s) {
  return String(s || '')
    .toLowerCase()
    // Option values are data, so keep hyphens and only normalise whitespace /
    // punctuation runs. Same rule as keys: do not trim the trailing separator
    // while the user is still typing.
    .replace(/[^a-z0-9-]+/g, '_')
    .replace(/^_+/, '')
    .slice(0, 50);
}

export function uniqueSlugValue(base, existingValues) {
  let v = slugForValue(base) || 'option';
  let candidate = v;
  let i = 2;
  while (existingValues.has(candidate)) {
    candidate = `${v}_${i}`;
    i += 1;
  }
  return candidate;
}

export function nextFieldId(fields) {
  let max = 0;
  for (const f of fields) {
    const n = parseInt(String(f.id || '').replace(/\D/g, ''), 10);
    if (Number.isFinite(n) && n > max) max = n;
  }
  return `f${max + 1}`;
}

export function nextPageId(pages) {
  let max = 0;
  for (const p of pages) {
    const n = parseInt(String(p.id || '').replace(/\D/g, ''), 10);
    if (Number.isFinite(n) && n > max) max = n;
  }
  return `p${max + 1}`;
}

export function makeField(type, id, existingNames = new Set()) {
  const meta = TYPE_META[type] || TYPE_META.text;
  const base = {
    id,
    type,
    name: uniqueName(meta.name, existingNames),
    label: meta.label,
    required: false,
    // '' = editable, 'prefill' = lock only when a URL prefill/default exists,
    // 'always' = always read-only.
    readonly: '',
    description: '',
    placeholder: '',
    help: '',
    options: [],
    defaultValue: '',
    prefillParam: '',
    hidden: false,
    width: 'full',
    accept: 'all',
    maxSizeMb: 10,
    otp: false,
    conditional: { enabled: false, action: 'show', match: 'all', rules: [] },
  };
  if (type === 'select') base.placeholder = 'Select...';
  if (['select', 'radio', 'checkbox'].includes(type)) {
    base.options = DEFAULT_OPTIONS.map((o) => ({ ...o }));
  }
  if (type === 'hidden') base.hidden = true;
  return base;
}
