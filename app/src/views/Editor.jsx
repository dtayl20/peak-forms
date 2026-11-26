import React, { useEffect, useMemo, useState } from 'react';
import {
  DndContext,
  DragOverlay,
  PointerSensor,
  closestCenter,
  pointerWithin,
  useSensor,
  useSensors,
  useDraggable,
  useDroppable,
} from '@dnd-kit/core';
import { SortableContext, useSortable, verticalListSortingStrategy, horizontalListSortingStrategy, arrayMove } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { api, fmtDate, fmtValue } from '../api.js';
import Analytics from './Analytics.jsx';
import { FIELD_TYPES, makeField, nextFieldId, nextPageId, slugForName, slugForValue, uniqueSlugValue } from '../fields.js';

const CANVAS_ID = 'ff-canvas';
const PAGE_DROP_PREFIX = 'ff-page-';

// Page tabs are small, so give them priority when the pointer is actually over
// one; otherwise use the normal closest-center behaviour for reordering.
function collisionDetection(args) {
  const hits = pointerWithin(args);
  const tabHits = hits.filter((h) => String(h.id).startsWith(PAGE_DROP_PREFIX));
  return tabHits.length ? tabHits : closestCenter(args);
}
// Canonical API/embed host. The embed snippet uses this absolute URL (not the console's
// own origin) plus optimiser opt-outs, so a bundling/inlining optimiser on the host
// page cannot make the widget fetch from the wrong origin.
const FF_EMBED_ORIGIN =
  (typeof window !== 'undefined' && window.location.origin) || 'https://forms.example.com';
// Injected by vite.config.js at build time — keeps the embed URL pinned to the
// deployed widget build so a cached old widget.js cannot pair with a new API.
const FF_VERSION = typeof __FF_VERSION__ !== 'undefined' ? __FF_VERSION__ : 'dev';
const DEFAULT_SETTINGS = {
  submitLabel: 'Submit',
  successMessage: 'Thanks! We will be in touch.',
  redirectUrl: '',
  redirectNewTab: false,
  dataLayerEvent: '',
  consentText: '',
  submitWebhook: { url: '', token: '' },
  turnstile: { enabled: false, siteKey: '' },
  theme: { primary: '#0f766e' },
  utm: { source: '', medium: '', campaign: '', term: '', content: '' },
  scoring: {
    enabled: false,
    display: 'gauge',
    showScore: true,
    redirectDelayMs: 1500,
    bands: [
      { key: 'low', label: 'Not ready yet', min: 0, color: '#dc2626', headline: '', recommendation: '', redirectUrl: '', ctaLabel: '', ctaUrl: '' },
      { key: 'medium', label: 'Getting there', min: 40, color: '#f59e0b', headline: '', recommendation: '', redirectUrl: '', ctaLabel: '', ctaUrl: '' },
      { key: 'high', label: 'Ready to go', min: 70, color: '#16a34a', headline: '', recommendation: '', redirectUrl: '', ctaLabel: '', ctaUrl: '' },
    ],
  },
};

function mergeSettings(s) {
  return {
    ...DEFAULT_SETTINGS,
    ...(s || {}),
    turnstile: { ...DEFAULT_SETTINGS.turnstile, ...((s && s.turnstile) || {}) },
    theme: { ...DEFAULT_SETTINGS.theme, ...((s && s.theme) || {}) },
    utm: { ...DEFAULT_SETTINGS.utm, ...((s && s.utm) || {}) },
    submitWebhook: { ...DEFAULT_SETTINGS.submitWebhook, ...((s && s.submitWebhook) || {}) },
    scoring: {
      ...DEFAULT_SETTINGS.scoring,
      ...((s && s.scoring) || {}),
      bands: ((s && s.scoring && Array.isArray(s.scoring.bands) && s.scoring.bands.length)
        ? s.scoring.bands
        : DEFAULT_SETTINGS.scoring.bands).map((b) => ({ ...b })),
    },
  };
}

/* ---------- conditional logic ---------- */
const CONDITION_OPERATORS = [
  { value: 'is', label: 'is' },
  { value: 'is_not', label: 'is not' },
  { value: 'contains', label: 'contains' },
  { value: 'not_contains', label: 'does not contain' },
  { value: 'starts_with', label: 'starts with' },
  { value: 'ends_with', label: 'ends with' },
  { value: 'greater_than', label: 'greater than' },
  { value: 'less_than', label: 'less than' },
  { value: 'is_empty', label: 'is empty' },
  { value: 'is_not_empty', label: 'is not empty' },
];
const NO_VALUE_OPERATORS = new Set(['is_empty', 'is_not_empty']);

function emptyConditional() {
  return { enabled: false, action: 'show', match: 'all', rules: [] };
}

function normalizeConditional(c) {
  return {
    enabled: !!(c && c.enabled),
    action: c && c.action === 'hide' ? 'hide' : 'show',
    match: c && c.match === 'any' ? 'any' : 'all',
    rules: c && Array.isArray(c.rules) ? c.rules : [],
  };
}

/**
 * Build the editor's nested page state from stored flat config.
 * meta [] (legacy single-page forms) → one page holding every field.
 */
function buildPages(fieldsArr, metaArr) {
  const meta = Array.isArray(metaArr) ? metaArr : [];
  const pages = meta.length
    ? meta.map((m) => ({
      id: m.id,
      title: m.title || '',
      description: m.description || '',
      conditional: normalizeConditional(m.conditional),
      fields: [],
    }))
    : [{ id: 'p1', title: '', description: '', conditional: emptyConditional(), fields: [] }];
  (Array.isArray(fieldsArr) ? fieldsArr : []).forEach((f) => {
    let pg = parseInt(f.page, 10);
    if (!Number.isFinite(pg) || pg < 0) pg = 0;
    if (pg >= pages.length) pg = pages.length - 1;
    pages[pg].fields.push(f);
  });
  return pages;
}

/** Flat fields for the API: one array, each field tagged with its page index. */
function flattenFields(pages) {
  const out = [];
  pages.forEach((p, i) => p.fields.forEach((f) => out.push({ ...f, page: i })));
  return out;
}

function pagesMeta(pages) {
  return pages.map(({ id, title, description, conditional }) => ({ id, title, description, conditional: normalizeConditional(conditional) }));
}

function findField(pages, id) {
  for (let i = 0; i < pages.length; i += 1) {
    const f = pages[i].fields.find((x) => x.id === id);
    if (f) return { pageIdx: i, field: f };
  }
  return { pageIdx: -1, field: null };
}

/* ---------- palette chip ---------- */
function PaletteChip({ type, label, hint }) {
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({
    id: `palette:${type}`,
    data: { paletteType: type },
  });
  return (
    <button
      ref={setNodeRef}
      {...listeners}
      {...attributes}
      className={`w-full text-left px-3 py-2 rounded-lg border text-sm cursor-grab active:cursor-grabbing transition ${
        isDragging ? 'opacity-40 border-teal-500 bg-teal-50' : 'border-slate-200 bg-white hover:border-teal-400 hover:shadow-sm'
      }`}
    >
      <div className="font-medium">{label}</div>
      <div className="text-[11px] text-slate-400">{hint}</div>
    </button>
  );
}

/* ---------- canvas row ---------- */
function SortableRow({ field, selected, onSelect, onRemove }) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: field.id });
  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
  };
  return (
    <div
      ref={setNodeRef}
      style={style}
      onClick={() => onSelect(field.id)}
      className={`group flex items-center gap-2 rounded-xl border bg-white px-3 py-2.5 cursor-pointer transition ${
        isDragging ? 'z-10 shadow-lg opacity-80' : ''
      } ${selected ? 'border-teal-600 ring-2 ring-teal-600/20' : 'border-slate-200 hover:border-slate-300'}`}
    >
      <button
        {...listeners}
        {...attributes}
        className="cursor-grab active:cursor-grabbing text-slate-300 hover:text-slate-500 px-0.5"
        title="Drag to reorder"
        onClick={(e) => e.stopPropagation()}
      >
        <svg width="14" height="14" viewBox="0 0 20 20" fill="currentColor"><circle cx="7" cy="5" r="1.6" /><circle cx="7" cy="10" r="1.6" /><circle cx="7" cy="15" r="1.6" /><circle cx="13" cy="5" r="1.6" /><circle cx="13" cy="10" r="1.6" /><circle cx="13" cy="15" r="1.6" /></svg>
      </button>
      <span className="text-[10px] font-bold uppercase tracking-wide text-teal-700 bg-teal-50 rounded px-1.5 py-0.5 min-w-16 text-center">
        {field.type}
      </span>
      <span className="text-sm font-medium truncate flex-1">
        {field.label || '(untitled)'}
        {field.required && <span className="text-red-500 ml-0.5">*</span>}
        {field.hidden && <span className="ml-2 text-[10px] uppercase text-slate-400 border border-slate-200 rounded px-1 py-px">hidden</span>}
        {field.readonly && (
          <span className="ml-2 text-[10px] uppercase text-slate-600 bg-slate-100 border border-slate-200 rounded px-1 py-px">
            {field.readonly === 'always' ? 'locked' : 'lock if filled'}
          </span>
        )}
        {field.conditional && field.conditional.enabled && (
          <span className="ml-2 text-[10px] uppercase text-indigo-600 bg-indigo-50 border border-indigo-100 rounded px-1 py-px">logic</span>
        )}
        {field.prefillParam && (
          <span className="ml-2 text-[11px] font-mono text-indigo-500">?{field.prefillParam}=</span>
        )}
      </span>
      <span className={`text-[10px] text-slate-400 ${field.width === 'half' ? '' : 'hidden'}`}>½</span>
      <button
        onClick={(e) => { e.stopPropagation(); onRemove(field.id); }}
        className="opacity-0 group-hover:opacity-100 text-slate-300 hover:text-red-500 px-1"
        title="Remove field"
      >
        <svg width="14" height="14" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="2"><path d="M5 5l10 10M15 5L5 15" /></svg>
      </button>
    </div>
  );
}

/* ---------- page tab: droppable for fields, sortable to reorder pages ---------- */
function PageTab({ page, index, active, onClick }) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging, isOver } = useSortable({
    id: PAGE_DROP_PREFIX + page.id,
    data: { type: 'page', pageId: page.id, pageIndex: index },
  });
  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.6 : 1,
    zIndex: isDragging ? 20 : undefined,
  };
  return (
    <button
      ref={setNodeRef}
      style={style}
      {...attributes}
      {...listeners}
      onClick={onClick}
      title={isOver ? 'Drop here' : `Page ${index + 1} — drag to reorder`}
      className={`flex items-center gap-1.5 px-3 py-1.5 rounded-t-lg text-sm font-medium whitespace-nowrap border border-b-0 transition cursor-grab active:cursor-grabbing ${
        isOver
          ? 'bg-teal-50 border-teal-300 text-teal-900 ring-2 ring-teal-400/60'
          : active
            ? 'bg-slate-50 border-slate-200 text-slate-900'
            : 'border-transparent text-slate-400 hover:text-slate-600'
      }`}
    >
      <span className="text-[10px] font-bold uppercase tracking-wide text-slate-300">{index + 1}</span>
      <span className="truncate max-w-36">{page.title || `Page ${index + 1}`}</span>
      {page.fields.length > 0 && (
        <span className="text-[10px] font-semibold bg-teal-50 text-teal-700 rounded-full px-1.5 py-px">{page.fields.length}</span>
      )}
    </button>
  );
}

