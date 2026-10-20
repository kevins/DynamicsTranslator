// Everything the rest of the app needs to know about the environment it runs in.

import { Http, guid, isGuid, isLogicalName } from './http';
import { lcidName } from './lcid';
import type { Language, Lcid } from './model';

export interface Ctx {
  http: Http;
  /**
   * Xrm of the page shown now (null on pages without the client API, e.g. the maker portal shell). Read on every use:
   * UCI gives another table's form an Xrm of its own (LIVE-FINDINGS 95), so the one of the first page would go on
   * describing that page.
   */
  readonly xrm: any;
  origin: string;
  /** Short organization name, e.g. "contoso" (the first label of contoso.crm.dynamics.com). */
  org: string;
  orgId: string;
  /** Production, Sandbox, Developer, Trial, Default... ('' if unknown). */
  envType: string;
  userId: string;
  /** Organization base language. */
  base: Lcid;
  /** The user's UI language when the translator started, as saved on the server (not the client's cached copy). */
  user: Lcid;
  /** Provisioned languages, base language first, then by name. */
  langs: Language[];
  version: string;
}

/**
 * Finds the Xrm object on this window or a same-origin frame (classic web client). A frame of another site (an
 * embedded page, a web resource elsewhere) can't be looked into: it is skipped, never the end of the search.
 */
export function findXrm(): any {
  const w = window as any;
  if (w.Xrm?.Utility?.getGlobalContext) return w.Xrm;
  let frames: HTMLIFrameElement[] = [];
  try {
    frames = Array.from(document.querySelectorAll('iframe'));
  } catch {
    frames = [];
  }
  for (const f of frames)
    try {
      const x = (f.contentWindow as any)?.Xrm;
      if (x?.Utility?.getGlobalContext && f.style.visibility !== 'hidden') return x;
    } catch {
      /* a frame of another site */
    }
  return w.Xrm || null;
}

/**
 * Whether the record shown has unsaved changes: Xrm.Page.data.getIsDirty(), else its entity's (the documented
 * formContext.data.entity.getIsDirty). False on a page without a record (no client API, a page context of another page
 * type, no form data or form data without a record: a list, a dashboard); null when there is a record but it can't be
 * told (the call throws, answers no yes or no, or neither exists): a caller about to throw changes away asks as if it had.
 */
export function recordDirty(xrm: any): boolean | null {
  let type = '';
  try {
    type = String(xrm?.Utility?.getPageContext?.()?.input?.pageType || '').toLowerCase();
  } catch {
    type = '';
  }
  if (type && type !== 'entityrecord') return false;
  try {
    const d = xrm?.Page?.data;
    if (!d) return false;
    const v = typeof d.getIsDirty === 'function' ? d.getIsDirty() : typeof d.entity?.getIsDirty === 'function' ? d.entity.getIsDirty() : d.entity ? null : false;
    return typeof v === 'boolean' ? v : null;
  } catch {
    return null;
  }
}

/**
 * Reads the page's Xrm now, else the last one it saw: while UCI swaps it during a navigation there may briefly be none,
 * and the first page's would make that page look shown again.
 */
export function liveXrm(first: any): () => any {
  let seen = first;
  return () => (seen = findXrm() ?? seen);
}

