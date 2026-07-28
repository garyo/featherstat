import type { NtfyRule, NtfySettingsInput, NtfySettingsView } from '@analytics/shared';
import type { AdminIssue } from './admin.ts';

/**
 * The pure half of the notification settings pane (docs/01 R16): the shape the
 * form edits, the body it PUTs, and where the server's validation issues land.
 * `NtfyPanel.svelte` owns the DOM and the requests; everything decidable
 * without either lives here, where it is testable.
 */

/** One rule row while it is edited: all strings, so the inputs bind straight to it. */
export interface RuleDraft {
  /** Site id as text; '' is "any site". */
  site: string;
  eventCategory: string;
  eventAction: string;
  label: string;
}

export interface NtfyDraft {
  url: string;
  topic: string;
  /** A replacement token; '' leaves the stored one alone (the GET never echoes it). */
  token: string;
  /** The only way to forget a stored token — an empty box means "unchanged". */
  clearToken: boolean;
  rules: RuleDraft[];
}

/** What `PUT /api/admin/ntfy` gets, plus which draft row each sent rule came from. */
export interface NtfyRequest {
  body: NtfySettingsInput;
  /** Draft row index of each rule in `body.rules` — blank rows never travel. */
  rows: number[];
}

export interface NtfyErrors {
  url?: string;
  topic?: string;
  /** By draft row index, so the message renders under the row it is about. */
  rules: Map<number, string>;
  /** Whatever named no field — shown once, above the form. */
  form?: string;
}

export function emptyRule(): RuleDraft {
  return { site: '', eventCategory: '', eventAction: '', label: '' };
}

export function draftFrom(view: NtfySettingsView): NtfyDraft {
  return {
    url: view.url ?? '',
    topic: view.topic ?? '',
    token: '',
    clearToken: false,
    rules: view.rules.map((rule) => ({
      site: rule.site === undefined ? '' : String(rule.site),
      eventCategory: rule.eventCategory ?? '',
      eventAction: rule.eventAction ?? '',
      label: rule.label ?? '',
    })),
  };
}

/**
 * A row the operator never filled in is not a rule: it is dropped rather than
 * sent as the "constrains nothing" mistake the server rightly refuses — an
 * empty row is what an unfinished edit looks like, not a request to notify on
 * every hit of every site.
 */
export function settingsBody(draft: NtfyDraft): NtfyRequest {
  const rules: NtfyRule[] = [];
  const rows: number[] = [];
  draft.rules.forEach((row, index) => {
    const rule = ruleOf(row);
    if (rule === undefined) return;
    rules.push(rule);
    rows.push(index);
  });
  const body: NtfySettingsInput = { url: draft.url.trim(), topic: draft.topic.trim(), rules };
  // The three cases the API distinguishes: replace, clear, keep.
  if (draft.token !== '') body.token = draft.token;
  else if (draft.clearToken) body.token = null;
  return { body, rows };
}

/**
 * The server's zod issues, routed to the field that produced them. `fallback`
 * (the response's own message) is used only when nothing named a field, so a
 * refusal can never land silently.
 */
export function fieldErrors(
  issues: readonly AdminIssue[],
  rows: readonly number[],
  fallback: string,
): NtfyErrors {
  const errors: NtfyErrors = { rules: new Map() };
  for (const issue of issues) {
    const [field, index] = issue.path;
    if (field === 'url' && errors.url === undefined) errors.url = issue.message;
    else if (field === 'topic' && errors.topic === undefined) errors.topic = issue.message;
    else if (field === 'rules' && typeof index === 'number') {
      const row = rows[index];
      if (row !== undefined && !errors.rules.has(row)) errors.rules.set(row, issue.message);
    } else errors.form ??= issue.message;
  }
  if (errors.url === undefined && errors.topic === undefined && errors.rules.size === 0) {
    errors.form ??= fallback;
  }
  return errors;
}

function ruleOf(row: RuleDraft): NtfyRule | undefined {
  const rule: NtfyRule = {};
  const site = Number(row.site);
  if (row.site !== '' && Number.isInteger(site)) rule.site = site;
  const category = row.eventCategory.trim();
  if (category !== '') rule.eventCategory = category;
  const action = row.eventAction.trim();
  if (action !== '') rule.eventAction = action;
  const label = row.label.trim();
  if (label !== '') rule.label = label;
  return Object.keys(rule).length === 0 ? undefined : rule;
}
