// Conditional-logic evaluation shared by the widget's server-side twin and the
// submit endpoint. One implementation, so the browser and the server can never
// disagree about whether a field or page is active.

export const CONDITION_OPERATORS = [
  'is',
  'is_not',
  'contains',
  'not_contains',
  'starts_with',
  'ends_with',
  'greater_than',
  'less_than',
  'is_empty',
  'is_not_empty',
];

const OP_SET = new Set(CONDITION_OPERATORS);

function text(v) {
  return v === undefined || v === null ? '' : String(v);
}

function isEmptyValue(v) {
  if (Array.isArray(v)) return v.length === 0;
  return text(v).trim() === '';
}

function asArray(v) {
  return Array.isArray(v) ? v.map((x) => text(x).toLowerCase()) : null;
}

function ruleMatches(rule, data) {
  if (!rule || typeof rule !== 'object' || !rule.field) return false;
  const op = OP_SET.has(rule.operator) ? rule.operator : 'is';
  const raw = data ? data[rule.field] : undefined;
  const value = text(rule.value).trim();
  const lower = value.toLowerCase();

  if (op === 'is_empty') return isEmptyValue(raw);
  if (op === 'is_not_empty') return !isEmptyValue(raw);

  const arr = asArray(raw);

  if (arr) {
    // Multi-value fields (checkbox groups): match against the selected values.
    if (op === 'is' || op === 'contains') return arr.includes(lower);
    if (op === 'is_not' || op === 'not_contains') return !arr.includes(lower);
    const joined = arr.join(',');
    if (op === 'starts_with') return joined.startsWith(lower);
    if (op === 'ends_with') return joined.endsWith(lower);
    return false;
  }

  const v = text(raw).trim().toLowerCase();

  switch (op) {
    case 'is': return v === lower;
    case 'is_not': return v !== lower;
    case 'contains': return v.includes(lower);
    case 'not_contains': return !v.includes(lower);
    case 'starts_with': return v.startsWith(lower);
    case 'ends_with': return v.endsWith(lower);
    case 'greater_than': {
      const a = Number(v);
      const b = Number(lower);
      if (Number.isFinite(a) && Number.isFinite(b)) return a > b;
      return v > lower;
    }
    case 'less_than': {
      const a = Number(v);
      const b = Number(lower);
      if (Number.isFinite(a) && Number.isFinite(b)) return a < b;
      return v < lower;
    }
    default: return false;
  }
}

/**
 * Returns whether the field/page is VISIBLE.
 * No condition (or a disabled one) means visible. `action: 'hide'` inverts the
 * matched result; `action: 'show'` requires it.
 */
export function evaluateConditional(cond, data) {
  if (!cond || typeof cond !== 'object' || !cond.enabled) return true;
  const rules = Array.isArray(cond.rules) ? cond.rules : [];
  if (!rules.length) return true;
  const results = rules.map((r) => ruleMatches(r, data));
  const matched = cond.match === 'any' ? results.some(Boolean) : results.every(Boolean);
  return cond.action === 'hide' ? !matched : matched;
}

/** Field visibility including its page's conditional visibility. Hidden fields
 *  are global, so they are never removed by a page condition. */
export function fieldIsVisible(field, config, data) {
  if (!field) return false;
  if (!evaluateConditional(field.conditional, data)) return false;
  if (field.hidden) return true;

  const pages = config && Array.isArray(config.pages) ? config.pages : [];
  const pg = Number.isInteger(field.page) && field.page >= 0 ? field.page : 0;
  if (pg > 0 && pages[pg]) {
    return evaluateConditional(pages[pg].conditional, data);
  }
  return true;
}