export async function createCtx(): Promise<Ctx> {
  const xrm = findXrm();
  const now = liveXrm(xrm);
  const gc = xrm?.Utility?.getGlobalContext?.();
  const origin = (gc?.getClientUrl?.() || location.origin).replace(/\/+$/, '');
  const version = String(gc?.getVersion?.() || '9.2');
  const m = /^(\d+)\.(\d+)/.exec(version);
  const http = new Http(origin, m && Number(m[1]) === 9 && Number(m[2]) < 2 ? `${m[1]}.${m[2]}` : '9.2');

  const [who, provisioned, cur] = await Promise.all([
    http.get('WhoAmI()'),
    http.get('RetrieveProvisionedLanguages()'),
    http.get("RetrieveCurrentOrganization(AccessType=Microsoft.Dynamics.CRM.EndpointAccessType'Default')").catch(() => null),
  ]);
  const [orgRow, ui] = await Promise.all([
    http.get(`organizations(${guid(who.OrganizationId)})?$select=languagecode,name`).catch(() => null),
    // The user's language as saved, read past every cache: the client's own copy (userSettings) can be a stale boot
    // answer (LIVE-FINDINGS 82, 97), and a switch is put back to this one.
    http.get(`usersettingscollection(${guid(who.UserId)})?$select=uilanguageid`, { headers: { 'If-None-Match': 'null', 'x-ms-sw-skipcache': '1' } }).catch(() => null),
  ]);
  const base: Lcid = Number(orgRow?.languagecode || gc?.organizationSettings?.languageId || 1033);
  const user: Lcid = Number(ui?.uilanguageid) || Number(gc?.userSettings?.languageId || base);
  const codes: number[] = (provisioned?.RetrieveProvisionedLanguages || [base]).map(Number);
  if (!codes.includes(base)) codes.unshift(base);
  const langs: Language[] = codes
    .map((lcid) => ({ lcid, name: lcidName(lcid), isBase: lcid === base }))
    .sort((a, b) => (a.isBase ? -1 : b.isBase ? 1 : a.name.localeCompare(b.name)));

  const detail = cur?.Detail || {};
  const typeMap: Record<string, string> = {
    Customer: 'Production',
    CustomerTest: 'Sandbox',
    CustomerFreeTest: 'Trial',
    CustomerPreview: 'Preview',
    Developer: 'Developer',
    Trial: 'Trial',
    Default: 'Default',
    Teams: 'Teams',
  };
  return {
    http,
    get xrm() {
      return now();
    },
    origin,
    org: detail.UrlName || new URL(origin).hostname.split('.')[0],
    orgId: guid(who.OrganizationId),
    envType: typeMap[detail.OrganizationType] ?? String(detail.OrganizationType || ''),
    userId: guid(who.UserId),
    base,
    user,
    langs,
    version,
  };
}

/** Information about the page the user is looking at. */
export interface PageInfo {
  type: 'entityrecord' | 'entitylist' | 'dashboard' | 'apps' | 'other';
  entity: string;
  recordId: string;
  formId: string;
  viewId: string;
  viewType: 'savedquery' | 'userquery' | '';
  dashboardId: string;
  appId: string;
}

export function pageInfo(xrm: any): PageInfo {
  let pc: any = {};
  try {
    pc = xrm?.Utility?.getPageContext?.()?.input || {};
  } catch {
    pc = {};
  }
  const qs = new URLSearchParams(location.search);
  const raw = String(pc.pageType || qs.get('pagetype') || '').toLowerCase();
  const type = (['entityrecord', 'entitylist', 'dashboard', 'apps'].includes(raw) ? raw : 'other') as PageInfo['type'];
  let formId = '';
  try {
    formId = xrm?.Page?.ui?.formSelector?.getCurrentItem?.()?.getId?.() || '';
  } catch {
    formId = '';
  }
  const vt = String(pc.viewType || qs.get('viewtype') || '');
  // The address is anyone's link: a table name or an id that isn't one goes nowhere near a URL ('' = none).
  const id = (v: unknown): string => (isGuid(guid(v)) ? guid(v) : '');
  const entity = String(pc.entityName || qs.get('etn') || '');
  return {
    type,
    entity: isLogicalName(entity) ? entity : '',
    recordId: id(pc.entityId || (type === 'entityrecord' ? qs.get('id') : '') || ''),
    formId: id(formId || pc.formId || qs.get('formid') || ''),
    viewId: id(pc.viewId || qs.get('viewid') || ''),
    viewType: vt === 'userquery' || vt === '4230' ? 'userquery' : vt ? 'savedquery' : '',
    dashboardId: id(pc.dashboardId || (type === 'dashboard' ? qs.get('id') : '') || ''),
    appId: id(qs.get('appid') || ''),
  };
}