/* ---------- small UI atoms ---------- */
function Input({ label, value, onChange, mono, type = 'text', placeholder, hint, textarea, rows = 2 }) {
  const cls = `w-full border border-slate-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-teal-600/25 focus:border-teal-600 ${mono ? 'font-mono text-[13px]' : ''}`;
  return (
    <label className="block">
      <span className="block text-xs font-semibold text-slate-600 mb-1">{label}</span>
      {textarea ? (
        <textarea value={value} rows={rows} placeholder={placeholder} onChange={(e) => onChange(e.target.value)} className={cls} />
      ) : (
        <input
          type={type}
          value={value}
          placeholder={placeholder}
          onChange={(e) => onChange(e.target.value)}
          className={cls}
        />
      )}
      {hint && <span className="block text-[11px] text-slate-400 mt-1">{hint}</span>}
    </label>
  );
}

function Check({ label, checked, onChange, hint }) {
  return (
    <label className="flex items-start gap-2 cursor-pointer py-1">
      <input
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        className="mt-0.5 w-4 h-4 accent-teal-700"
      />
      <span>
        <span className="text-sm font-medium block">{label}</span>
        {hint && <span className="text-[11px] text-slate-400">{hint}</span>}
      </span>
    </label>
  );
}

/* ---------- conditional-logic editor ---------- */
function ConditionalEditor({ value, fields, onChange, subject = 'field' }) {
  const c = normalizeConditional(value);
  const eligible = Array.isArray(fields) ? fields : [];

  function patch(p) {
    onChange({ ...c, ...p });
  }

  function patchRule(i, p) {
    patch({ rules: c.rules.map((r, idx) => (idx === i ? { ...r, ...p } : r)) });
  }

  function addRule() {
    if (!eligible.length) return;
    patch({ rules: [...c.rules, { field: eligible[0].name, operator: 'is', value: '' }] });
  }

  function toggle(on) {
    if (on && !c.rules.length && eligible.length) {
      onChange({
        ...c,
        enabled: true,
        rules: [{ field: eligible[0].name, operator: 'is', value: '' }],
      });
      return;
    }
    patch({ enabled: on });
  }

  return (
    <div className="pt-2 border-t border-slate-100">
      <Check
        label="Conditional logic"
        checked={c.enabled}
        onChange={toggle}
        hint={subject === 'page'
          ? 'Show or hide this page based on answers on earlier pages.'
          : 'Show or hide this field based on other answers.'}
      />
      {c.enabled && (
        <div className="mt-2 space-y-2 rounded-lg border border-slate-200 bg-slate-50/70 p-2.5">
          <div className="flex flex-wrap items-center gap-1.5 text-xs text-slate-600">
            <select
              value={c.action}
              onChange={(e) => patch({ action: e.target.value })}
              className="border border-slate-300 rounded-md px-1.5 py-1 text-xs bg-white"
            >
              <option value="show">Show</option>
              <option value="hide">Hide</option>
            </select>
            <span>this {subject} when</span>
            <select
              value={c.match}
              onChange={(e) => patch({ match: e.target.value })}
              className="border border-slate-300 rounded-md px-1.5 py-1 text-xs bg-white"
            >
              <option value="all">all</option>
              <option value="any">any</option>
            </select>
            <span>match</span>
          </div>

          {!eligible.length && (
            <p className="text-[11px] text-amber-700">
              Add another field first — there is nothing to base the condition on.
            </p>
          )}

          {c.rules.map((r, i) => (
            <div key={i} className="rounded-lg border border-slate-200 bg-white p-2 space-y-1.5">
              <div className="flex gap-1.5">
                <select
                  value={r.field || ''}
                  onChange={(e) => patchRule(i, { field: e.target.value })}
                  className="flex-1 min-w-0 border border-slate-300 rounded-md px-1.5 py-1 text-xs"
                >
                  {eligible.map((f) => (
                    <option key={f.name} value={f.name}>{f.label || f.name}</option>
                  ))}
                </select>
                <button
                  type="button"
                  onClick={() => patch({ rules: c.rules.filter((_, idx) => idx !== i) })}
                  className="text-slate-300 hover:text-red-500 px-1 shrink-0"
                  title="Remove rule"
                >
                  <svg width="12" height="12" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="2"><path d="M5 5l10 10M15 5L5 15" /></svg>
                </button>
              </div>
              <div className="flex gap-1.5">
                <select
                  value={r.operator || 'is'}
                  onChange={(e) => patchRule(i, { operator: e.target.value })}
                  className="w-32 shrink-0 border border-slate-300 rounded-md px-1.5 py-1 text-xs"
                >
                  {CONDITION_OPERATORS.map((o) => (
                    <option key={o.value} value={o.value}>{o.label}</option>
                  ))}
                </select>
                {!NO_VALUE_OPERATORS.has(r.operator) && (
                  <input
                    value={r.value || ''}
                    onChange={(e) => patchRule(i, { value: e.target.value })}
                    placeholder="Value"
                    className="flex-1 min-w-0 border border-slate-300 rounded-md px-1.5 py-1 text-xs"
                  />
                )}
              </div>
            </div>
          ))}

          <button
            type="button"
            onClick={addRule}
            disabled={!eligible.length}
            className="text-[11px] font-semibold text-teal-700 hover:text-teal-900 disabled:opacity-40"
          >
            + Add rule
          </button>
        </div>
      )}
    </div>
  );
}

