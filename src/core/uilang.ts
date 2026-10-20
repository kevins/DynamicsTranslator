// Changes the signed-in user's Dynamics UI language for good: "Show Dynamics in <language>" in the translator's menus.
// Unlike LangSession's switches, nothing switches it back.
// Like Personal options it sets the UI and the help language (usersettings uilanguageid and helplanguageid) and
// leaves the locale (dates and numbers) alone; then it reads the language back from the database (Consistency:
// Strong, past every cache) until it says so. Showing it is the refresh's job (ui/refresh.ts): UCI keeps the old
// language's labels for minutes otherwise (LIVE-FINDINGS 78, 82).
// The menu sends the change through LangSession.adoptLanguage (ui/app.ts showIn): under the translator's language
// lock and switch window, and with its repair marker dropped; otherwise a translator in this or another tab puts the
// old one back. That marker and those locks are named here (markerKey, langLock, windowLock).

import { lcidName, tagLcid } from './lcid';
import type { Lcid } from './model';

/** The two calls this needs (the translator passes its Http). */
export interface UiApi {
  get(path: string, headers: Record<string, string>): Promise<any>;
  patch(path: string, body: unknown): Promise<unknown>;
}

/** The Dataverse answer was not 2xx; `status` 0 when it never came. */
export interface ApiError extends Error {
  status: number;
}

/** The switch was sent, but the read-backs never showed it (the page is refreshed anyway: it shows what the server has). */
export class NotConfirmed extends Error {}

/** Every read goes past the browser's cache, UCI's service worker and the replicas (core/http, langsession readUi). */
const FRESH = { Consistency: 'Strong', 'If-None-Match': 'null', 'x-ms-sw-skipcache': '1' };
const us = (userId: string) => `usersettingscollection(${userId.replace(/[{}]/g, '').toLowerCase()})`;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** The user's UI language as the database has it now. */
async function readUiLanguage(api: UiApi, userId: string): Promise<Lcid> {
  const r = await api.get(`${us(userId)}?$select=uilanguageid`, FRESH);
  const lcid = Number(r?.uilanguageid);
  if (!(lcid > 0)) throw new Error('Dataverse did not say which language your Dynamics is in.');
  return lcid;
}

/**
 * Sets the user's UI and help language to `lcid`, then reads it back until the database says so (up to `tries` reads,
 * a little longer apart each time). Throws the PATCH's error when it failed (nothing changed), NotConfirmed when the
 * reads never showed it.
 */
export async function setUiLanguage(api: UiApi, userId: string, lcid: Lcid, o: { tries?: number; sleep?: (ms: number) => Promise<unknown> } = {}): Promise<void> {
  try {
    await api.patch(us(userId), { uilanguageid: lcid, helplanguageid: lcid });
  } catch (e) {
    // Refused (400): a help language that can't be chosen. The UI language alone, as before the help language existed.
    if ((e as ApiError)?.status !== 400) throw e;
    await api.patch(us(userId), { uilanguageid: lcid });
  }
  const n = o.tries ?? 5;
  for (let i = 0; i < n; i++) {
    if ((await readUiLanguage(api, userId).catch(() => 0)) === lcid) return;
    if (i < n - 1) await (o.sleep ?? sleep)(250 * (i + 1));
  }
  throw new NotConfirmed(`Dataverse did not confirm the switch to ${lcidName(lcid)}.`);
}

/**
 * The language the page shows: the one `<html lang>` names when it is one of `langs`, else `fallback` (the page
 * context's). After a change made elsewhere the server and the page context already say the new language while UCI
 * still renders the old one for minutes (LIVE-FINDINGS 78): "the other language" is the one not on screen.
 */
export function shownLanguage(langs: readonly Lcid[], fallback: Lcid, tag = typeof document === 'undefined' ? '' : document.documentElement?.lang || ''): Lcid {
  const dom = tagLcid(tag);
  return dom && langs.includes(dom) ? dom : fallback;
}

/** The translator's repair marker of a temporary switch (core/langsession.ts); org and user ids lower case, no braces. */
export const markerKey = (org: string, user: string): string => `dxt:langrestore:${org}:${user}`;
/**
 * The Web Lock a translator holds for every operation that depends on the UI language, its switches and the
 * check after them included (core/langsession.ts `hold`).
 */
export const langLock = (org: string, user: string): string => `dxt:lang:${org}:${user}`;
/** The Web Lock a translator holds exclusively while it has the user switched for a moment (core/langsession.ts). */
export const windowLock = (org: string, user: string): string => `dxt:langwin:${org}:${user}`;
