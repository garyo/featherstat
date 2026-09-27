import { type Browser, expect, type Locator, type Page } from '@playwright/test';

/**
 * The few helpers every spec wants, and nothing more. Not a page-object layer:
 * the URL IS the view state (`apps/web/src/lib/state.ts`), so a spec opens what
 * it means by naming it, and clicks only the thing it is actually testing.
 *
 * Selectors here lean on the class names `apps/web/src/ownership.guard.ts`
 * already pins — those are a contract with one owner, so a spec depending on
 * them cannot silently drift. Everything else asserts on text a person reads.
 */

export interface ViewState {
  site?: number | 'all';
  range?: string;
  view?: 'dash' | 'journeys' | 'realtime' | 'settings' | 'detail';
  dash?: string;
  /** Raw `f=` entries, exactly as a shared link would carry them. */
  filters?: readonly string[];
  detail?: string;
}

/** Opens a view by URL and waits for the shell — never a click-path to get there. */
export async function openView(page: Page, state: ViewState = {}): Promise<void> {
  const params = new URLSearchParams();
  if (state.range !== undefined) params.set('range', state.range);
  if (state.site !== undefined) params.set('site', String(state.site));
  if (state.view !== undefined) params.set('view', state.view);
  if (state.dash !== undefined) params.set('dash', state.dash);
  if (state.detail !== undefined) params.set('d', state.detail);
  for (const filter of state.filters ?? []) params.append('f', filter);
  const query = params.toString();
  await page.goto(query === '' ? '/' : `/?${query}`);
  await expect(page.locator('header.top')).toBeVisible();
}

/** A dashboard card by its heading — the name a reader would point at. */
export function card(page: Page, title: string | RegExp): Locator {
  return page.locator('.card').filter({ has: page.getByRole('heading', { name: title }) });
}

/** The filter row's chips, in order, as their text reads. */
export async function chips(page: Page): Promise<string[]> {
  const labels = page.locator('.filters .fchip .fchip-label');
  return (await labels.allTextContents()).map((text) => text.trim());
}

/**
 * Waits for the batch to have painted. Both frames, because a widget whose
 * registry entry says `frame: 'wide'` is NOT given the `card` class
 * (`widgets/WidgetGrid.svelte`) — the all-sites cards are the standing example.
 */
export async function dashboardReady(page: Page): Promise<void> {
  await expect(page.locator('.card, .wide').first()).toBeVisible();
  await expect(page.getByText('Loading…')).toHaveCount(0);
}

/**
 * Every string a stringification bug leaves on screen. `null`/`undefined` are
 * word-bounded because "Nullable" and legitimate prose would otherwise match;
 * `[object` needs no such care, since nothing says it on purpose.
 */
export const NONSENSE = /\[object |\bundefined\b|\bNaN\b|\bnull\b/;

/** The visible text of the page, as a reader sees it. */
export async function visibleText(page: Page): Promise<string> {
  return (await page.locator('body').innerText()).trim();
}

/**
 * A browser with no session — someone opening a link they were sent. Said out
 * loud because `browser.newContext()` inside a test inherits the project's
 * `storageState`, which here is the admin's session.
 */
export async function stranger(browser: Browser): Promise<Page> {
  const context = await browser.newContext({ storageState: { cookies: [], origins: [] } });
  return context.newPage();
}