/* ---------- inspector ---------- */
function Inspector({ field, pageCount, pageOfField, onPatchField, onDeleteField, onMoveToPage, page, pageIdx, onPatchPage, allFields, pages, scoringEnabled, scoreBands }) {
  // No field selected → page settings for the active page.
  if (!field) {
    const pageConditionFields = (pages || []).flatMap((p, i) => p.fields.filter((f) => f.hidden || i < pageIdx));
    return (
      <div className="space-y-4 p-4">
        <div className="flex items-center justify-between">
          <span className="text-xs font-bold uppercase tracking-wide text-slate-400">Page settings</span>
          <span className="text-[10px] font-bold uppercase bg-slate-100 text-slate-600 rounded px-1.5 py-0.5">Page {pageIdx + 1}</span>
        </div>
        <Input label="Page title (optional)" value={page.title || ''} onChange={(v) => onPatchPage({ title: v })} hint={pageCount > 1 ? 'Shown at the top of this step in the live widget.' : 'Shown above the form.'} />
        <Input label="Page description (optional)" textarea rows={3} value={page.description || ''} onChange={(v) => onPatchPage({ description: v })} hint="A sentence or two of intro text under the title." />
        {pageIdx > 0 ? (
          <ConditionalEditor
            subject="page"
            value={page.conditional}
            fields={pageConditionFields}
            onChange={(v) => onPatchPage({ conditional: v })}
          />
        ) : (
          <div className="text-[11px] text-slate-400 border border-dashed border-slate-200 rounded-lg p-2">
            The first page is always shown. Conditional logic for a page can use answers from earlier pages.
          </div>
        )}
        <div className="text-[11px] text-slate-400 border border-dashed border-slate-200 rounded-lg p-2">
          {pageCount > 1
            ? 'Visitors see one page at a time and click Next to continue. Drag fields in from the palette to build this page.'
            : 'Drag fields in from the palette to build your form. Add a second page to split a long form into steps.'}
        </div>
      </div>
    );
  }

  const hasOptions = ['select', 'radio', 'checkbox'].includes(field.type);
  const existingValues = new Set(
    (field.options || []).map((o) => o.value).filter(Boolean)
  );

  function patchOption(oi, patch) {
    onPatchField({ options: field.options.map((o, i) => (i === oi ? { ...o, ...patch } : o)) });
  }

  function patchLabelAndMaybeValue(oi, label) {
    const prev = field.options[oi] || {};
    const wasAuto = prev.value === slugForValue(prev.label);
    const patch = { label };
    if (wasAuto) {
      const others = field.options
        .map((o, i) => (i === oi ? null : o.value))
        .filter(Boolean);
      patch.value = uniqueSlugValue(label, new Set(others));
    }
    patchOption(oi, patch);
  }

  function addOption() {
    const label = `Option ${(field.options || []).length + 1}`;
    const value = uniqueSlugValue(label, existingValues);
    onPatchField({ options: [...(field.options || []), { label, value }] });
  }

  return (
    <div className="space-y-4 p-4">
      <div className="flex items-center justify-between">
        <span className="text-xs font-bold uppercase tracking-wide text-slate-400">Field settings</span>
        <span className="text-[10px] font-bold uppercase bg-teal-50 text-teal-700 rounded px-1.5 py-0.5">{field.type}</span>
      </div>

      {pageCount > 1 && (
        <div>
          <span className="block text-xs font-semibold text-slate-600 mb-1">Page</span>
          <div className="flex flex-wrap gap-1.5">
            {Array.from({ length: pageCount }, (_, i) => (
              <button
                key={i}
                onClick={() => onMoveToPage(i)}
                disabled={i === pageOfField}
                title={i === pageOfField ? 'This field is on page ' + (i + 1) : `Move to page ${i + 1}`}
                className={`px-2.5 py-1 rounded-lg border text-xs font-medium ${
                  i === pageOfField
                    ? 'border-teal-600 bg-teal-50 text-teal-800 cursor-default'
                    : 'border-slate-200 text-slate-500 hover:border-teal-400 hover:text-teal-700'
                }`}
              >
                {i + 1}
              </button>
            ))}
          </div>
          <span className="block text-[11px] text-slate-400 mt-1">Which step this field appears on.</span>
        </div>
      )}

      <Input label="Label" value={field.label || ''} onChange={(v) => onPatchField({ label: v })} />
      <Input
        label="Description (optional)"
        textarea
        rows={2}
        value={field.description || ''}
        onChange={(v) => onPatchField({ description: v })}
        hint="Shown directly under the label. Use Help text for guidance below the input."
      />
      <Input
        label="Field key (name)"
        value={field.name || ''}
        onChange={(v) => onPatchField({ name: slugForName(v) })}
        mono
        hint="Lowercase + underscores. Used in exports, webhooks and the dataLayer."
      />

      {!field.hidden && (
        <div>
          <span className="block text-xs font-semibold text-slate-600 mb-1">Width</span>
          <div className="flex gap-2">
            {['full', 'half'].map((w) => (
              <button
                key={w}
                onClick={() => onPatchField({ width: w })}
                className={`flex-1 px-2 py-1.5 rounded-lg border text-xs font-medium capitalize ${
                  field.width === w ? 'border-teal-600 bg-teal-50 text-teal-800' : 'border-slate-200 text-slate-500 hover:border-slate-300'
                }`}
              >
                {w === 'full' ? 'Full width' : 'Half width'}
              </button>
            ))}
          </div>
        </div>
      )}

      <Check
        label="Required"
        checked={!!field.required}
        onChange={(v) => onPatchField({ required: v })}
      />

      {field.type === 'number' && !field.hidden && (
        <div>
          <span className="block text-xs font-semibold text-slate-600 mb-1">Allowed range</span>
          <div className="grid grid-cols-2 gap-2">
            <Input
              label="Minimum"
              type="number"
              value={field.min ?? ''}
              onChange={(v) => onPatchField({ min: v })}
              placeholder="e.g. 4"
            />
            <Input
              label="Maximum"
              type="number"
              value={field.max ?? ''}
              onChange={(v) => onPatchField({ max: v })}
              placeholder="e.g. 12"
            />
          </div>
          <span className="block text-[11px] text-slate-400 mt-1">Leave blank for no limit.</span>
        </div>
      )}

      {!field.hidden && (
        <div>
          <span className="block text-xs font-semibold text-slate-600 mb-1">Editing</span>
          <select
            value={field.readonly || ''}
            onChange={(e) => onPatchField({ readonly: e.target.value })}
            className="w-full border border-slate-300 rounded-lg px-2.5 py-1.5 text-sm bg-white"
          >
            <option value="">Editable</option>
            <option value="prefill">Lock when prefilled</option>
            <option value="always">Always locked</option>
          </select>
          <span className="block text-[11px] text-slate-400 mt-1">
            “Lock when prefilled” keeps a URL prefill or default value visible but uneditable; if the field is empty, visitors can still fill it.
          </span>
        </div>
      )}

      {field.type === 'email' && !field.hidden && (
        <Check
          label="Require email verification (OTP)"
          checked={!!field.otp}
          onChange={(v) => onPatchField({ otp: v })}
          hint="Sends a 6-digit code to this address. The form cannot be submitted until the code is verified."
        />
      )}

      {field.type === 'phone' && !field.hidden && (
        <Check
          label="Require SMS verification (OTP)"
          checked={!!field.otp}
          onChange={(v) => onPatchField({ otp: v })}
          hint="Sends a code via Twilio Verify. The form cannot be submitted until the number is verified; the sender number is configured on the Twilio Verify Service."
        />
      )}

      {!field.hidden && field.type !== 'select' && field.type !== 'radio' && field.type !== 'checkbox' && field.type !== 'date' && (
        <Input label="Placeholder" value={field.placeholder || ''} onChange={(v) => onPatchField({ placeholder: v })} />
      )}
      {field.type === 'select' && (
        <Input label="Placeholder text" value={field.placeholder || ''} onChange={(v) => onPatchField({ placeholder: v })} hint="Shown as the first, empty option." />
      )}
      {!field.hidden && field.type !== 'checkbox' && field.type !== 'radio' && (
        <Input label="Help text" value={field.help || ''} onChange={(v) => onPatchField({ help: v })} />
      )}

      {!field.hidden && field.type !== 'select' && field.type !== 'radio' && field.type !== 'checkbox' && (
        <Input
          label="Default value"
          value={field.defaultValue || ''}
          onChange={(v) => onPatchField({ defaultValue: v })}
          hint="Fallback used when no URL param matches."
        />
      )}

      <Input
        label="Prefill from URL param"
        value={field.prefillParam || ''}
        onChange={(v) => onPatchField({ prefillParam: v.replace(/^[?&=]+/, '').trim() })}
        mono
        hint={hasOptions
          ? 'Preselects the option whose value matches, e.g. "payment" matches ?payment=card. For checkboxes, comma-separated values work: ?tags=a,b'
          : field.hidden
            ? 'Hidden fields are usually fed by a URL param, e.g. "flat" reads ?flat=-27.61'
            : 'Auto-fills from the page URL, e.g. "fsuburb" reads ?fsuburb=MOUNT+COTTON. Leave blank to disable.'}
      />

      {hasOptions && (
        <div>
          <span className="block text-xs font-semibold text-slate-600 mb-1">Options</span>
          <div className="space-y-2">
            {(field.options || []).map((o, i) => (
              <div key={i} className="rounded-lg border border-slate-200 bg-slate-50/50 p-2 space-y-1.5">
                <input
                  value={o.label}
                  onChange={(e) => patchLabelAndMaybeValue(i, e.target.value)}
                  placeholder="Label"
                  className="w-full border border-slate-300 rounded-md px-2.5 py-1.5 text-sm"
                />
                <div className="flex gap-1.5 items-center">
                  <input
                    value={o.value}
                    onChange={(e) => patchOption(i, { value: slugForValue(e.target.value) })}
                    placeholder="value"
                    className="flex-1 min-w-0 border border-slate-300 rounded-md px-2 py-1 text-[11px] font-mono"
                  />
                  <button
                    onClick={() => onPatchField({ options: field.options.filter((_, j) => j !== i) })}
                    className="text-slate-300 hover:text-red-500 px-1 shrink-0"
                    title="Remove option"
                  >
                    <svg width="13" height="13" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="2"><path d="M5 5l10 10M15 5L5 15" /></svg>
                  </button>
                </div>
                {scoringEnabled && (
                  <details className="rounded-md border border-slate-200 bg-white/60">
                    <summary className="cursor-pointer select-none px-2 py-1 text-[11px] font-semibold text-slate-500">
                      Quiz scoring
                      {Number(o.score) ? ` · ${o.score} pts` : ''}
                      {o.knockoutBand ? ' · band override' : ''}
                      {o.followUp === 'no_call' ? ' · no call' : ''}
                    </summary>
                    <div className="space-y-1.5 px-2 pb-2 pt-1">
                      <div className="flex items-center gap-1.5">
                        <span className="text-[10px] font-semibold uppercase tracking-wide text-slate-400">Points</span>
                        <input
                          type="number"
                          value={o.score ?? 0}
                          onChange={(e) => patchOption(i, { score: Number(e.target.value) || 0 })}
                          className="w-16 border border-slate-300 rounded-md px-2 py-1 text-[11px]"
                          title="Points this answer adds to the quiz score. Negative values subtract."
                        />
                      </div>
                      {(scoreBands || []).length > 0 && (
                        <select
                          value={o.knockoutBand || ''}
                          onChange={(e) => patchOption(i, { knockoutBand: e.target.value })}
                          className="w-full border border-slate-300 rounded-md px-2 py-1 text-[11px] bg-white"
                          title="Force this band regardless of the total score."
                        >
                          <option value="">No override — score decides the band</option>
                          {(scoreBands || []).map((b) => (
                            <option key={b.key} value={b.key}>Force band: {b.label || b.key}</option>
                          ))}
                        </select>
                      )}
                      <select
                        value={o.followUp || ''}
                        onChange={(e) => patchOption(i, { followUp: e.target.value })}
                        className="w-full border border-slate-300 rounded-md px-2 py-1 text-[11px] bg-white"
                        title="What happens after submit for this answer."
                      >
                        <option value="">Follow-up: call as normal</option>
                        <option value="no_call">Follow-up: no call - nurture</option>
                      </select>
                      <select
                        value={o.route || ''}
                        onChange={(e) => patchOption(i, { route: e.target.value })}
                        className="w-full border border-slate-300 rounded-md px-2 py-1 text-[11px] bg-white"
                        title="Where this answer sends the result page."
                      >
                        <option value="">Route: super (default)</option>
                        <option value="plan">Route: payment plan</option>
                      </select>
                    </div>
                  </details>
                )}
                {(field.type === 'radio' || field.type === 'checkbox') && (
                  <input
                    value={o.linkUrl || ''}
                    onChange={(e) => patchOption(i, { linkUrl: e.target.value })}
                    placeholder="Privacy / link URL (https://…, opens in new tab)"
                    className="w-full border border-slate-300 rounded-md px-2 py-1 text-[11px]"
                  />
                )}
                {(field.type === 'radio' || field.type === 'checkbox') && o.linkUrl ? (
                  <input
                    value={o.linkText || ''}
                    onChange={(e) => patchOption(i, { linkText: e.target.value })}
                    placeholder="Link text (optional; blank links the whole label)"
                    className="w-full border border-slate-300 rounded-md px-2 py-1 text-[11px]"
                  />
                ) : null}
              </div>
            ))}
          </div>
          <button
            onClick={addOption}
            className="mt-2 text-xs font-semibold text-teal-700 hover:text-teal-900"
          >
            + Add option
          </button>
          {field.type === 'checkbox' && (
            <p className="mt-2 text-[11px] text-slate-400">
              Consent checkbox: use one option, mark it required, set the label to “I agree to the ” and the link text to “Privacy Policy”.
            </p>
          )}
        </div>
      )}

      {field.type === 'hidden' ? (
        <div className="text-[11px] text-slate-400 border border-dashed border-slate-200 rounded-lg p-2">
          Hidden fields are not shown to visitors. Set a URL param above and it will ride along with every submission.
        </div>
      ) : (
        <Check label="Hidden field" checked={!!field.hidden} onChange={(v) => onPatchField({ hidden: v })} hint="Keep in the form data but hide from visitors." />
      )}

      {!field.hidden && (
        <ConditionalEditor
          subject="field"
          value={field.conditional}
          fields={(allFields || []).filter((f) => f.name !== field.name)}
          onChange={(v) => onPatchField({ conditional: v })}
        />
      )}

      <button
        onClick={onDeleteField}
        className="w-full text-sm text-red-600 border border-red-200 rounded-lg py-2 hover:bg-red-50"
      >
        Delete field
      </button>
    </div>
  );
}

/* ---------- preview ---------- */
function Preview({ pages, settings, globalConsentText }) {
  const usp = useMemo(() => {
    try { return new URLSearchParams(window.location.search); } catch { return new URLSearchParams(); }
  }, []);
  const primary = (settings.theme && settings.theme.primary) || '#0f766e';
  const pageCount = pages.length;
  const consentText = (settings.consentText || '').trim()
    || (globalConsentText || '').trim()
    || 'By submitting your details you consent to being contacted.';

  const control = (f) => {
    const prefill = f.prefillParam ? usp.get(f.prefillParam) : null;
    const val = prefill !== null ? prefill : (f.defaultValue || '');
    const base = 'w-full border border-slate-300 rounded-lg px-3 py-2 text-sm bg-slate-50 text-slate-600';
    if (f.type === 'textarea') return <textarea disabled className={`${base} min-h-20`} value={val} />;
    if (f.type === 'select') {
      return (
        <select disabled className={base} value={val}>
          <option value="">{f.placeholder || 'Select...'}</option>
          {(f.options || []).map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
        </select>
      );
    }
    if (f.type === 'radio' || f.type === 'checkbox') {
      return (
        <div className="space-y-1.5">
          {(f.options || []).map((o) => (
            <label key={o.value} className="flex items-center gap-2 text-sm text-slate-600">
              <input type={f.type} disabled checked={String(o.value) === String(val)} className="accent-teal-700" />
              {o.label}
            </label>
          ))}
        </div>
      );
    }
    const t = ['email', 'phone', 'number', 'date'].includes(f.type) ? f.type : 'text';
    return <input type={t} disabled className={base} value={val} placeholder={f.placeholder} />;
  };

  const allFields = pages.flatMap((p) => p.fields);
  const hiddenCount = allFields.filter((f) => f.hidden).length;
  const hasHidden = hiddenCount > 0;

  return (
    <div className="max-w-xl space-y-3">
      {pageCount > 1 && (
        <div className="text-xs text-slate-500 bg-white border border-slate-200 rounded-lg px-3 py-2">
          This form has <b>{pageCount} pages</b>. In the live widget visitors see one step at a time with Next / Back —
          all steps are shown stacked here so you can review the whole form.
        </div>
      )}
      <div className="bg-white border border-slate-200 rounded-xl p-6">
        <div className="text-xs text-slate-400 mb-4">
          Visual preview — inputs are disabled. Hidden fields ({hiddenCount}) are not shown.
          {hasHidden && ' Values prefilled from the current page URL are reflected above.'}
        </div>
        {pages.map((pg, i) => {
          const visible = pg.fields.filter((f) => !f.hidden);
          if (!visible.length && pageCount === 1) {
            return (
              <div key={pg.id} className="text-center text-sm text-slate-400 py-8">
                No visible fields yet — drop some on the canvas.
              </div>
            );
          }
          return (
            <div key={pg.id} className={i > 0 ? 'mt-6 pt-6 border-t border-dashed border-slate-200' : ''}>
              {pageCount > 1 && (
                <div className="flex items-center gap-2 mb-3">
                  <span className="text-[10px] font-bold uppercase tracking-wide bg-slate-900 text-white rounded px-1.5 py-0.5">
                    Step {i + 1} of {pageCount}
                  </span>
                  {pg.title && <span className="text-sm font-bold">{pg.title}</span>}
                </div>
              )}
              {(pg.title || pg.description) && pageCount === 1 && (
                <div className="mb-4">
                  {pg.title && <div className="text-lg font-bold">{pg.title}</div>}
                  {pg.description && <div className="text-sm text-slate-500 mt-1">{pg.description}</div>}
                </div>
              )}
              {visible.length > 0 && (
                <div className="grid grid-cols-2 gap-4">
                  {visible.map((f) => (
                    <div key={f.id} className={f.width === 'half' ? '' : 'col-span-2'}>
                      <div className="text-sm font-semibold mb-1">
                        {f.label} {f.required && <span className="text-red-500">*</span>}
                      </div>
                      {f.description && <div className="text-[12px] text-slate-500 mb-1">{f.description}</div>}
                      {control(f)}
                      {f.help && <div className="text-[11px] text-slate-400 mt-1">{f.help}</div>}
                    </div>
                  ))}
                </div>
              )}
              {pageCount > 1 && i < pageCount - 1 && (
                <div className="mt-4 flex justify-end">
                  <div className="text-center text-white rounded-lg px-6 py-2.5 text-sm font-semibold opacity-70" style={{ background: primary }}>
                    Next →
                  </div>
                </div>
              )}
            </div>
          );
        })}
        <div className={pageCount > 1 ? 'mt-6' : 'mt-4'}>
          <div
            className="text-center text-white rounded-lg py-2.5 text-sm font-semibold"
            style={{ background: primary }}
          >
            {settings.submitLabel || 'Submit'}
          </div>
          <div className="text-center text-[11px] text-slate-400 mt-2">{consentText}</div>
        </div>
        {settings.scoring && settings.scoring.enabled && (
          <div className="mt-5 pt-5 border-t border-dashed border-slate-200">
            <div className="text-[10px] font-bold uppercase tracking-wide text-slate-400 mb-2">
              Result screen · {settings.scoring.display === 'traffic' ? 'traffic light' : settings.scoring.display === 'none' ? 'text only' : 'speedometer'}
            </div>
            <div className="flex flex-wrap gap-1.5">
              {(settings.scoring.bands || []).map((b, i) => (
                <span
                  key={i}
                  className="text-[11px] font-semibold rounded-full px-2.5 py-1"
                  style={{ background: (b.color || '#64748b') + '1f', color: b.color || '#64748b' }}
                >
                  {b.label || 'Band'} · {b.min ?? 0}%+
                </span>
              ))}
            </div>
            <p className="text-[11px] text-slate-400 mt-2">
              After submit the visitor sees the score, the matching band and its recommendation.
              A band with a redirect sends them to that page instead.
            </p>
          </div>
        )}
      </div>
    </div>
  );
}

/* ---------- main editor ---------- */
export default function Editor({ formId, initialTab, onBack }) {
  const [loaded, setLoaded] = useState(false);
  const [loadErr, setLoadErr] = useState('');
  const [title, setTitle] = useState('');
  const [slug, setSlug] = useState('');
  const [status, setStatus] = useState('draft');
  const [pages, setPages] = useState([{ id: 'p1', title: '', description: '', conditional: emptyConditional(), fields: [] }]);
  const [activePage, setActivePage] = useState(0);
  const [settings, setSettings] = useState(DEFAULT_SETTINGS);
  const [notifications, setNotifications] = useState([]);
  const [notifTest, setNotifTestState] = useState({});
  const setNotifTest = (i, v) => setNotifTestState((prev) => ({ ...prev, [i]: v }));
  const [globalSettings, setGlobalSettings] = useState({ consentText: '' });
  const [whTest, setWhTest] = useState(null);
  const [selectedId, setSelectedId] = useState(null);
  const [tab, setTab] = useState(initialTab || 'fields');
  const [openRow, setOpenRow] = useState(null);
  const [saving, setSaving] = useState(false);
  const [savedAt, setSavedAt] = useState('');
  const [error, setError] = useState('');
  const [dragLabel, setDragLabel] = useState(null);
  const [subs, setSubs] = useState({ rows: [], total: 0, fieldNames: [] });
  const [subsLoading, setSubsLoading] = useState(false);
  const [blocklist, setBlocklist] = useState([]);
  const [showBlocklist, setShowBlocklist] = useState(false);
  // Derived AFTER `subs` exists - referencing it earlier throws (white screen).
  const subsFields = subs.fields || subs.fieldNames.map((n) => ({ name: n, label: n, options: [] }));
  const mainFields = (() => {
    // Lead columns read best as name, phone, email - pin them regardless of form order.
    const find = (patterns) => subsFields.find((f) => patterns.some((p) =>
      new RegExp(p, 'i').test(f.name || '') || new RegExp(p, 'i').test(f.label || '')));
    const pinned = [
      (() => {
        const single = find(['^name$', 'full_?name', 'your_?name']);
        if (single) return single;
        const first = find(['first_?name', 'given_?name', '^first$']);
        const last = find(['last_?name', 'surname', 'family_?name']);
        if (!first && !last) return null;
        // First and last name share one column.
        return { name: '__full_name', label: 'Name', type: 'full_name', parts: [first, last].filter(Boolean) };
      })(),
      find(['phone', 'mobile', 'contact_?number']),
      find(['e-?mail']),
    ].filter(Boolean);
    const uniquePinned = pinned.filter((f, i) => pinned.indexOf(f) === i);
    if (uniquePinned.length) return uniquePinned.slice(0, 3);
    const preferred = subsFields.filter((f) => ['text', 'email', 'phone'].includes(f.type));
    return (preferred.length ? preferred : subsFields).slice(0, 3);
  })();

  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 5 } }));

  const currentPage = pages[activePage] || pages[0];
  const { field: selectedField } = findField(pages, selectedId);
  const totalFields = pages.reduce((n, p) => n + p.fields.length, 0);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await api.getForm(formId);
        if (cancelled) return;
        setTitle(res.form.title);
        setSlug(res.form.slug);
        setStatus(res.form.status);
        const cfg = res.form.config || {};
        setPages(buildPages(cfg.fields, cfg.pages));
        setSettings(mergeSettings(cfg.settings));
        setNotifications(cfg.notifications || []);
        setLoaded(true);
      } catch (e) {
        if (!cancelled) setLoadErr(e.message);
      }
    })();
    return () => { cancelled = true; };
  }, [formId]);

  useEffect(() => {
    if (tab === 'submissions' && loaded) loadSubmissions();
  }, [tab, loaded]);

  // Global defaults (consent wording fallback) — shown as the placeholder on the per-form override.
  useEffect(() => {
    let cancelled = false;
    api.getSettings()
      .then((r) => { if (!cancelled) setGlobalSettings(r.settings || {}); })
      .catch(() => { /* non-fatal — the per-form override still works */ });
    return () => { cancelled = true; };
  }, []);

  async function loadSubmissions() {
    setSubsLoading(true);
    try {
      const res = await api.getSubmissions(formId, 200);
      setSubs({ rows: res.submissions || [], total: res.total || 0, fieldNames: res.fieldNames || [] });
      const bl = await api.listBlocklist().catch(() => ({}));
      setBlocklist((bl && bl.blocked) || []);
      // Opening the Submissions tab counts as reading them - clears the green chip.
      api.markFormSeen(formId).catch(() => { /* badge only; never block the list */ });
    } catch (e) {
      setError(e.message);
    } finally {
      setSubsLoading(false);
    }
  }

  async function save(nextStatus) {
    setSaving(true);
    setError('');
    try {
      const res = await api.updateForm(formId, {
        title: title || '(untitled)',
        slug,
        status: nextStatus || status,
        config: { fields: flattenFields(pages), settings, notifications, pages: pagesMeta(pages) },
      });
      const cfg = res.form.config || {};
      setPages(buildPages(cfg.fields, cfg.pages));
      setActivePage((a) => Math.min(a, (cfg.pages && cfg.pages.length) ? cfg.pages.length - 1 : 0));
      setSettings(mergeSettings(cfg.settings));
      setNotifications(cfg.notifications || []);
      setStatus(res.form.status);
      setSlug(res.form.slug);
      setTitle(res.form.title);
      setSavedAt(new Date().toLocaleTimeString());
    } catch (e) {
      setError(e.message);
    } finally {
      setSaving(false);
    }
  }

  async function removeForm() {
    if (!window.confirm('Delete this form and ALL its submissions? This cannot be undone.')) return;
    try {
      await api.deleteForm(formId);
      onBack();
    } catch (e) {
      setError(e.message);
    }
  }

  /* ----- page operations ----- */
  function addPage() {
    const id = nextPageId(pages);
    setPages((prev) => [...prev, { id, title: '', description: '', conditional: emptyConditional(), fields: [] }]);
    setActivePage(pages.length);
    setSelectedId(null);
  }

  function deletePage(idx) {
    if (pages.length <= 1) return;
    const target = idx === 0 ? 0 : idx - 1; // deleted page's fields flow backwards
    const moved = pages[idx].fields;
    const next = pages
      .filter((_, i) => i !== idx)
      .map((p, i) => (i === target ? { ...p, fields: [...p.fields, ...moved] } : p));
    setPages(next);
    let na = activePage;
    if (na === idx) na = target;
    else if (na > idx) na -= 1;
    setActivePage(Math.max(0, Math.min(na, next.length - 1)));
  }

  function patchActivePage(patch) {
    setPages((prev) => prev.map((p, i) => (i === activePage ? { ...p, ...patch } : p)));
  }

  /* ----- field operations ----- */
  function addField(type) {
    const existingNames = new Set(pages.flatMap((p) => p.fields.map((f) => f.name)));
    const field = makeField(type, nextFieldId(pages.flatMap((p) => p.fields)), existingNames);
    setPages((prev) => prev.map((p, i) => (i === activePage ? { ...p, fields: [...p.fields, field] } : p)));
    setSelectedId(field.id);
  }

  function patchField(id, patch) {
    setPages((prev) =>
      prev.map((p) =>
        p.fields.some((f) => f.id === id)
          ? { ...p, fields: p.fields.map((f) => (f.id === id ? { ...f, ...patch } : f)) }
          : p
      )
    );
  }

  function removeField(id) {
    setPages((prev) => prev.map((p) => ({ ...p, fields: p.fields.filter((f) => f.id !== id) })));
    if (selectedId === id) setSelectedId(null);
  }

  function moveFieldToPage(id, toIdx) {
    setPages((prev) => {
      const from = prev.findIndex((p) => p.fields.some((f) => f.id === id));
      if (from < 0 || from === toIdx) return prev;
      const f = prev[from].fields.find((x) => x.id === id);
      return prev.map((p, i) => {
        if (i === from) return { ...p, fields: p.fields.filter((x) => x.id !== id) };
        if (i === toIdx) return { ...p, fields: [...p.fields, f] };
        return p;
      });
    });
    setActivePage(toIdx);
  }

  function patchSettings(key, val) {
    setSettings((s) => ({ ...s, [key]: val }));
  }
  function patchTs(key, val) {
    setSettings((s) => ({ ...s, turnstile: { ...s.turnstile, [key]: val } }));
  }
  function patchTheme(key, val) {
    setSettings((s) => ({ ...s, theme: { ...s.theme, [key]: val } }));
  }
  function patchUtm(key, val) {
    setSettings((s) => ({ ...s, utm: { ...(s.utm || {}), [key]: val } }));
  }
  function patchNotification(i, patch) {
    setNotifications((prev) => prev.map((n, idx) => (idx === i ? { ...n, ...patch } : n)));
  }
  function patchSubmitWebhook(key, val) {
    setSettings((s) => ({ ...s, submitWebhook: { ...s.submitWebhook, [key]: val } }));
  }
  function patchScoring(key, val) {
    setSettings((s) => ({
      ...s,
      scoring: { ...DEFAULT_SETTINGS.scoring, ...(s.scoring || {}), [key]: val },
    }));
  }
  function patchBand(i, patch) {
    setSettings((s) => {
      const scoring = { ...DEFAULT_SETTINGS.scoring, ...(s.scoring || {}) };
      const bands = (scoring.bands || []).map((b, idx) => (idx === i ? { ...b, ...patch } : b));
      return { ...s, scoring: { ...scoring, bands } };
    });
  }
  function addBand() {
    setSettings((s) => {
      const scoring = { ...DEFAULT_SETTINGS.scoring, ...(s.scoring || {}) };
      const bands = (scoring.bands || []).slice();
      const last = bands[bands.length - 1];
      const min = Math.min(90, (Number(last && last.min) || 0) + 30);
      bands.push({
        key: `band_${bands.length + 1}`,
        label: 'New band',
        min,
        color: ['#0ea5e9', '#7c3aed', '#64748b'][bands.length % 3],
        headline: '',
        recommendation: '',
        redirectUrl: '',
        ctaLabel: '',
        ctaUrl: '',
      });
      return { ...s, scoring: { ...scoring, bands } };
    });
  }
  function removeBand(i) {
    setSettings((s) => {
      const scoring = { ...DEFAULT_SETTINGS.scoring, ...(s.scoring || {}) };
      const bands = (scoring.bands || []).filter((_, idx) => idx !== i);
      return { ...s, scoring: { ...scoring, bands } };
    });
  }
  async function runWebhookTest() {
    setWhTest({ loading: true });
    try {
      const res = await api.testWebhook({ url: settings.submitWebhook.url, token: settings.submitWebhook.token, form_slug: slug });
      setWhTest(res);
    } catch (e) {
      setWhTest({ ok: false, status: 0, error: e.message });
    }
  }

  function onDragStart(e) {
    const d = e.active.data.current || {};
    if (d.type === 'page') {
      const pg = pages[Number(d.pageIndex)];
      setDragLabel(pg ? (pg.title || `Page ${Number(d.pageIndex) + 1}`) : 'Page');
      return;
    }
    if (d.paletteType) {
      const meta = FIELD_TYPES.find((t) => t.type === d.paletteType);
      setDragLabel(meta ? meta.label : d.paletteType);
    } else {
      const { field } = findField(pages, e.active.id);
      setDragLabel(field ? field.label || field.type : 'field');
    }
  }

  function onDragEnd(e) {
    const { active, over } = e;
    setDragLabel(null);
    if (!over) return;
    const d = active.data.current || {};
    const overPageIdx = String(over.id || '').startsWith(PAGE_DROP_PREFIX)
      ? pages.findIndex((p) => PAGE_DROP_PREFIX + p.id === String(over.id))
      : -1;

    // Dragging a page tab to a new position (the tab is both sortable and a
    // drop target for fields).
    if (d.type === 'page') {
      const from = pages.findIndex((p) => PAGE_DROP_PREFIX + p.id === String(active.id));
      const to = overPageIdx;
      if (from < 0 || to < 0 || from === to) return;
      setPages((prev) => arrayMove(prev, from, to));
      setActivePage(to);
      setSelectedId(null);
      return;
    }

    if (d.paletteType) {
      const existingNames = new Set(pages.flatMap((p) => p.fields.map((f) => f.name)));
      const all = pages.flatMap((p) => p.fields);
      const field = makeField(d.paletteType, nextFieldId(all), existingNames);

      // Dropped onto a page tab → add the field to that page.
      if (overPageIdx >= 0) {
        setPages((prev) => prev.map((p, i) => (
          i === overPageIdx ? { ...p, fields: [...p.fields, field] } : p
        )));
        setActivePage(overPageIdx);
        setSelectedId(field.id);
        return;
      }

      const pageFields = currentPage.fields;
      const overIdx = over.id === CANVAS_ID ? pageFields.length : pageFields.findIndex((f) => f.id === over.id);
      const idx = overIdx < 0 ? pageFields.length : overIdx;
      const copy = [...pageFields];
      copy.splice(idx, 0, field);
      setPages((prev) => prev.map((p, i) => (i === activePage ? { ...p, fields: copy } : p)));
      setSelectedId(field.id);
      return;
    }

    if (active.id === over.id) return;

    // Dropped onto a page tab → move the field to that page (append at the end).
    if (overPageIdx >= 0) {
      setPages((prev) => {
        const from = prev.findIndex((p) => p.fields.some((f) => f.id === active.id));
        if (from < 0 || from === overPageIdx) return prev;
        const moved = prev[from].fields.find((f) => f.id === active.id);
        return prev.map((p, i) => {
          if (i === from) return { ...p, fields: p.fields.filter((f) => f.id !== active.id) };
          if (i === overPageIdx) return { ...p, fields: [...p.fields, moved] };
          return p;
        });
      });
      setActivePage(overPageIdx);
      setSelectedId(active.id);
      return;
    }

    const pageFields = currentPage.fields;
    const from = pageFields.findIndex((f) => f.id === active.id);
    const to = pageFields.findIndex((f) => f.id === over.id);
    if (from >= 0 && to >= 0) {
      const reordered = arrayMove(pageFields, from, to);
      setPages((prev) => prev.map((p, i) => (i === activePage ? { ...p, fields: reordered } : p)));
    }
  }

  function CanvasDroppable({ children }) {
    const { setNodeRef, isOver } = useDroppable({ id: CANVAS_ID });
    return (
      <div
        ref={setNodeRef}
        className={`min-h-[200px] rounded-xl border-2 border-dashed p-3 space-y-2 transition ${
          isOver ? 'border-teal-500 bg-teal-50/50' : 'border-slate-200'
        }`}
      >
        {children}
      </div>
    );
  }

  const embedSnippet = `<div data-ff-form="${slug}"></div>
<script src="${FF_EMBED_ORIGIN}/widget.js?v=${FF_VERSION}"
        data-ff-origin="${FF_EMBED_ORIGIN}"
        data-no-optimize="1"
        data-cfasync="false" async></script>`;

  const tabBtn = (key, label) => (
    <button
      onClick={() => setTab(key)}
      className={`px-3 py-1.5 rounded-lg text-sm font-medium ${
        tab === key ? 'bg-slate-900 text-white' : 'text-slate-500 hover:bg-slate-200/60'
      }`}
    >
      {label}
    </button>
  );

  if (loadErr) {
    return (
      <div className="bg-white border border-slate-200 rounded-xl p-8 text-center">
        <p className="text-red-600 mb-4">{loadErr}</p>
        <button onClick={onBack} className="text-sm font-semibold text-teal-700">← Back to forms</button>
      </div>
    );
  }

  if (!loaded) {
    return <div className="p-10 text-sm text-slate-500 text-center">Loading form…</div>;
  }

  return (
    <div className="flex flex-col gap-4">
      {/* top bar */}
      <div className="bg-white border border-slate-200 rounded-xl px-4 py-3 flex items-center gap-3 flex-wrap">
        <button onClick={onBack} className="text-slate-500 hover:text-slate-800 text-sm font-medium">← Forms</button>
        <input
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          className="font-bold text-lg bg-transparent border-b-2 border-transparent hover:border-slate-200 focus:border-teal-600 focus:outline-none min-w-40"
          placeholder="Form title"
        />
        <span className={`px-2 py-0.5 rounded-full text-xs font-medium ${status === 'published' ? 'bg-emerald-100 text-emerald-800' : 'bg-amber-100 text-amber-800'}`}>
          {status}
        </span>
        {error && <span className="text-sm text-red-600 flex-1">{error}</span>}
        {savedAt && !error && <span className="text-xs text-slate-400">Saved {savedAt}</span>}
        <div className="flex gap-2 ml-auto">
          {status === 'draft' ? (
            <button
              onClick={() => save('published')}
              disabled={saving || !totalFields}
              className="px-4 py-2 rounded-lg bg-emerald-600 hover:bg-emerald-700 text-white text-sm font-semibold disabled:opacity-40"
              title="Make the widget load this form"
            >
              {saving ? 'Saving…' : 'Publish'}
            </button>
          ) : (
            <button
              onClick={() => save('draft')}
              disabled={saving}
              className="px-4 py-2 rounded-lg border border-slate-300 text-slate-600 hover:bg-slate-50 text-sm font-semibold"
            >
              Unpublish
            </button>
          )}
          <button
            onClick={() => save()}
            disabled={saving}
            className="px-4 py-2 rounded-lg bg-teal-700 hover:bg-teal-800 text-white text-sm font-semibold disabled:opacity-50"
          >
            {saving ? 'Saving…' : 'Save'}
          </button>
        </div>
      </div>

      {/* tabs */}
      <div className="flex gap-1 px-1">
        {tabBtn('fields', 'Build')}
        {tabBtn('preview', 'Preview')}
        {tabBtn('settings', 'Settings')}
        {tabBtn('submissions', `Submissions${subs.total ? ` (${subs.total})` : ''}`)}
        {tabBtn('analytics', 'Analytics')}
        {tabBtn('embed', 'Embed')}
      </div>

      {/* BUILD */}
      {tab === 'fields' && (
        <DndContext sensors={sensors} collisionDetection={collisionDetection} onDragStart={onDragStart} onDragEnd={onDragEnd} onDragCancel={() => setDragLabel(null)}>
          <div className="grid grid-cols-1 lg:grid-cols-[220px_1fr_300px] gap-4 items-start">
            {/* palette */}
            <div className="bg-white border border-slate-200 rounded-xl p-3 space-y-2 lg:sticky lg:top-20">
              <div className="text-xs font-bold uppercase tracking-wide text-slate-400 px-1 pt-1">Add fields</div>
              {FIELD_TYPES.map((t) => (
                <PaletteChip key={t.type} type={t.type} label={t.label} hint={t.hint} />
              ))}
              <p className="text-[11px] text-slate-400 px-1 pt-1">Drag onto the canvas, or click a field to select and edit it.</p>
            </div>

            {/* canvas */}
            <div>
              <div className="bg-white border border-slate-200 rounded-xl overflow-hidden">
                {/* page tabs */}
                <div className="flex items-center gap-1 border-b border-slate-200 px-2 pt-2 pb-0 overflow-x-auto">
                  <SortableContext
                    items={pages.map((p) => PAGE_DROP_PREFIX + p.id)}
                    strategy={horizontalListSortingStrategy}
                  >
                    {pages.map((p, i) => (
                      <PageTab
                        key={p.id}
                        page={p}
                        index={i}
                        active={i === activePage}
                        onClick={() => { setActivePage(i); setSelectedId(null); }}
                      />
                    ))}
                  </SortableContext>
                  <button
                    onClick={addPage}
                    className="px-2.5 py-1.5 rounded-lg text-xs font-semibold text-teal-700 hover:bg-teal-50 whitespace-nowrap my-1"
                    title="Add a page — visitors click Next to move between pages"
                  >
                    + Add page
                  </button>
                  {pages.length > 1 && (
                    <button
                      onClick={() => deletePage(activePage)}
                      className="ml-auto px-2 py-1.5 rounded-lg text-xs font-semibold text-slate-400 hover:text-red-600 hover:bg-red-50 whitespace-nowrap my-1"
                      title="Delete this page — its fields move to the previous page"
                    >
                      <svg width="13" height="13" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="2"><path d="M5 5l10 10M15 5L5 15" /></svg>
                    </button>
                  )}
                </div>
                <div className="p-3">
                  <CanvasDroppable>
                    {!currentPage.fields.length && (
                      <div className="text-center text-sm text-slate-400 py-12">
                        {totalFields === 0
                          ? 'Drop fields here to build your form.'
                          : `Page ${activePage + 1} is empty — drop fields here or move some onto it.`}
                      </div>
                    )}
                    <SortableContext items={currentPage.fields.map((f) => f.id)} strategy={verticalListSortingStrategy}>
                      {currentPage.fields.map((f) => (
                        <SortableRow key={f.id} field={f} selected={f.id === selectedId} onSelect={setSelectedId} onRemove={removeField} />
                      ))}
                    </SortableContext>
                  </CanvasDroppable>
                  <p className="text-[11px] text-slate-400 mt-2 px-1">
                    {pages.length > 1 && (
                      <span className="block text-teal-700 font-medium">Drag a field onto a page tab to move it there, or drag a tab to reorder pages.</span>
                    )}
                    {pages.length > 1 ? (
                      <>Drag palette items here to add to this page. Add pages to split long forms into steps — visitors click Next to continue. Hidden fields ride along with every submission no matter which page they sit on.</>
                    ) : (
                      <>Drag palette items here to add. Drag rows to reorder. Tip: pair fields as half-width (e.g. First / Last). Add a second page to turn this into a step-by-step form.</>
                    )}
                  </p>
                </div>
              </div>
            </div>

            {/* inspector */}
            <div className="bg-white border border-slate-200 rounded-xl lg:sticky lg:top-20">
              <Inspector
                field={selectedField}
                pageCount={pages.length}
                pageOfField={selectedField ? findField(pages, selectedId).pageIdx : -1}
                onPatchField={(patch) => patchField(selectedId, patch)}
                onDeleteField={() => removeField(selectedId)}
                onMoveToPage={(i) => moveFieldToPage(selectedId, i)}
                page={currentPage}
                pageIdx={activePage}
                onPatchPage={patchActivePage}
                allFields={pages.flatMap((p) => p.fields)}
                pages={pages}
                scoringEnabled={!!(settings.scoring && settings.scoring.enabled)}
                scoreBands={(settings.scoring && settings.scoring.bands) || []}
              />
            </div>
          </div>
          <DragOverlay>
            {dragLabel && (
              <div className="px-4 py-2.5 rounded-lg bg-teal-700 text-white text-sm font-medium shadow-lg">
                {dragLabel}
              </div>
            )}
          </DragOverlay>
        </DndContext>
      )}

      {/* PREVIEW */}
      {tab === 'preview' && <Preview pages={pages} settings={settings} globalConsentText={globalSettings.consentText} />}

      {/* SETTINGS */}
      {tab === 'settings' && (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 items-start">
          <div className="bg-white border border-slate-200 rounded-xl p-5 space-y-4">
            <h3 className="text-sm font-bold">Behaviour</h3>
            <Input label="Submit button label" value={settings.submitLabel} onChange={(v) => patchSettings('submitLabel', v)} />
            <label className="block">
              <span className="block text-xs font-semibold text-slate-600 mb-1">Success message</span>
              <textarea
                value={settings.successMessage}
                onChange={(e) => patchSettings('successMessage', e.target.value)}
                rows={2}
                className="w-full border border-slate-300 rounded-lg px-3 py-2 text-sm"
              />
            </label>
            <Input label="Redirect on success (optional)" value={settings.redirectUrl} onChange={(v) => patchSettings('redirectUrl', v)} hint="Full URL. When set, this wins over the success message." />
            {settings.redirectUrl && (
              <Check label="Open redirect in a new tab" checked={!!settings.redirectNewTab} onChange={(v) => patchSettings('redirectNewTab', v)} hint="Keeps your page open and opens the redirect in a new tab instead of navigating away." />
            )}

            <div className="pt-3 border-t border-slate-100">
              <h4 className="text-xs font-bold uppercase tracking-wide text-slate-400 mb-2">Quiz scoring</h4>
              <Check
                label="Enable scoring / quiz result"
                checked={!!settings.scoring.enabled}
                onChange={(v) => patchScoring('enabled', v)}
                hint="Give each answer points in the Fields tab. On submit the visitor gets a banded readiness result, and can be sent to a different page per band."
              />
              {settings.scoring.enabled && (
                <div className="mt-3 space-y-3">
                  <div className="grid grid-cols-2 gap-3">
                    <label className="block">
                      <span className="block text-xs font-semibold text-slate-600 mb-1">Result display</span>
                      <select
                        value={settings.scoring.display || 'gauge'}
                        onChange={(e) => patchScoring('display', e.target.value)}
                        className="w-full border border-slate-300 rounded-lg px-2.5 py-1.5 text-sm bg-white"
                      >
                        <option value="gauge">Speedometer</option>
                        <option value="traffic">Traffic light</option>
                        <option value="none">Text only</option>
                      </select>
                    </label>
                    <Input
                      label="Redirect delay (ms)"
                      type="number"
                      value={settings.scoring.redirectDelayMs ?? 1500}
                      onChange={(v) => patchScoring('redirectDelayMs', Number(v) || 0)}
                      hint="How long the result stays on screen before a redirect. 0 = immediately."
                    />
                  </div>
                  <Check
                    label="Show the numeric score (0-100)"
                    checked={settings.scoring.showScore !== false}
                    onChange={(v) => patchScoring('showScore', v)}
                    hint="Off = the visitor only sees the band label and recommendation."
                  />
                  <Check
                    label="Auto-redirect to the band page after the result"
                    checked={settings.scoring.autoRedirect !== false}
                    onChange={(v) => patchScoring('autoRedirect', v)}
                    hint="Off = the score page stays until the visitor clicks the CTA. Use this when the CTA is the only next step."
                  />
                  <div className="rounded-lg border border-slate-200 p-3 space-y-2">
                    <div className="text-[11px] font-bold uppercase tracking-wide text-slate-400">Result video (optional)</div>
                    <Input
                      label="Video URL"
                      value={settings.scoring.videoUrl || ''}
                      onChange={(v) => patchScoring('videoUrl', v)}
                      mono
                      hint="https:// only — a YouTube/Vimeo link or a direct .mp4/.webm file. Shown under the score. A band's own video wins."
                    />
                    <Input
                      label="Video caption (optional)"
                      value={settings.scoring.videoCaption || ''}
                      onChange={(v) => patchScoring('videoCaption', v)}
                    />
                    <Input
                      label="Result disclaimer (optional)"
                      textarea
                      rows={3}
                      value={settings.scoring.disclaimer || ''}
                      onChange={(v) => patchScoring('disclaimer', v)}
                      hint="Shown at the bottom of the result. Keep it factual: a guide only, not an eligibility decision or financial advice."
                    />
                    <div className="rounded-lg border border-slate-200 p-3 space-y-2">
                      <div className="text-[11px] font-bold uppercase tracking-wide text-slate-400">Payment plan path</div>
                      <Input
                        label="Plan CTA URL"
                        value={settings.scoring.planUrl || ''}
                        onChange={(v) => patchScoring('planUrl', v)}
                        mono
                        hint="Used when an answer routes to a payment plan. https:// or a root-relative path."
                      />
                      <Input
                        label="Plan CTA label"
                        value={settings.scoring.planCtaLabel || ''}
                        onChange={(v) => patchScoring('planCtaLabel', v)}
                        placeholder="See payment plan options"
                      />
                      <Input
                        label="Plan headline"
                        value={settings.scoring.planHeadline || ''}
                        onChange={(v) => patchScoring('planHeadline', v)}
                        placeholder="Prefer not to touch your super? There is another way."
                      />
                      <Input
                        label="Plan recommendation"
                        textarea
                        rows={2}
                        value={settings.scoring.planRecommendation || ''}
                        onChange={(v) => patchScoring('planRecommendation', v)}
                        placeholder="We will call you about payment plan options and the exact cost - no obligation."
                      />
                    </div>
                  </div>
                  <p className="text-[11px] text-slate-400">
                    Band thresholds are percentages of the maximum possible points. The first band is always pinned to 0%.
                    A band redirect wins over the form-wide redirect above.
                  </p>
                  <div className="space-y-3">
                    {(settings.scoring.bands || []).map((b, i) => (
                      <div key={i} className="rounded-lg border border-slate-200 bg-slate-50/50 p-3 space-y-2">
                        <div className="flex items-center gap-2">
                          <input
                            type="color"
                            value={b.color || '#64748b'}
                            onChange={(e) => patchBand(i, { color: e.target.value })}
                            className="w-8 h-8 rounded border border-slate-300 cursor-pointer shrink-0"
                            title="Band colour"
                          />
                          <input
                            value={b.label || ''}
                            onChange={(e) => patchBand(i, { label: e.target.value })}
                            placeholder="Band label"
                            className="flex-1 min-w-0 border border-slate-300 rounded-md px-2 py-1.5 text-sm"
                          />
                          <div className="flex items-center gap-1 shrink-0">
                            <input
                              type="number"
                              min="0"
                              max="100"
                              value={b.min ?? 0}
                              onChange={(e) => patchBand(i, { min: Number(e.target.value) || 0 })}
                              className="w-16 border border-slate-300 rounded-md px-2 py-1.5 text-sm"
                              title="Minimum percentage"
                            />
                            <span className="text-xs text-slate-400">%+</span>
                          </div>
                          <button
                            onClick={() => removeBand(i)}
                            className="text-slate-300 hover:text-red-500 px-1 shrink-0"
                            title="Remove band"
                          >
                            <svg width="13" height="13" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="2"><path d="M5 5l10 10M15 5L5 15" /></svg>
                          </button>
                        </div>
                        <Input label="Headline" value={b.headline || ''} onChange={(v) => patchBand(i, { headline: v })} placeholder="e.g. You're ready to launch" />
                        <Input label="Recommendation" textarea rows={2} value={b.recommendation || ''} onChange={(v) => patchBand(i, { recommendation: v })} placeholder="What this visitor should do next." />
                        <Input label="Redirect for this band (optional)" value={b.redirectUrl || ''} onChange={(v) => patchBand(i, { redirectUrl: v })} hint="https:// URL or a root-relative path. ff_band and ff_score are appended automatically." />
                        <div className="grid grid-cols-2 gap-2">
                          <Input label="CTA label" value={b.ctaLabel || ''} onChange={(v) => patchBand(i, { ctaLabel: v })} placeholder="Book a call" />
                          <Input label="CTA URL" value={b.ctaUrl || ''} onChange={(v) => patchBand(i, { ctaUrl: v })} placeholder="https://… or tel:+61…" />
                        </div>
                        <Input label="Video URL for this band (optional)" value={b.videoUrl || ''} onChange={(v) => patchBand(i, { videoUrl: v })} mono hint="Overrides the form-level result video for this band." />
                      </div>
                    ))}
                  </div>
                  <button onClick={addBand} className="text-xs font-semibold text-teal-700 hover:text-teal-900">+ Add band</button>
                </div>
              )}
            </div>

            <Input label="dataLayer event name (optional)" value={settings.dataLayerEvent} onChange={(v) => patchSettings('dataLayerEvent', v)} mono hint='Fired on the host page on successful submit, e.g. "deliveryDealSubmit". Wire it up in GTM to fire your FB pixel / GA4 conversions.' />
            <div className="pt-1">
              <label className="block">
                <span className="block text-xs font-semibold text-slate-600 mb-1">Theme primary colour</span>
                <div className="flex items-center gap-2">
                  <input type="color" value={settings.theme.primary} onChange={(e) => patchTheme('primary', e.target.value)} className="w-9 h-9 rounded border border-slate-300 cursor-pointer" />
                  <input value={settings.theme.primary} onChange={(e) => patchTheme('primary', e.target.value)} className="border border-slate-300 rounded-lg px-2 py-1.5 text-xs font-mono w-28" />
                </div>
              </label>
            </div>
            <div className="pt-2 border-t border-slate-100">
              <h4 className="text-xs font-bold uppercase tracking-wide text-slate-400 mb-1">UTM variables</h4>
              <p className="text-xs text-slate-500 mb-2">
                Applied only when the embedding URL has no value for that key - URL values always win.
              </p>
              <div className="grid grid-cols-2 gap-3">
                <Input label="utm_source" mono value={(settings.utm || {}).source || ''} onChange={(v) => patchUtm('source', v)} />
                <Input label="utm_medium" mono value={(settings.utm || {}).medium || ''} onChange={(v) => patchUtm('medium', v)} />
                <Input label="utm_campaign" mono value={(settings.utm || {}).campaign || ''} onChange={(v) => patchUtm('campaign', v)} />
                <Input label="utm_term" mono value={(settings.utm || {}).term || ''} onChange={(v) => patchUtm('term', v)} />
                <Input label="utm_content" mono value={(settings.utm || {}).content || ''} onChange={(v) => patchUtm('content', v)} />
              </div>
            </div>
            <div className="pt-2 border-t border-slate-100">
              <h4 className="text-xs font-bold uppercase tracking-wide text-slate-400 mb-2">Consent notice</h4>
              <label className="block">
                <span className="block text-xs font-semibold text-slate-600 mb-1">Per-form consent wording (optional)</span>
                <textarea
                  value={settings.consentText}
                  onChange={(e) => patchSettings('consentText', e.target.value)}
                  rows={2}
                  placeholder={globalSettings.consentText || 'By submitting your details you consent to being contacted.'}
                  className="w-full border border-slate-300 rounded-lg px-3 py-2 text-sm"
                />
              </label>
              <span className="block text-[11px] text-slate-400 mt-1">
                Leave blank to use the global default (Settings in the top nav). Shown under the submit button on every form.
              </span>
            </div>
            <div className="pt-2">
              <h4 className="text-xs font-bold uppercase tracking-wide text-slate-400 mb-2">Anti-spam (Turnstile)</h4>
              <Check label="Enable Cloudflare Turnstile" checked={!!settings.turnstile.enabled} onChange={(v) => patchTs('enabled', v)} hint="Free, invisible bot check. Strongly recommended on public forms." />
              {settings.turnstile.enabled && (
                <div className="mt-2">
                  <Input label="Turnstile site key" value={settings.turnstile.siteKey} onChange={(v) => patchTs('siteKey', v)} mono hint="Create one at dash.cloudflare.com → Turnstile. Secret goes in the TURNSTILE_SECRET env var." />
                </div>
              )}
            </div>
          </div>

          <div className="space-y-4">
            <div className="bg-white border border-slate-200 rounded-xl p-5">
              <h3 className="text-sm font-bold mb-2">Submit webhook</h3>
              <p className="text-xs text-slate-500 mb-3">
                A fixed JSON payload posts here on every successful submission — fire-and-forget, so it can
                never affect the visitor. Leave the URL blank to use the global default in Settings.
              </p>
              <Input label="Webhook URL (optional)" value={settings.submitWebhook.url} onChange={(v) => patchSubmitWebhook('url', v)} mono hint="https only." />
              <div className="mt-3">
                <Input label="Webhook token (optional)" value={settings.submitWebhook.token} onChange={(v) => patchSubmitWebhook('token', v)} mono hint="Sent as Authorization: Bearer <token>." />
              </div>
              <div className="flex items-center gap-3 mt-3">
                <button
                  onClick={runWebhookTest}
                  disabled={!!(whTest && whTest.loading)}
                  className="text-xs font-semibold text-teal-700 hover:text-teal-900 disabled:opacity-40"
                >
                  {whTest && whTest.loading ? 'Sending…' : 'Send test payload'}
                </button>
                {whTest && !whTest.loading && (
                  <span className={`text-xs ${whTest.ok ? 'text-emerald-700' : 'text-red-600'}`}>
                    {whTest.ok ? `OK — receiver answered ${whTest.status}` : `Failed — ${whTest.error || ('status ' + whTest.status)}`}
                  </span>
                )}
              </div>
              <span className="block text-[11px] text-slate-400 mt-1">Tests the URL above, or the global default when blank.</span>
            </div>

            <div className="bg-white border border-slate-200 rounded-xl p-5">
              <h3 className="text-sm font-bold mb-3">Notifications (webhooks)</h3>
              <p className="text-xs text-slate-500 mb-3">
                Each submission POSTs JSON to every webhook below. Point a Make.com webhook here to send email / update sheets / CRM.
              </p>
              <div className="space-y-2">
                {!notifications.length && <p className="text-xs text-slate-400">No webhooks configured.</p>}
                {notifications.map((n, i) => (
                  <div key={i} className="flex gap-2 items-center">
                    <input
                      value={n.label || ''}
                      onChange={(e) => patchNotification(i, { label: e.target.value })}
                      placeholder="Label (e.g. Make — email sales)"
                      className="w-40 border border-slate-300 rounded-lg px-2.5 py-1.5 text-xs"
                    />
                    <input
                      value={n.url || ''}
                      onChange={(e) => patchNotification(i, { url: e.target.value })}
                      placeholder="https://hook.make.com/…"
                      className="flex-1 border border-slate-300 rounded-lg px-2.5 py-1.5 text-xs font-mono"
                    />
                    <button
                      onClick={async () => {
                        if (!n.url) return alert('Add a URL first.');
                        setNotifTest(i, 'Sending…');
                        try {
                          const res = await api.testWebhook({ kind: 'notification', url: n.url, form_slug: slug });
                          setNotifTest(i, res.ok ? `OK ${res.status}` : `${res.status || 'error'}: ${(res.error || res.response || '').slice(0, 160)}`);
                        } catch (err) {
                          setNotifTest(i, 'Failed: ' + (err && err.message ? err.message : err));
                        }
                      }}
                      className="text-[11px] font-semibold text-teal-700 hover:text-teal-900 whitespace-nowrap"
                      title="Send a sample notification payload"
                    >
                      {notifTest[i] || 'Test'}
                    </button>
                    <button onClick={() => setNotifications((prev) => prev.filter((_, j) => j !== i))} className="text-slate-300 hover:text-red-500" title="Remove">
                      <svg width="14" height="14" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="2"><path d="M5 5l10 10M15 5L5 15" /></svg>
                    </button>
                  </div>
                ))}
              </div>
              <button
                onClick={() => setNotifications((prev) => [...prev, { label: '', url: '' }])}
                className="mt-3 text-xs font-semibold text-teal-700 hover:text-teal-900"
              >
                + Add webhook
              </button>
            </div>

            <div className="bg-white border border-slate-200 rounded-xl p-5">
              <h3 className="text-sm font-bold mb-2">Form details</h3>
              <Input label="Slug" value={slug} onChange={(v) => setSlug(v.toLowerCase().replace(/[^a-z0-9-]/g, ''))} mono hint="Used in the embed. Changing it after publish breaks existing embeds." />
              <div className="text-xs text-slate-400 mt-2">Created forms start as <b>draft</b>. Publish when ready — the widget only loads published forms.</div>
            </div>

            <div className="bg-white border border-red-100 rounded-xl p-5">
              <h3 className="text-sm font-bold text-red-700 mb-2">Danger zone</h3>
              <button onClick={removeForm} className="text-sm text-red-600 border border-red-200 rounded-lg px-3 py-1.5 hover:bg-red-50">
                Delete form + submissions
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ANALYTICS */}
      {tab === 'analytics' && <Analytics formId={formId} />}

      {/* SUBMISSIONS */}
      {tab === 'submissions' && (
        <div className="bg-white border border-slate-200 rounded-xl overflow-hidden">
          <div className="px-4 py-3 border-b border-slate-100 flex items-center gap-3">
            <span className="text-sm font-semibold">{subs.total} submission{subs.total === 1 ? '' : 's'}</span>
            <button onClick={loadSubmissions} className="text-xs font-semibold text-teal-700 hover:text-teal-900">Refresh</button>
            <button onClick={() => api.exportCsv(formId)} className="text-xs font-semibold text-teal-700 hover:text-teal-900 ml-auto">
              Export CSV
            </button>
          </div>
          <div className="px-4 py-2 border-b border-slate-100 bg-slate-50/60">
            <button onClick={() => setShowBlocklist(!showBlocklist)} className="text-xs font-semibold text-slate-600">
              Blocked senders ({blocklist.length}) {showBlocklist ? '\u25be' : '\u25b8'}
            </button>
            {showBlocklist && (
              <div className="mt-2 space-y-1">
                {!blocklist.length && <div className="text-xs text-slate-400">Nothing blocked.</div>}
                {blocklist.map((b) => (
                  <div key={b.id} className="flex items-center gap-3 text-xs">
                    <span className="text-slate-500 w-12 shrink-0">{b.kind}</span>
                    <span className="font-mono text-slate-800 break-all">{b.value}</span>
                    <button
                      onClick={async (ev) => { ev.stopPropagation(); await api.removeBlocklist(b.id); loadSubmissions(); }}
                      className="ml-auto text-[11px] font-semibold text-red-600 hover:text-red-800"
                    >
                      Remove
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>
          {subsLoading && <div className="p-6 text-sm text-slate-500">Loading…</div>}
          {!subsLoading && !subs.rows.length && (
            <div className="p-10 text-center text-sm text-slate-400">
              No submissions yet. Publish the form and embed it on your site — submissions land here instantly.
            </div>
          )}
          {!subsLoading && subs.rows.length > 0 && (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-left text-xs uppercase tracking-wide text-slate-500 border-b border-slate-200 bg-slate-50">
                    <th className="px-4 py-2.5">When</th>
                    {mainFields.map((f) => (
                      <th key={f.name} className="px-4 py-2.5">{f.label}</th>
                    ))}
                    <th className="px-4 py-2.5">Source</th>
                    <th className="px-4 py-2.5 text-right">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {subs.rows.map((r) => {
                    const utm = r.utm || {};
                    const source = [r.page_url ? 'page' : '', utm.source ? `utm:${utm.source}` : '', utm.gclid ? 'gclid' : '', utm.fbclid ? 'fbclid' : ''].filter(Boolean).join(' · ') || '—';
                    return (
                      <React.Fragment key={r.id}>
                        <tr onClick={() => setOpenRow(openRow === r.id ? null : r.id)} className="border-b border-slate-100 hover:bg-slate-50/60 cursor-pointer">
                          <td className="px-4 py-2.5 text-xs text-slate-500 whitespace-nowrap">
                            {openRow === r.id ? '\u25be ' : '\u25b8 '}{fmtDate(r.created_at)}
                            {r.spam ? <span className="ml-2 text-[10px] font-bold text-amber-700">SPAM</span> : null}
                            {r.email_verified ? <span className="ml-2 text-[10px] font-bold text-emerald-700">EMAIL VERIFIED</span> : null}
                            {r.phone_verified ? <span className="ml-2 text-[10px] font-bold text-emerald-700">PHONE VERIFIED</span> : null}
                          </td>
                          {mainFields.map((f) => {
                            if (f.type === 'full_name') {
                              const full = (f.parts || [])
                                .map((p) => r.data[p.name])
                                .filter((v) => v !== undefined && v !== null && String(v).trim() !== '')
                                .join(' ');
                              return (
                                <td key={f.name} className="px-4 py-2.5 max-w-52 truncate">{full}</td>
                              );
                            }
                            const raw = r.data[f.name];
                            const opts = f.options || [];
                            const labelOf = (v) => {
                              const hit = opts.find((o) => String(o.value) === String(v));
                              return hit ? hit.label : v;
                            };
                            const shown = Array.isArray(raw)
                              ? raw.map(labelOf).join('; ')
                              : raw === undefined || raw === null
                                ? ''
                                : labelOf(raw);
                            return (
                              <td key={f.name} className="px-4 py-2.5 max-w-52 truncate">{String(shown)}</td>
                            );
                          })}
                          <td className="px-4 py-2.5 text-xs text-slate-400 max-w-48 truncate">{source}</td>
                          <td className="px-4 py-2.5 text-right whitespace-nowrap">
                            <button
                              onClick={async (ev) => {
                                ev.stopPropagation();
                                if (!window.confirm("Mark as spam and block this email + IP?")) return;
                                await api.markSpam(formId, r.id);
                                loadSubmissions();
                              }}
                              className="text-[11px] font-semibold text-amber-700 hover:text-amber-900 mr-3"
                            >
                              Spam
                            </button>
                            <button
                              onClick={async (ev) => {
                                ev.stopPropagation();
                                if (!window.confirm("Delete this submission? This cannot be undone.")) return;
                                await api.deleteSubmission(formId, r.id);
                                loadSubmissions();
                              }}
                              className="text-[11px] font-semibold text-red-600 hover:text-red-800"
                            >
                              Delete
                            </button>
                          </td>
                        </tr>
                        {openRow === r.id && (
                          <tr className="bg-slate-50/70 border-b border-slate-100">
                            <td colSpan={mainFields.length + 3} className="px-4 py-4">
                              <div className="grid sm:grid-cols-2 gap-x-8 gap-y-3 text-xs">
                                {subsFields.map((f) => {
                                  const raw = r.data[f.name];
                                  const opts = f.options || [];
                                  const labelOf = (v) => {
                                    const hit = opts.find((o) => String(o.value) === String(v));
                                    return hit ? hit.label : v;
                                  };
                                  const shown = Array.isArray(raw)
                                    ? raw.map(labelOf).join('; ')
                                    : raw === undefined || raw === null ? '' : labelOf(raw);
                                  return (
                                    <div key={f.name} className="flex gap-2">
                                      <span className="text-slate-500 w-32 shrink-0">{f.label}</span>
                                      <span className="text-slate-800 break-words">{String(shown) || '\u2014'}</span>
                                    </div>
                                  );
                                })}
                                <div className="flex gap-2"><span className="text-slate-500 w-32 shrink-0">Page</span><span className="break-all">{r.page_url || '\u2014'}</span></div>
                                <div className="flex gap-2"><span className="text-slate-500 w-32 shrink-0">Referrer</span><span className="break-all">{r.referrer || '\u2014'}</span></div>
                                <div className="flex gap-2"><span className="text-slate-500 w-32 shrink-0">UTM</span><span className="break-all">{Object.keys(r.utm || {}).length ? JSON.stringify(r.utm) : '\u2014'}</span></div>
                                <div className="flex gap-2"><span className="text-slate-500 w-32 shrink-0">IP / UA</span><span className="break-all">{r.ip || '\u2014'} {'\u00b7'} {(r.ua || '\u2014').slice(0, 80)}</span></div>
                              </div>
                            </td>
                          </tr>
                        )}
                        <tr className="hidden">
                          <td colSpan={99} className="px-4 pb-3">
                            <pre className="text-[11px] bg-slate-50 rounded-lg p-3 overflow-x-auto">{JSON.stringify({ data: r.data, page_url: r.page_url, referrer: r.referrer, utm, ip: r.ip }, null, 2)}</pre>
                          </td>
                        </tr>
                      </React.Fragment>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

      {/* EMBED */}
      {tab === 'embed' && (
        <div className="bg-white border border-slate-200 rounded-xl p-6 max-w-2xl space-y-4">
          <div>
            <h3 className="text-sm font-bold mb-1">Add this form to any website</h3>
            <p className="text-xs text-slate-500">
              Put the div where you want the form, then load the widget script once per page (anywhere). It works on static sites,
              WordPress, Shopify — anywhere. No iframe, so your GTM / pixels on the page see every submit.
            </p>
          </div>
          <div className="relative">
            <pre className="bg-slate-900 text-slate-100 text-xs rounded-xl p-4 overflow-x-auto">{embedSnippet}</pre>
            <button
              onClick={() => { navigator.clipboard.writeText(embedSnippet); alert('Copied!'); }}
              className="absolute top-2 right-2 text-[11px] font-semibold bg-white/10 hover:bg-white/20 text-white rounded-md px-2 py-1"
            >
              Copy
            </button>
          </div>
          <div className="text-xs text-slate-500 space-y-1">
            <p>• The widget fetches <span className="font-mono">/api/forms/{slug}</span> and renders the published form.</p>
            <p>• <b>Multi-page forms:</b> if the form has more than one page, visitors move through it with Next / Back. Each page validates before advancing.</p>
            <p>• <b>URL prefill works out of the box:</b> any field with a prefill param reads it from the page URL (e.g. <span className="font-mono">?fsuburb=MOUNT+COTTON</span>).</p>
            <p>• Submissions POST to D1, fire your webhooks, and push the dataLayer event (if set) for GTM / Facebook Pixel.</p>
            <p>• Status is currently <b>{status}</b> — the widget shows nothing until this form is published.</p>
          </div>
        </div>
      )}
    </div>
  );
}
