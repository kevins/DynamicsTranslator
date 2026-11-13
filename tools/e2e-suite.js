// Live regression suite. Load after a dev build (window.__dxtDev) in a signed-in tab of the test org:
//   dist/bridge.html?f=e2e-bundle.js,e2e-suite.js&back=<page>   (providers + saver only), or
//   dist/bridge.html?f=translator.debug.js,e2e-suite.js&back=<page>   (full app, built with --dev)
// (<page>: an https page of the test org; tools/dev/bridge.html has no default.)
// Uses only test components (table new_dxttest, app "Translator Test App", BPF "bpf test" with backup); the account
// table and its main form are only read, to check that a managed solution's components are read-only. Kept test
// components the step 'form labels' creates when they are missing (and never deletes): the text column new_dxtremove
// ("DXT Remove" / "Retrait DXT") of new_dxttest, and new_dxttest's inactive main form "DXT e2e form labels".
// Every test edits through the translator, verifies with independent reads that only the edited language
// changed, then restores. A main form's field label is restored by giving its cell its own label key back (onTestKey),
// never by writing a text back. Some undo a published save from its journal entry, as Recent publishes does, and one
// makes a publish fail on purpose to check Try again. Set window.__dxtE2EWithRibbon = true first to include the
// classic-ribbon tests (~4 min); window.__dxtE2EOnly = ['<step>', …] runs only the steps named.
// Results: window.__dxtE2E = { running, log: [{ name, pass, info }], progress, keys } (keys: the test label keys made).
window.__dxtE2E = { running: true, log: [], progress: [], keys: [] };
(async () => {
  for (let i = 0; i < 80 && !window.__dxtDev?.ready && !window.__dxtDev?.app?.saver; i++) await new Promise((r) => setTimeout(r, 250));
  const d = window.__dxtDev;
  const { ctx, store, providers } = d;
  // A process's labels: loadBpf in the full app's registry (src/providers/index.ts), loadBpfLabels in the headless one's.
  const loadBpf = providers.loadBpf || providers.loadBpfLabels;
  const saver = d.app.saver;
  const api = ctx.http.api;
  const H = { Accept: 'application/json', 'If-None-Match': 'null', Consistency: 'Strong' };
  // no-store: the browser's HTTP cache can answer a language-sensitive GET with the other language's body
  // (LIVE-FINDINGS 84), and the checks must be independent reads.
  const get = async (u) => {
    const r = await fetch(api + u, { headers: { ...H, 'x-ms-sw-skipcache': '1' }, cache: 'no-store' });
    if (!r.ok) throw new Error(`${r.status} ${u}: ${(await r.text()).slice(0, 200)}`);
    return r.json();
  };
  const labelsOf = (L) => Object.fromEntries((L?.LocalizedLabels || []).map((l) => [l.LanguageCode, l.Label]));
  const loc = async (set, id, col) =>
    labelsOf((await get(`RetrieveLocLabels(EntityMoniker=@e,AttributeName=@a,IncludeUnpublished=@u)?@e=${encodeURIComponent(JSON.stringify({ '@odata.id': `${set}(${id})` }))}&@a='${col}'&@u=true`)).Label);
  const log = window.__dxtE2E.log;
  const ok = (name, cond, info) => log.push({ name, pass: !!cond, info: cond ? undefined : JSON.stringify(info).slice(0, 900) });
  const opts = (publish = false) => ({ signal: new AbortController().signal, publish, onProgress: (p) => window.__dxtE2E.progress.push(p.message) });
  const lo = { signal: new AbortController().signal, progress() {}, lang: d.lang };
  const res = (rep) => rep.results.map((r) => [r.outcome, r.message]);
  // Original value to restore: never a leftover from an earlier failed run.
  const orig = (v, fb) => (v && !/E2E/.test(v) ? v : fb);
  const tgt = (cur, t) => (cur === t ? t + ' 2' : t);
  async function editSave(key, lcid, text, publish = false) {
    store.set(key, lcid, text);
    const changes = store.changes((s) => s.key === key);
    if (!changes.length) return { saved: 0, conflicts: 0, errors: 0, results: [], noop: true };
    return saver.save(changes, opts(publish));
  }
  const blocked = (rep) => rep.saved === 0 && rep.results.length === 1 && rep.results[0].outcome !== 'saved';
  /** The check after a form write had nothing to say: no label dropped, none put back (providers/formxml.ts nothingElse). */
  const clean = (rep) => !rep.warning && !rep.notice;
  const E = 'new_dxttest';
  const only = window.__dxtE2EOnly;
  const step = async (name, fn) => {
    if (only && !only.includes(name)) return;
    try {
      await fn();
    } catch (e) {
      log.push({ name: name + ' EXCEPTION', pass: false, info: String((e && e.stack) || e).slice(0, 900) });
    }
  };
  const xmlDoc = (x) => new DOMParser().parseFromString(x, 'application/xml');
  const norm = (id) => String(id || '').replace(/[{}]/g, '').toLowerCase();
  const labelMap = (el) => Object.fromEntries([...(el?.querySelector(':scope > labels')?.children || [])].map((l) => [l.getAttribute('languagecode'), l.getAttribute('description')]));
  // The test components the steps use, found by their names: no id of the test environment is kept in this file.
  const findOne = async (u, what) => {
    const v = (await get(u)).value || [];
    if (v.length !== 1) throw new Error(`${what}: ${v.length} found`);
    return v[0];
  };
  const ids = {};
  const testIds = async () => {
    ids.view ??= (await findOne("savedqueries?$select=savedqueryid&$filter=name eq 'Active Translator Tests' and returnedtypecode eq 'new_dxttest'", 'the view "Active Translator Tests"')).savedqueryid;
    ids.command ??= (await findOne("appactions?$select=appactionid&$filter=startswith(name,'DxtApprove')", 'the command "DxtApprove"')).appactionid;
    ids.sitemap ??= (await findOne("sitemaps?$select=sitemapid&$filter=sitemapname eq 'Translator Test App'", 'the site map "Translator Test App"')).sitemapid;
    ids.bpf ??= (await findOne("workflows?$select=workflowid&$filter=name eq 'bpf test' and category eq 4 and type eq 1", 'the process "bpf test"')).workflowid;
    return ids;
  };

  // ---- Main-form field labels. A form read fills in its column's name where a cell has no label of its own
  // (LIVE-FINDINGS 103), and Dataverse keeps a cell's labels whatever a save leaves out (104): a text written back would
  // store a copy of the column's name where the label followed it. So a test that writes a main form's field label puts
  // its cell on a label key of its own first (onTestKey) and gives it its own key back after (105). ----
  const JH = { Accept: 'application/json', 'Content-Type': 'application/json' };
  const unpubDoc = async (id) => xmlDoc((await get(`systemforms(${id})/Microsoft.Dynamics.CRM.RetrieveUnpublished()?$select=formxml`)).formxml);
  const cellIn = (doc, id) => [...doc.getElementsByTagName('cell')].find((c) => norm(c.getAttribute('id')) === norm(id));
  const keyIn = (doc, id) => norm(cellIn(doc, id)?.getAttribute('labelid')) || null;
  /** The test table's main form by name ("Information"): the fixture form of 'form labels' is a second main form. */
  async function mainForm(name = 'Information') {
    const v = (await get(`systemforms?$select=formid&$filter=objecttypecode eq '${E}' and type eq 2 and name eq '${name}'`)).value;
    if (v.length !== 1) throw new Error(`${v.length} main forms of ${E} named "${name}", expected one`);
    return v[0].formid;
  }
  /** Publishes a table outside any language switch (LIVE-FINDINGS 62), again while Dataverse is busy with another publish. */
  const publishE = (entity = E) =>
    d.lang.quiet(async () => {
      for (let i = 0; ; i++) {
        const r = await fetch(api + 'PublishXml', { method: 'POST', headers: JH, body: JSON.stringify({ ParameterXml: `<importexportxml><entities><entity>${entity}</entity></entities></importexportxml>` }) });
        if (r.ok) return;
        if (i === 3) throw new Error(`PublishXml ${entity}: ${r.status} ${(await r.text()).slice(0, 200)}`);
        await new Promise((go) => setTimeout(go, 5000 * (i + 1)));
      }
    });
  /** A column's own cell in the body or header (src/core/column.ts columnCell; the zones a main form's save posts sparse). */
  const columnCell = (c) => {
    const ctl = c.querySelector(':scope > control');
    const df = (ctl?.getAttribute('datafieldname') || '').toLowerCase();
    const id = (ctl?.getAttribute('id') || '').toLowerCase().replace(/^header_/, '');
    return !!df && !c.closest('footer') && (!id || id === df || (id.startsWith(df) && /^\d+$/.test(id.slice(df.length))));
  };
  /**
   * A raw read-modify-write of a main form, for fixtures and test keys only: under the translator's lock (never inside a
   * language switch), every column cell of the body and header posted without labels as the translator posts them
   * (LIVE-FINDINGS 104: one posted as read would store the names a read fills in, 103), but `keep`'s; then `edit(doc)`.
   */
  const rawPatch = (formId, edit, keep) =>
    d.lang.hold(async () => {
      for (let i = 0; i < 3; i++) {
        const [u, p] = await Promise.all([get(`systemforms(${formId})/Microsoft.Dynamics.CRM.RetrieveUnpublished()?$select=formxml`), get(`systemforms(${formId})?$select=formid`)]);
        const doc = xmlDoc(u.formxml);
        for (const c of [...doc.getElementsByTagName('cell')]) if (columnCell(c) && norm(c.getAttribute('id')) !== norm(keep)) c.querySelector(':scope > labels')?.remove();
        edit(doc);
        // If-Match is checked against the published row (providers/formxml.ts).
        const r = await fetch(api + `systemforms(${formId})`, { method: 'PATCH', headers: { ...JH, 'If-Match': p['@odata.etag'] }, body: JSON.stringify({ formxml: new XMLSerializer().serializeToString(doc) }) });
        if (r.ok) return;
        if (r.status !== 412) throw new Error(`PATCH systemforms(${formId}): ${r.status} ${(await r.text()).slice(0, 200)}`);
      }
      throw new Error(`PATCH systemforms(${formId}): 412 three times`);
    });
  /**
   * Puts a cell on a label key of its own for a test's writes (LIVE-FINDINGS 105): its labels posted as read to a fresh
   * labelid, which stores its own labels and none of the column's names it shows (104). `restore()` gives the cell its
   * own key back (or none), posting no labels for it, so it shows its labels from before the test exactly (105), publishes
   * the table, and says whether the read shows that key again. A test key stays behind as label rows of no cell (107).
   */
  async function onTestKey(formId, cellId, entity = E) {
    const lid0 = keyIn(await unpubDoc(formId), cellId);
    const key = crypto.randomUUID();
    await rawPatch(formId, (doc) => cellIn(doc, cellId)?.setAttribute('labelid', `{${key}}`), cellId);
    window.__dxtE2E.keys.push(key);
    return {
      key,
      async restore() {
        await rawPatch(formId, (doc) => {
          const c = cellIn(doc, cellId);
          if (lid0) c?.setAttribute('labelid', `{${lid0}}`);
          else c?.removeAttribute('labelid');
        });
        await publishE(entity);
        return keyIn(await unpubDoc(formId), cellId) === lid0;
      },
    };
  }
  /** The store after a raw write: the form read again (and the table's columns, `cols`), so an edit is measured against the server's text. */
  async function refresh(formId, cols = false, langs = [1033, 1036]) {
    if (cols) store.add(await providers.loadTables(ctx, [E], new Set(['attribute']), lo));
    const fs = await providers.loadFormXml(ctx, [await providers.getForm(ctx, formId)], langs, lo);
    store.add(fs);
    return fs;
  }
  /** Records the form PATCH bodies the translator sends (through the Http its language session uses). */
  function capture() {
    const bodies = [];
    const b0 = ctx.http.batch;
    ctx.http.batch = function (parts, o) {
      for (const p of parts) if (p.method === 'PATCH' && /^systemforms\(/.test(p.url)) bodies.push(p.body.formxml);
      return b0.call(this, parts, o);
    };
    return { bodies, stop: () => (ctx.http.batch = b0) };
  }

  const pick = async (attr, cast, value) => {
    const r = await get(`EntityDefinitions(LogicalName='${E}')/Attributes(LogicalName='${attr}')/Microsoft.Dynamics.CRM.${cast}`);
    const o = r.OptionSet.Options ? r.OptionSet.Options.find((x) => x.Value === value) : value ? r.OptionSet.TrueOption : r.OptionSet.FalseOption;
    return labelsOf(o.Label);
  };
  const P = 'PicklistAttributeMetadata?$select=LogicalName&$expand=OptionSet($select=Options)';
  // Edits one label to a test value, checks that only that language changed, then restores it.
  async function roundTrip(name, key, read, fallback) {
    const b = await read();
    const t = tgt(b[1036], name + ' E2E');
    const rep = await editSave(key, 1036, t);
    const a = await read();
    const others = (x) => JSON.stringify(Object.entries(x).filter(([l]) => l !== '1036').sort());
    ok(`${name} fr saved`, rep.saved === 1 && a[1036] === t && others(a) === others(b), { rep: res(rep), b, a });
    const back = orig(b[1036], fallback);
    const rep2 = await editSave(key, 1036, back);
    ok(`${name} restored`, rep2.saved === 1 && (await read())[1036] === back, res(rep2));
  }

  await step('metadata', async () => {
    store.add(await providers.loadTables(ctx, [E], new Set(['entity', 'attribute', 'option', 'status', 'state', 'boolean', 'globaloption', 'globaloptionset', 'relationship']), lo));
    const attrUrl = `EntityDefinitions(LogicalName='${E}')/Attributes(LogicalName='new_priority')?$select=DisplayName,Description`;
    const b = labelsOf((await get(attrUrl)).DisplayName);
    const t = tgt(b[1036], 'Priorité E2E');
    const rep = await editSave(`attribute|${E}.new_priority|DisplayName`, 1036, t);
    const a = labelsOf((await get(attrUrl)).DisplayName);
    ok('attribute fr saved', rep.saved === 1 && a[1036] === t, { rep: res(rep), a });
    ok('attribute en untouched', a[1033] === b[1033], { b, a });
    await editSave(`attribute|${E}.new_priority|DisplayName`, 1036, orig(b[1036], 'Priorité'));

    const ob = await pick('new_priority', P, 100000001);
    const ot = tgt(ob[1036], 'Option E2E');
    const rep2 = await editSave(`option|${E}.new_priority|100000001|Label`, 1036, ot);
    const oa = await pick('new_priority', P, 100000001);
    ok('option fr saved', rep2.saved === 1 && oa[1036] === ot && oa[1033] === ob[1033], { rep: res(rep2), ob, oa });
    await editSave(`option|${E}.new_priority|100000001|Label`, 1036, orig(ob[1036], 'Moyenne'));

    // Metadata labels cannot be deleted in Dataverse: clearing writes the English text in their place (model.ts
    // standIn), so the page looks as it would without a translation; the French text is then put back.
    const hb = await pick('new_priority', P, 100000002);
    if (hb[1036] && hb[1036] !== hb[1033]) {
      const rep3 = await editSave(`option|${E}.new_priority|100000002|Label`, 1036, '');
      const ha = await pick('new_priority', P, 100000002);
      ok('option clear writes the English text (metadata)', rep3.saved === 1 && ha[1036] === hb[1033] && ha[1033] === hb[1033], { rep: res(rep3), hb, ha });
      const rep3b = await editSave(`option|${E}.new_priority|100000002|Label`, 1036, hb[1036]);
      ok('option restored', rep3b.saved === 1 && (await pick('new_priority', P, 100000002))[1036] === hb[1036], res(rep3b));
    }

    // A conflict: someone else saves the French description after it was loaded, with a write of their own carrying
    // every language as read (the base language too: a label PUT without it writes the French text there,
    // LIVE-FINDINGS 2), and the staged text must leave theirs. Then the description is put back exactly as read, in
    // every language, whatever happened. Only one with a French and a base-language text (an empty one counts) can be:
    // the write adds a language it has none in, and a metadata translation can't be removed again (LIVE-FINDINGS 31).
    const key = `attribute|${E}.new_name|Description`;
    const descUrl = `EntityDefinitions(LogicalName='${E}')/Attributes(LogicalName='new_name')`;
    const desc = async () => labelsOf((await get(`${descUrl}?$select=Description`)).Description);
    const putDesc = async (labels) => {
      const r = await fetch(api + descUrl, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json', 'MSCRM.MergeLabels': 'true' },
        body: JSON.stringify({ '@odata.type': 'Microsoft.Dynamics.CRM.StringAttributeMetadata', LogicalName: 'new_name', Description: { LocalizedLabels: Object.entries(labels).map(([l, t]) => ({ Label: t, LanguageCode: +l })) } }),
      });
      if (!r.ok) throw new Error(`${r.status} PUT ${descUrl}: ${(await r.text()).slice(0, 200)}`);
    };
    const exact = (x) => JSON.stringify(Object.entries(x).sort());
    const d0 = await desc();
    if (!(1036 in d0) || !(ctx.base in d0)) return ok('conflict check: new_name has a French and a base-language description', false, { d0, why: "the check's write would add the missing one, which can't be removed" });
    const theirs = 'Theirs ' + Date.now().toString(36);
    store.set(key, 1036, 'Mine');
    try {
      await putDesc({ ...d0, 1036: theirs });
      const rep4 = await saver.save(store.changes((s) => s.key === key), opts());
      const ca = await desc();
      ok('conflict detected, server kept', rep4.conflicts === 1 && ca[1036] === theirs, { rep: res(rep4), ca });
    } finally {
      store.resolve(key, 1036, false);
      store.revert(key, 1036);
      if (exact(await desc().catch(() => ({ unread: true }))) !== exact(d0)) await putDesc(d0);
      const back = await desc();
      ok('conflict description restored exactly, every language as read', exact(back) === exact(d0), { d0, back });
    }
  });

  await step('metadata2', async () => {
    // Table names (two properties in one PUT), Yes/No, status, state, global choice and relationship labels.
    const ent = async () => {
      const r = await get(`EntityDefinitions(LogicalName='${E}')?$select=DisplayName,DisplayCollectionName,Description`);
      return { dn: labelsOf(r.DisplayName), dc: labelsOf(r.DisplayCollectionName), de: labelsOf(r.Description) };
    };
    const e0 = await ent();
    const tn = tgt(e0.dn[1036], 'Test E2E');
    const tc = tgt(e0.dc[1036], 'Tests E2E');
    store.set(`entity|${E}|DisplayName`, 1036, tn);
    store.set(`entity|${E}|DisplayCollectionName`, 1036, tc);
    const rep = await saver.save(store.changes((s) => s.key.startsWith(`entity|${E}|`)), opts());
    const e1 = await ent();
    ok('entity names fr saved together', rep.saved === 2 && e1.dn[1036] === tn && e1.dc[1036] === tc && e1.dn[1033] === e0.dn[1033] && e1.dc[1033] === e0.dc[1033] && JSON.stringify(e1.de) === JSON.stringify(e0.de), { rep: res(rep), e0, e1 });
    store.set(`entity|${E}|DisplayName`, 1036, orig(e0.dn[1036], 'Test du traducteur'));
    store.set(`entity|${E}|DisplayCollectionName`, 1036, orig(e0.dc[1036], 'Tests du traducteur'));
    const rep2 = await saver.save(store.changes((s) => s.key.startsWith(`entity|${E}|`)), opts());
    ok('entity names restored', rep2.saved === 2, res(rep2));

    await roundTrip('boolean', `boolean|${E}.new_approved|1|Label`, () => pick('new_approved', 'BooleanAttributeMetadata?$select=LogicalName&$expand=OptionSet($select=TrueOption,FalseOption)', 1), 'Oui');
    await roundTrip('status', `status|${E}.statuscode|1|Label`, () => pick('statuscode', 'StatusAttributeMetadata?$select=LogicalName&$expand=OptionSet($select=Options)', 1), 'Actif');
    await roundTrip('state', `state|${E}.statecode|0|Label`, () => pick('statecode', 'StateAttributeMetadata?$select=LogicalName&$expand=OptionSet($select=Options)', 0), 'Actif');
    const gos = async () => get(`GlobalOptionSetDefinitions(Name='new_dxtglobal')`);
    await roundTrip('global option', 'globaloption|new_dxtglobal|100000000|Label', async () => labelsOf((await gos()).Options.find((o) => o.Value === 100000000).Label), 'Rouge');
    await roundTrip('global choice name', 'globaloptionset|new_dxtglobal|DisplayName', async () => labelsOf((await gos()).DisplayName), 'DXT Global FR');
    // Description-only edits send no Label (findings 35, 36): the label must stay exactly as it was. Base-language
    // round trips (a description that was empty is put back as a stored '', which shows as no description).
    for (const [name, key, read, fb] of [
      ['option description', `option|${E}.new_priority|100000000|Description`, async () => (await get(`EntityDefinitions(LogicalName='${E}')/Attributes(LogicalName='new_priority')/Microsoft.Dynamics.CRM.${P}`)).OptionSet.Options.find((o) => o.Value === 100000000), 'Lowest urgency'],
      ['state description', `state|${E}.statecode|0|Description`, async () => (await get(`EntityDefinitions(LogicalName='${E}')/Attributes(LogicalName='statecode')/Microsoft.Dynamics.CRM.StateAttributeMetadata?$select=LogicalName&$expand=OptionSet($select=Options)`)).OptionSet.Options.find((o) => o.Value === 0), ''],
    ]) {
      const o0 = await read();
      const d0 = labelsOf(o0.Description)[1033] || '';
      const t = tgt(d0, `${name} E2E`);
      const rep = await editSave(key, 1033, t);
      const o1 = await read();
      ok(`${name} saved, label kept`, rep.saved === 1 && labelsOf(o1.Description)[1033] === t && JSON.stringify(labelsOf(o1.Label)) === JSON.stringify(labelsOf(o0.Label)) && o1.DefaultStatus === o0.DefaultStatus, { rep: res(rep), o0: [o0.Label, o0.Description], o1: [o1.Label, o1.Description] });
      const back = orig(d0, fb);
      const rep2 = await editSave(key, 1033, back);
      ok(`${name} restored`, rep2.saved === 1 && (labelsOf((await read()).Description)[1033] || '') === back, res(rep2));
    }

    const rel = async () => (await get(`RelationshipDefinitions(SchemaName='new_dxttest_parent')/Microsoft.Dynamics.CRM.OneToManyRelationshipMetadata?$select=SchemaName,AssociatedMenuConfiguration,CascadeConfiguration`));
    const r0 = await rel();
    await roundTrip('relationship menu', 'relationship|new_dxttest_parent|Label', async () => labelsOf((await rel()).AssociatedMenuConfiguration.Label), 'Tests enfants');
    const r1 = await rel();
    const keep = (r) => JSON.stringify({ b: r.AssociatedMenuConfiguration.Behavior, g: r.AssociatedMenuConfiguration.Group, o: r.AssociatedMenuConfiguration.Order, c: r.CascadeConfiguration });
    ok('relationship other settings kept', keep(r0) === keep(r1), { r0: keep(r0), r1: keep(r1) });
  });

  await step('records', async () => {
    const FORM = await mainForm();
    for (const [kind, id, set, col, prop] of [
      ['view', (await testIds()).view, 'savedqueries', 'name', 'Name'],
      ['form', FORM, 'systemforms', 'name', 'Name'],
      ['command', (await testIds()).command, 'appactions', 'buttonlabeltext', 'Label'],
    ]) {
      store.add(await providers.loadRecords(ctx, kind, [id], lo));
      const key = `${kind}|${id}|${prop}`;
      const b = await loc(set, id, col);
      const t = tgt(b[1036], kind + ' FR E2E');
      const rep = await editSave(key, 1036, t);
      const a = await loc(set, id, col);
      ok(`${kind} fr saved`, rep.saved === 1 && a[1036] === t && a[1033] === b[1033], { rep: res(rep), b, a });
      const rep2 = await editSave(key, 1036, '');
      const c = await loc(set, id, col);
      ok(`${kind} clear removes fr`, rep2.saved === 1 && !(1036 in c) && c[1033] === b[1033], { rep: res(rep2), c });
      const back = orig(b[1036], '');
      if (back) {
        const rep3 = await editSave(key, 1036, back);
        ok(`${kind} restored`, rep3.saved === 1 && (await loc(set, id, col))[1036] === back, res(rep3));
      }
    }
  });

  await step('undo', async () => {
    // Uses the view loaded by 'records' and the column loaded by 'metadata'.
    const V = (await testIds()).view;
    const key = `view|${V}|Name`;
    const vl = () => loc('savedqueries', V, 'name');
    const b = await vl();
    const back = orig(b[1036], '');
    const t = tgt(b[1036], 'view FR E2E');
    await editSave(key, 1036, t);

    // Typed spaces remove the translation, and undoing that puts it back without a false conflict.
    const rep = await editSave(key, 1036, '   ');
    const c = await vl();
    ok('spaces clear removes fr', rep.saved === 1 && !(1036 in c) && c[1033] === b[1033], { rep: res(rep), c });
    const entry = saver.history().find((e) => e.id === rep.historyId);
    const u = entry ? await saver.undo(entry, opts()) : null;
    const d2 = await vl();
    ok('undo of a clear restores fr', u && u.saved === 1 && u.conflicts === 0 && d2[1036] === t && saver.history().find((e) => e.id === rep.historyId)?.undoneAt, { u: u && res(u), d2 });

    // Text typed into a cell while its save runs stays pending, measured against the value just saved.
    const pa = editSave(key, 1036, t + ' A');
    store.set(key, 1036, t + ' B');
    const ra = await pa;
    const pend = store.changes((s) => s.key === key);
    ok('edit typed during save survives', ra.saved === 1 && pend.length === 1 && pend[0].after === t + ' B' && pend[0].before === t + ' A' && (await vl())[1036] === t + ' A', { r: res(ra), pend: pend.map((p) => [p.before, p.after]) });
    store.revert(key, 1036);

    // Undoing a save that added translations: removable ones (view) are removed; metadata ones can't be, so they
    // get their English text (model.ts standIn: the page looks as it did without one). Every label is then as the
    // undo leaves it, so the entry is marked undone with nothing kept. The entry goes into Recent publishes first (and
    // is taken out again afterwards); the column's French name is put back after.
    const ak = `attribute|${E}.new_priority|DisplayName`;
    const attrUrl = `EntityDefinitions(LogicalName='${E}')/Attributes(LogicalName='new_priority')?$select=DisplayName`;
    const a0 = labelsOf((await get(attrUrl)).DisplayName);
    const fake = {
      id: 'e2e-' + Date.now().toString(36),
      at: Date.now(),
      published: false,
      items: [
        { key: ak, comp: 'attribute', kind: 'attribute', lcid: 1036, title: 'Priority', before: '', after: a0[1036] || '' },
        { key, comp: 'view', kind: 'view', lcid: 1036, title: 'View', before: '', after: t + ' A' },
      ],
    };
    const HK = `dxt:history:${ctx.orgId}:${ctx.userId}`;
    const hist = () => JSON.parse(localStorage.getItem(HK) || '[]');
    localStorage.setItem(HK, JSON.stringify([fake, ...hist()]));
    const u2 = await saver.undo(fake, opts());
    const marked = hist().find((e) => e.id === fake.id);
    localStorage.setItem(HK, JSON.stringify(hist().filter((e) => e.id !== fake.id)));
    const a1 = labelsOf((await get(attrUrl)).DisplayName);
    const v1 = await vl();
    const er = u2.results.find((r) => r.change.slot.key === ak);
    // A French name already worded as the English one is found as asked ('unchanged'): nothing to write.
    const asked = a0[1036] === a0[1033];
    ok('mixed undo: view removed, metadata gets its English text', u2.saved === (asked ? 1 : 2) && u2.errors === 0 && er?.outcome === (asked ? 'unchanged' : 'saved') && er?.change.standIn?.from === 'base' && !(1036 in v1) && a1[1036] === a0[1033] && a1[1033] === a0[1033], { u: res(u2), a0, a1, v1 });
    ok('mixed undo marked undone, nothing kept', !!marked?.undoneAt && !marked.kept, marked);
    if (a0[1036] && !asked) {
      const ra = await editSave(ak, 1036, a0[1036]);
      ok('column French name restored', ra.saved === 1 && labelsOf((await get(attrUrl)).DisplayName)[1036] === a0[1036], res(ra));
    }

    if (back) await editSave(key, 1036, back);
  });

  await step('formxml', async () => {
    const FORM = await mainForm();
    const fref = await providers.getForm(ctx, FORM);
    const fs = await providers.loadFormXml(ctx, [fref], [1033, 1036], lo);
    store.add(fs);
    const cell = fs.find((s) => s.kind === 'field' && s.ref?.controlId === 'new_name');
    const tab = fs.find((s) => s.kind === 'tab');
    const unpub = () => unpubDoc(FORM);
    const cellId = norm(cell.key.split('|')[2]);
    const tabId = norm(tab.key.split('|')[2]);
    const cellLabels = (doc) => labelMap(cellIn(doc, cellId));
    const tabLabels = (doc) => labelMap([...doc.getElementsByTagName('tab')].find((c) => norm(c.getAttribute('id')) === tabId));
    // The field on a label key of its own, given back after (onTestKey).
    const c0 = cellLabels(await unpub());
    const k = await onTestKey(FORM, cellId);
    try {
      await refresh(FORM, true);
      const cb = cellLabels(await unpub());
      const t = tgt(cb[1036], 'Nom E2E');
      const rep = await editSave(cell.key, 1036, t);
      const ca = cellLabels(await unpub());
      ok('cell fr saved', rep.saved === 1 && clean(rep) && ca[1036] === t && ca[1033] === cb[1033], { rep: res(rep), w: rep.warning, n: rep.notice, cb, ca });
      // Field labels can't be removed (LIVE-FINDINGS 37, 104): clearing writes what the field shows without one, its column's
      // French name, else its English name (LIVE-FINDINGS 42, model.ts standIn), as a text of the label's own on the same key.
      store.set(cell.key, 1036, '');
      const si = store.standIn(cell.key, 1036, ctx.base);
      const rep2 = await editSave(cell.key, 1036, '');
      const d2 = await unpub();
      const cc = cellLabels(d2);
      ok('cell clear writes its column name (field label), on the same key', !!si?.text && rep2.saved === 1 && clean(rep2) && cc[1036] === si.text && cc[1033] === cb[1033] && keyIn(d2, cellId) === k.key, { rep: res(rep2), w: rep2.warning, n: rep2.notice, cc, si, key: keyIn(d2, cellId), k: k.key });
    } finally {
      if (store.isEdited(cell.key, 1036)) store.revert(cell.key, 1036);
      const back = await k.restore();
      const c1 = cellLabels(await unpub());
      ok('cell restored (its own label key back, its labels as before)', back && JSON.stringify(c1) === JSON.stringify(c0), { c0, c1 });
      await refresh(FORM);
    }

    const tb = { ...tab.labels };
    const tt = tgt(tb[1036], 'Général E2E');
    const rep4 = await editSave(tab.key, 1036, tt);
    const us = await get(`usersettingscollection(${ctx.userId})?$select=uilanguageid`);
    ok('tab fr saved via language switch', rep4.saved === 1, { rep: res(rep4), tb });
    ok('ui language restored', us.uilanguageid === ctx.user, us);
    // Tab labels come back in the UI language only: read the English one under a brief switch when needed.
    const enTab = ctx.user === 1033 ? tabLabels(await unpub())[1033] : await d.lang.run(1033, async () => tabLabels(await unpub())[1033]).finally(() => d.lang.restore());
    ok('tab en kept', enTab === tb[1033], { tb, enTab });
    // Tab labels can't be removed either: clearing writes the English text (refused where it isn't loaded).
    store.set(tab.key, 1036, '');
    const ts = store.standIn(tab.key, 1036, ctx.base);
    const rep5 = await editSave(tab.key, 1036, '');
    ok('tab clear writes its English text (per-language label)', ts?.text ? rep5.saved === 1 && rep5.results[0].change.after === ts.text : blocked(rep5), { rep: res(rep5), ts });
    store.set(tab.key, 1036, tt);
    await editSave(tab.key, 1036, orig(tb[1036], 'Général'));
  });

  await step('undo after publish: form', async () => {
    // A form label saved and published, then undone from its journal entry with publishing on, as Recent publishes'
    // Undo does (saver.undo): its French text is back and published, the form's every other label as it was, the entry
    // marked undone, and the undo journaled and published (its Redo). On a test key (onTestKey), given back after: where its
    // French text was its column's name, the undo writes that name back as a text of its own there, the same text.
    const FORM = await mainForm();
    const fs = await providers.loadFormXml(ctx, [await providers.getForm(ctx, FORM)], [1033, 1036], lo);
    store.add(fs);
    const cell = fs.find((s) => s.kind === 'field' && s.ref?.controlId === 'new_name');
    const cellId = norm(cell.key.split('|')[2]);
    const unpub = () => unpubDoc(FORM);
    const cellLabels = (doc) => labelMap(cellIn(doc, cellId));
    /** Every label of the form: `<element>#<id>` -> its labels. */
    const allLabels = (doc) => Object.fromEntries([...doc.querySelectorAll('[id]')].filter((x) => x.querySelector(':scope > labels')).map((x) => [`${x.tagName}#${norm(x.getAttribute('id'))}`, labelMap(x)]));
    // Published once the published form's version is the unpublished one (the Publish dialog's own check, review.ts).
    const versions = async () => [(await get(`systemforms(${FORM})?$select=versionnumber`)).versionnumber, (await get(`systemforms(${FORM})/Microsoft.Dynamics.CRM.RetrieveUnpublished()?$select=versionnumber`)).versionnumber];
    const c0 = cellLabels(await unpub());
    const k = await onTestKey(FORM, cellId);
    try {
      await refresh(FORM, true);
      const d0 = await unpub();
      const b = cellLabels(d0);
      const all0 = allLabels(d0);
      const t = tgt(b[1036], 'Nom E2E');
      const rep = await editSave(cell.key, 1036, t, true);
      const e = saver.history().find((x) => x.id === rep.historyId);
      const [p1, u1] = await versions();
      ok('undo after publish (form): saved, published and journaled', rep.saved === 1 && clean(rep) && rep.published && !rep.publishError && e?.published && e.items.length === 1 && e.items[0].before === (b[1036] || '') && e.items[0].after === t && cellLabels(await unpub())[1036] === t && p1 === u1, { rep: res(rep), e, p1, u1 });
      if (!e) return;
      const u = await saver.undo(e, opts(true));
      const d1 = await unpub();
      const [p2, u2] = await versions();
      ok('undo after publish (form): the French text is back and published, every other label as it was', u.saved === 1 && clean(u) && u.errors === 0 && u.conflicts === 0 && u.published && !u.publishError && cellLabels(d1)[1036] === b[1036] && JSON.stringify(allLabels(d1)) === JSON.stringify(all0) && p2 === u2, { u: res(u), now: cellLabels(d1), b, p2, u2 });
      const marked = saver.history().find((x) => x.id === e.id);
      const redo = saver.history().find((x) => x.id === u.historyId);
      ok('undo after publish (form): the entry is undone, the undo journaled and published', !!marked?.undoneAt && !marked.kept && redo?.published && redo.items.length === 1 && redo.items[0].before === t && redo.items[0].after === (b[1036] || ''), { marked, redo });
    } finally {
      // The cell's own key back (published with it), whatever the test left on the test key.
      if (store.isEdited(cell.key, 1036)) store.revert(cell.key, 1036);
      const back = await k.restore();
      const c1 = cellLabels(await unpub());
      const [p, u] = await versions();
      ok('undo after publish (form) restored: its own label key back, its labels as before, published', back && JSON.stringify(c1) === JSON.stringify(c0) && p === u, { c0, c1, p, u });
      await refresh(FORM);
    }
  });

  await step('per-language cell', async () => {
    // A cell whose control is bound to no column keeps its labels per UI language, as a tab does (LIVE-FINDINGS 102):
    // the test form's timeline (its last tab, "Timeline test"). Loaded in each language as Dynamics keeps it (read here
    // while switched to it), its French label is written in French, its English one kept; then put back.
    const FORM = await mainForm();
    const fs = await providers.loadFormXml(ctx, [await providers.getForm(ctx, FORM)], [1033, 1036], lo);
    store.add(fs);
    const tl = fs.find((s) => s.kind === 'field' && /06375649-c143-495e-a496-c962e5b4488e/i.test(s.ref?.classid || ''));
    if (!tl) return ok('per-language cell: the test form has a timeline (its tab "Timeline test")', false, fs.filter((s) => s.kind === 'field').map((s) => s.ref?.controlId));
    const id = norm(tl.key.split('|')[2]);
    const unpub = async () => xmlDoc((await get(`systemforms(${FORM})/Microsoft.Dynamics.CRM.RetrieveUnpublished()?$select=formxml`)).formxml);
    const labelsIn = (doc) => labelMap([...doc.getElementsByTagName('cell')].find((c) => norm(c.getAttribute('id')) === id));
    /** Its label in `l` as Dynamics keeps it: read while switched to `l`. */
    const keptIn = async (l) => (l === ctx.user ? labelsIn(await unpub()) : labelsIn(await d.lang.run(l, unpub).finally(() => d.lang.restore())))[l] || '';
    const en0 = await keptIn(1033);
    const fr0 = await keptIn(1036);
    ok('per-language cell: loaded in each language as Dynamics keeps it', (tl.labels[1033] || '') === en0 && (tl.labels[1036] || '') === fr0, { loaded: tl.labels, en0, fr0 });
    const t = tgt(fr0, 'Chronologie E2E');
    try {
      const rep = await editSave(tl.key, 1036, t);
      ok('per-language cell: French saved in French, checked there; English kept', rep.saved === 1 && (await keptIn(1036)) === t && (await keptIn(1033)) === en0, { rep: res(rep) });
    } finally {
      const back = orig(fr0, 'Chronologie DXT');
      if ((await keptIn(1036)) !== back) {
        // Read again first: a write whose answer was lost commits nothing, and the store would take the text for unchanged.
        store.revert(tl.key, 1036);
        store.add(await providers.loadFormXml(ctx, [await providers.getForm(ctx, FORM)], [1033, 1036], lo));
        const rep2 = await editSave(tl.key, 1036, back);
        ok('per-language cell restored', rep2.saved === 1 && (await keptIn(1036)) === back, res(rep2));
      }
    }
  });

  await step('sitemap', async () => {
    const SM = (await testIds()).sitemap;
    store.add(await providers.loadSitemap(ctx, SM, lo));
    const xml = async () => xmlDoc((await get(`sitemaps/Microsoft.Dynamics.CRM.RetrieveUnpublishedMultiple()?$select=sitemapxml&$filter=sitemapid eq ${SM}`)).value[0].sitemapxml);
    const titles = (doc) => Object.fromEntries([...([...doc.getElementsByTagName('SubArea')].find((s) => s.getAttribute('Id') === 'dxt_sub2')?.getElementsByTagName('Title') || [])].map((t) => [t.getAttribute('LCID'), t.getAttribute('Title')]));
    const key = `subarea|${SM}|dxt_sub2|Title`;
    const b = titles(await xml());
    const t = tgt(b[1036], 'Tous E2E');
    const rep = await editSave(key, 1036, t);
    ok('sitemap fr saved', rep.saved === 1 && titles(await xml())[1036] === t, res(rep));
    const rep2 = await editSave(key, 1036, '');
    const a = titles(await xml());
    ok('sitemap clear removes fr', rep2.saved === 1 && !('1036' in a), { rep: res(rep2), a });
    ok('sitemap en kept', a[1033] === b[1033], { b, a });
    const back = orig(b[1036], '');
    if (back) await editSave(key, 1036, back);
  });

  // The names Dynamics keeps for a process on a record: the same request and parsing as bpf.ts (clientMetadataPart,
  // clientLabels); a copy where the bundle lacks them.
  const bpfPart = (entity, record, app) =>
    providers.clientMetadataPart?.(entity, norm(record), norm(app)) ?? {
      method: 'GET',
      url: `GetClientMetadata(ClientMetadataQuery=@q)?@q=${encodeURIComponent(JSON.stringify({ MetadataType: 'businessprocessflow', EntityLogicalName: entity, MetadataId: norm(record), GetDefault: false, ...(app ? { AppId: norm(app) } : {}) }))}`,
      headers: { 'x-ms-metadatareductionlevel': '5', ClientHost: 'Browser' },
    };
  const names = (answer) => {
    if (providers.clientLabels) return providers.clientLabels(answer);
    const out = new Map();
    const visit = (v, depth) => {
      if (typeof v === 'string') {
        if (depth < 4 && /^\s*[[{]/.test(v))
          try {
            visit(JSON.parse(v), depth + 1);
          } catch {
            /* not JSON */
          }
        return;
      }
      if (!v || typeof v !== 'object') return;
      if (Array.isArray(v.Labels))
        for (const e of v.Labels) if (norm(e?.Id) && typeof e?.Value === 'string' && e.Value.trim() && String(e.LabelColumnName).toLowerCase() === 'description' && !out.has(norm(e.Id))) out.set(norm(e.Id), e.Value);
      for (const k in v) if (k !== 'Labels') visit(v[k], depth);
    };
    visit(answer, 0);
    return out;
  };
  /** The names Dynamics shows, every provisioned language: `<label id>|<lcid>` -> text. */
  const keptNames = async (part) => {
    const out = {};
    for (const { lcid } of ctx.langs) {
      const b = await d.lang.hold((h) => h.batch(lcid, [part]));
      if (!b.inLang || !b.results[0]?.ok) throw new Error(`GetClientMetadata in ${lcid}: ${b.inLang ? `HTTP ${b.results[0]?.status}` : 'not answered in that language'}`);
      for (const [id, text] of names(b.results[0].data)) out[`${norm(id)}|${lcid}`] = text;
    }
    return out;
  };
  /** A XAML attribute's text: its entities decoded, XAML's `{}` escape taken off (bpf.ts xamlText). */
  const unxml = (v) => {
    const t = String(v ?? '').replace(/&(?:#(x?)([\da-f]+)|(\w+));/gi, (m, x, n, e) => (e ? ({ amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" }[e] ?? m) : String.fromCodePoint(parseInt(n, x ? 16 : 10))));
    return t.startsWith('{}') ? t.slice(2) : t;
  };
  /** Every StepLabel of a definition: `<label id>|<lcid>` -> { xaml: [descriptions], clientdata: [descriptions] }. */
  const defined = (w) => {
    const out = {};
    const add = (where, id, l, text) => (out[`${norm(id)}|${Number(l)}`] ??= { xaml: [], clientdata: [] })[where].push(text);
    for (const m of String(w.xaml).matchAll(/<\w+:StepLabel\b((?:"[^"]*"|'[^']*'|[^>"'])*?)\/>/g)) {
      const a = Object.fromEntries([...m[1].matchAll(/([\w:.-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)].map(([, k, dq, sq]) => [k, dq ?? sq]));
      add('xaml', a.LabelId, a.LanguageCode, unxml(a.Description));
    }
    const visit = (v) => {
      if (!v || typeof v !== 'object') return;
      if (Array.isArray(v.stepLabels?.list)) for (const e of v.stepLabels.list) add('clientdata', e.labelId, e.languageCode, e.description);
      for (const k in v) if (k !== 'stepLabels') visit(v[k]);
    };
    visit(JSON.parse(w.clientdata || 'null'));
    return out;
  };
  const others = (a, b, skip) => [...new Set([...Object.keys(a), ...Object.keys(b)])].filter((k) => k !== skip && JSON.stringify(a[k]) !== JSON.stringify(b[k]));

  await step('bpf', async () => {
    const WF = (await testIds()).bpf;
    const orig0 = await get(`workflows(${WF})?$select=xaml,clientdata`);
    localStorage.setItem('dxt:test:bpfOriginal', JSON.stringify({ xaml: orig0.xaml, clientdata: orig0.clientdata }));
    let t = '';
    try {
      const bs = await loadBpf(ctx, WF, lo);
      store.add(bs);
      const stage = bs.find((s) => s.kind === 'stage');
      t = tgt(stage.labels[1036], 'Étape E2E');
      const strip = (x) => x.replace(/<\w+:StepLabel [^>]*LanguageCode="1036"\s*\/>/g, '');
      const rep = await editSave(stage.key, 1036, t);
      const w = await get(`workflows(${WF})?$select=xaml,clientdata`);
      ok('bpf stage fr saved', rep.saved === 1 && w.xaml.includes(t) && w.clientdata.includes(t), res(rep));
      ok('bpf xaml identical outside French labels', strip(w.xaml) === strip(orig0.xaml), 'diff');
      // Dynamics keeps a stage's translation once it is stored (LIVE-FINDINGS 83): emptied, it would be written as the
      // English text (model.ts standIn), never sent blank. Checked without saving: a stored stage name can't be taken
      // back, and restoring the definition wouldn't undo it.
      store.set(stage.key, 1036, '');
      const ss = store.standIn(stage.key, 1036, ctx.base);
      const issues = saver.validate(store.changes((s) => s.key === stage.key));
      store.revert(stage.key, 1036);
      ok('bpf clearing a stored stage translation would write its English text', !!ss?.text && ss.text === store.value(stage.key, ctx.base) && !issues.some((i) => i.level === 'error'), { ss, issues });
    } finally {
      await fetch(api + `workflows(${WF})`, { method: 'PATCH', headers: { Accept: 'application/json', 'Content-Type': 'application/json' }, body: JSON.stringify({ xaml: orig0.xaml, clientdata: orig0.clientdata }) });
      const back = await get(`workflows(${WF})?$select=xaml,clientdata`);
      // Dataverse compiles clientdata again from the xaml: its bytes may differ from the copy sent back.
      ok('bpf restored: xaml byte-for-byte, the test text gone', back.xaml === orig0.xaml && (!t || !back.clientdata.includes(t)), 'diff');
      if (back.xaml === orig0.xaml) localStorage.removeItem('dxt:test:bpfOriginal');
    }
  });

  await step('bpf preservation', async () => {
    // Saving one step's French must leave every other stage and step label, in every language, exactly as it was: in the
    // definition (xaml and clientdata) and in the names Dynamics keeps per language (GetClientMetadata, LIVE-FINDINGS 83,
    // 85, read the way bpf.ts reads them). Then everything is put back: the step's shown French written back (Dynamics
    // replaces a kept name, never removes one), the definition restored byte-for-byte.
    const WF = (await testIds()).bpf;
    const orig0 = await get(`workflows(${WF})?$select=xaml,clientdata,primaryentity`);
    const record = (await get(`accounts?$select=accountid&$filter=name eq 'DXT BPF Test'`)).value[0]?.accountid;
    if (!record) return ok('bpf preservation: the account "DXT BPF Test" exists', false, 'not found');
    localStorage.setItem('dxt:test:bpfOriginal', JSON.stringify({ xaml: orig0.xaml, clientdata: orig0.clientdata }));
    const app = (await get(`appmodules?$select=appmoduleid&$filter=name eq 'Translator Test App'`)).value[0]?.appmoduleid || '';
    const part = bpfPart(orig0.primaryentity, record, app);
    const kept = () => keptNames(part);
    let t = '';
    let key = '';
    let slotKey = '';
    let shown;
    let k0 = {};
    try {
      const bs = await loadBpf(ctx, WF, lo);
      store.add(bs);
      k0 = await kept();
      const d0 = defined(orig0);
      // A step that shows a French name of its own (not the base text), so the name Dynamics keeps can be put back
      // exactly: one is never removed, and a French copy of the base text would stay behind.
      const fr = (x) => k0[`${norm(x.ref.labelId)}|1036`];
      const s = bs.find((x) => x.kind === 'step' && fr(x) !== undefined && fr(x) !== k0[`${norm(x.ref.labelId)}|${ctx.base}`]);
      if (!s) return ok('bpf preservation: a step showing a French name of its own to put back', false, k0);
      key = `${norm(s.ref.labelId)}|1036`;
      slotKey = s.key;
      shown = k0[key];
      t = tgt(shown, 'Pas E2E');
      // The write as sent: one batch [read right before, PATCH, read back] that stops at a failed part (providers/repair.ts).
      const sent = [];
      const batch0 = ctx.http.batch;
      ctx.http.batch = (parts, o) => {
        if (parts.some((p) => p.method === 'PATCH' && p.url.startsWith('workflows('))) sent.push({ parts: parts.map((p) => `${p.method} ${p.url.split('?')[0]}`), stop: !!o?.stop });
        return batch0.call(ctx.http, parts, o);
      };
      let rep;
      try {
        rep = await editSave(s.key, 1036, t);
      } finally {
        ctx.http.batch = batch0;
      }
      ok('bpf preservation: written once, in one batch [read, PATCH, read] without continue-on-error', sent.length === 1 && sent[0].stop && JSON.stringify(sent[0].parts) === JSON.stringify([`GET workflows(${WF})`, `PATCH workflows(${WF})`, `GET workflows(${WF})`]), sent);
      const w1 = await get(`workflows(${WF})?$select=xaml,clientdata`);
      const d1 = defined(w1);
      const k1 = await kept();
      ok('bpf preservation: step fr saved in xaml and clientdata', rep.saved === 1 && d1[key]?.xaml.length > 0 && d1[key].xaml.every((x) => x === t) && d1[key].clientdata.every((x) => x === t), { rep: res(rep), d: d1[key] });
      ok('bpf preservation: every other label of the definition unchanged (every language, xaml and clientdata)', !others(d0, d1, key).length, others(d0, d1, key).map((k) => [k, d0[k], d1[k]]));
      ok('bpf preservation: every other name Dynamics shows unchanged (every language)', !others(k0, k1, key).length, others(k0, k1, key).map((k) => [k, k0[k], k1[k]]));
      log.push({ name: `bpf preservation: the saved step shows ${JSON.stringify(k1[key])} in French (was ${JSON.stringify(shown)})`, pass: true });
    } finally {
      // Nothing to put back before the save was sent.
      if (t) {
        // The name Dynamics keeps goes back first, written as a StepLabel (it is replaced, never removed); then the definition.
        await editSave(slotKey, 1036, shown).catch(() => {});
        await fetch(api + `workflows(${WF})`, { method: 'PATCH', headers: { Accept: 'application/json', 'Content-Type': 'application/json' }, body: JSON.stringify({ xaml: orig0.xaml, clientdata: orig0.clientdata }) });
        const back = await get(`workflows(${WF})?$select=xaml,clientdata`);
        ok('bpf preservation restored: xaml byte-for-byte, the test text gone', back.xaml === orig0.xaml && !back.clientdata.includes(t), 'diff');
        if (back.xaml === orig0.xaml) localStorage.removeItem('dxt:test:bpfOriginal');
        const k2 = await kept();
        ok('bpf preservation restored: every name Dynamics shows as before', !others(k0, k2, '').length, others(k0, k2, '').map((k) => [k, k0[k], k2[k]]));
      } else localStorage.removeItem('dxt:test:bpfOriginal');
    }
  });

  await step('undo after publish: bpf', async () => {
    // A step's French name saved, then undone from its journal entry as Recent publishes' Undo does (saver.undo, with
    // publishing on: process labels need none, the save is live at once). A step is loaded one of two ways:
    // * on a record's page, with the names Dynamics keeps (loadBpfStored, LIVE-FINDINGS 85): the undo writes the kept
    //   French name back, and Dynamics shows it again;
    // * in the Workbench, from the definition only, where a step whose French name only Dynamics keeps has none: the
    //   save adds one, which the undo can't remove (Dynamics keeps a step's translation once it is stored, LIVE-FINDINGS
    //   83), so it writes the step's English name in its place (model.ts standIn), and Dynamics then shows that.
    // Every other label, in every language, in the definition and in what Dynamics shows, stays as it was. Then the kept
    // French name is written back (it is replaced, never removed) and the definition restored byte for byte.
    const WF = (await testIds()).bpf;
    const orig0 = await get(`workflows(${WF})?$select=xaml,clientdata,primaryentity`);
    const record = (await get(`accounts?$select=accountid&$filter=name eq 'DXT BPF Test'`)).value[0]?.accountid;
    if (!record) return ok('undo after publish (bpf): the account "DXT BPF Test" exists', false, 'not found');
    localStorage.setItem('dxt:test:bpfOriginal', JSON.stringify({ xaml: orig0.xaml, clientdata: orig0.clientdata }));
    const app = (await get(`appmodules?$select=appmoduleid&$filter=name eq 'Translator Test App'`)).value[0]?.appmoduleid || '';
    const kept = () => keptNames(bpfPart(orig0.primaryentity, record, app));
    const restore = async () => {
      await fetch(api + `workflows(${WF})`, { method: 'PATCH', headers: { Accept: 'application/json', 'Content-Type': 'application/json' }, body: JSON.stringify({ xaml: orig0.xaml, clientdata: orig0.clientdata }) });
      return get(`workflows(${WF})?$select=xaml,clientdata`);
    };
    const k0 = await kept();
    const d0 = defined(orig0);
    let key = '';
    let slotKey = '';
    let shown = '';
    try {
      const bs = await loadBpf(ctx, WF, lo);
      // A step (else a stage) whose French name only Dynamics keeps, its own (not the English name, nor a test's).
      const fr = (x) => k0[`${norm(x.ref.labelId)}|1036`];
      const find = (kind) => bs.find((x) => x.kind === kind && !x.labels[1036] && fr(x) && fr(x) !== x.labels[ctx.base] && !/E2E/.test(fr(x)));
      const s0 = find('step') || find('stage');
      if (!s0) return ok('undo after publish (bpf): a step whose French name only Dynamics keeps', false, bs.map((x) => [x.kind, x.labels, fr(x)]));
      key = `${norm(s0.ref.labelId)}|1036`;
      slotKey = s0.key;
      shown = fr(s0);
      const en = s0.labels[ctx.base];

      // On a record's page.
      store.add((await providers.loadBpfStored(ctx, bs, { entity: orig0.primaryentity, record, app }, lo)).slots);
      const t = tgt(shown, 'Pas annulé E2E');
      const rep = await editSave(slotKey, 1036, t, true);
      const e = saver.history().find((x) => x.id === rep.historyId);
      ok('undo after publish (bpf, page): saved, live at once, journaled with the kept name before', rep.saved === 1 && rep.published && !rep.publishError && e?.published && e.items.length === 1 && e.items[0].before === shown && e.items[0].after === t, { rep: res(rep), e });
      if (e) {
        const u = await saver.undo(e, opts(true));
        const d1 = defined(await get(`workflows(${WF})?$select=xaml,clientdata`));
        const k1 = await kept();
        ok('undo after publish (bpf, page): the kept French name is written back, and Dynamics shows it', u.saved === 1 && u.errors === 0 && u.published && !u.results[0].change.standIn && d1[key]?.xaml.length > 0 && d1[key].clientdata.length > 0 && [...d1[key].xaml, ...d1[key].clientdata].every((x) => x === shown) && k1[key] === shown, { u: res(u), d: d1[key], k: k1[key], shown });
        ok('undo after publish (bpf, page): every other label as it was (definition and shown names, every language)', !others(d0, d1, key).length && !others(k0, k1, '').length, { def: others(d0, d1, key), shown: others(k0, k1, '').map((k) => [k, k0[k], k1[k]]) });
        ok('undo after publish (bpf, page): the entry is undone', !!saver.history().find((x) => x.id === e.id)?.undoneAt, saver.history().find((x) => x.id === e.id));
      }

      // In the Workbench: the definition as it was (no French name for that step), read again.
      await restore();
      store.revert(slotKey, 1036);
      store.add(await loadBpf(ctx, WF, lo));
      const t2 = tgt(shown, 'Pas Workbench E2E');
      const rep2 = await editSave(slotKey, 1036, t2, true);
      const e2 = saver.history().find((x) => x.id === rep2.historyId);
      ok('undo after publish (bpf, Workbench): saved, journaled as a first French name', rep2.saved === 1 && rep2.published && e2?.items.length === 1 && e2.items[0].before === '' && e2.items[0].after === t2, { rep: res(rep2), e2 });
      if (e2) {
        const u2 = await saver.undo(e2, opts(true));
        const d2 = defined(await get(`workflows(${WF})?$select=xaml,clientdata`));
        const k2 = await kept();
        const c = u2.results[0]?.change;
        ok("undo after publish (bpf, Workbench): it can't be removed, so its English name is written in its place, and Dynamics shows it", u2.saved === 1 && u2.errors === 0 && c?.standIn?.from === 'base' && c.after === en && d2[key]?.xaml.length > 0 && d2[key].clientdata.length > 0 && [...d2[key].xaml, ...d2[key].clientdata].every((x) => x === en) && k2[key] === en, { u: res(u2), c, d: d2[key], k: k2[key], en });
        ok('undo after publish (bpf, Workbench): every other label as it was (definition and shown names, every language)', !others(d0, d2, key).length && !others(k0, k2, key).length, { def: others(d0, d2, key), shown: others(k0, k2, key).map((k) => [k, k0[k], k2[k]]) });
        const m2 = saver.history().find((x) => x.id === e2.id);
        ok('undo after publish (bpf, Workbench): the entry is undone, nothing kept', !!m2?.undoneAt && !m2.kept, m2);
      }
    } finally {
      // The French name Dynamics kept is written back first (written as a StepLabel: it is replaced, never removed), from
      // what Dynamics shows now: a write whose answer was lost commits nothing, so the store's text may be behind.
      const now = await kept().then((k) => k[key], () => undefined);
      if (slotKey && shown && now !== shown) {
        store.revert(slotKey, 1036);
        const fresh = await providers.loadBpfStored(ctx, await loadBpf(ctx, WF, lo), { entity: orig0.primaryentity, record, app }, lo).catch(() => null);
        if (fresh) store.add(fresh.slots);
        const r = await editSave(slotKey, 1036, shown).catch((e) => ({ saved: 0, unchanged: 0, results: [], e: String(e) }));
        ok('undo after publish (bpf) restored: the kept French name written back', r.saved + (r.unchanged || 0) === 1, r.e || res(r));
      }
      const back = await restore();
      ok('undo after publish (bpf) restored: xaml byte-for-byte', back.xaml === orig0.xaml, 'diff');
      if (back.xaml === orig0.xaml) localStorage.removeItem('dxt:test:bpfOriginal');
      const k3 = await kept();
      ok('undo after publish (bpf) restored: every name Dynamics shows as before', !others(k0, k3, '').length, others(k0, k3, '').map((k) => [k, k0[k], k3[k]]));
    }
  });

  await step('managed read-only', async () => {
    // Labels of a managed solution's components are read-only: a translation would be an unmanaged layer on top of them.
    // Nothing is written here: account and its main form come from Microsoft's managed solutions, the test fixtures are
    // this environment's (unmanaged) and stay editable. Each writer's refusal is proven by the unit tests.
    const MANAGED = /^From a managed solution: /;
    const acc = (await providers.loadTables(ctx, ['account'], new Set(['entity']), lo)).filter((s) => s.kind === 'entity');
    const desc = acc.find((s) => s.prop === 'Description');
    ok('managed table: every label read-only, the description saying why', acc.length === 3 && acc.every((s) => s.readOnly && s.ref.managed === true) && MANAGED.test(desc?.readOnly || ''), acc.map((s) => [s.key, s.readOnly]));
    const issues = saver.validate([{ slot: desc, lcid: 1036, before: desc.labels[1036] || '', after: 'Description E2E' }]);
    ok('managed table: the save refuses it before anything is sent', issues.some((i) => i.level === 'error' && /^Read-only: From a managed solution/.test(i.message)), issues.map((i) => i.message));
    store.add(acc);
    store.set(desc.key, 1036, 'Description E2E');
    ok('managed table: nothing is staged on it', !store.isEdited(desc.key), store.changes().map((c) => c.slot.key));
    const accForm = (await get(`systemforms?$select=formid&$filter=objecttypecode eq 'account' and type eq 2 and ismanaged eq true`)).value[0]?.formid;
    if (accForm) {
      const fs = await providers.loadFormXml(ctx, [await providers.getForm(ctx, accForm)], [ctx.user], lo);
      ok('managed form: every label read-only', fs.length && fs.every((s) => MANAGED.test(s.readOnly) && s.ref.managed === true), fs.slice(0, 5).map((s) => [s.key, s.readOnly]));
    }
    // The fixtures stay editable; both sitemap reads ask for ismanaged (sitemaps have no iscustomizable column).
    const mine = await providers.loadTables(ctx, [E], new Set(['entity']), lo);
    ok('unmanaged test table: editable', mine.length && mine.every((s) => !s.readOnly && s.ref.managed === false), mine.map((s) => [s.key, s.readOnly]));
    const sm = await providers.loadSitemap(ctx, (await testIds()).sitemap, lo);
    ok('unmanaged test sitemap: read as unmanaged, its items editable', sm.length && sm.every((s) => s.ref.managed === false) && sm.some((s) => !s.readOnly), sm.slice(0, 5).map((s) => [s.key, s.readOnly, s.ref.managed]));
  });

  // ---- The kept test components of 'form labels' (named in the header), created when missing: the text column
  // new_dxtremove and the main form "DXT e2e form labels", inactive (the app never opens it), holding new_name (no label
  // of its own), new_dxtremove (English "Own remove", French "Propre retrait") and, in the header, header_new_dxtremove
  // (English "Own header"). Their labels stay under the cells' ids: every test works on a test key (onTestKey). ----
  const FX = { col: 'new_dxtremove', names: { 1033: 'DXT Remove', 1036: 'Retrait DXT' }, own: { 1033: 'Own remove', 1036: 'Propre retrait' }, form: 'DXT e2e form labels' };
  const colUrl = `EntityDefinitions(LogicalName='${E}')/Attributes(LogicalName='${FX.col}')`;
  const colNames = async () => labelsOf((await get(`${colUrl}?$select=DisplayName`)).DisplayName);
  /** The fixture column's names set elsewhere than through the translator: every language in one PUT (LIVE-FINDINGS 2), not published. */
  const rawRename = (names) =>
    d.lang.quiet(async () => {
      const LocalizedLabels = Object.entries(names).map(([l, Label]) => ({ '@odata.type': 'Microsoft.Dynamics.CRM.LocalizedLabel', Label, LanguageCode: Number(l) }));
      const r = await fetch(api + colUrl, { method: 'PUT', headers: { ...JH, 'MSCRM.MergeLabels': 'true' }, body: JSON.stringify({ '@odata.type': 'Microsoft.Dynamics.CRM.StringAttributeMetadata', LogicalName: FX.col, DisplayName: { '@odata.type': 'Microsoft.Dynamics.CRM.Label', LocalizedLabels } }) });
      if (!r.ok) throw new Error(`rename ${FX.col}: ${r.status} ${(await r.text()).slice(0, 200)}`);
    });
  /** The fixtures, made when missing, with the column's names and the cells' keys as the steps expect them; the form's id. */
  async function fixtures() {
    const LL = (Label, LanguageCode) => ({ '@odata.type': 'Microsoft.Dynamics.CRM.LocalizedLabel', Label, LanguageCode });
    if (!(await get(`${colUrl}?$select=LogicalName`).catch(() => null)))
      await d.lang.quiet(async () => {
        const r = await fetch(api + `EntityDefinitions(LogicalName='${E}')/Attributes`, {
          method: 'POST',
          headers: JH,
          body: JSON.stringify({
            '@odata.type': 'Microsoft.Dynamics.CRM.StringAttributeMetadata',
            SchemaName: FX.col,
            AttributeType: 'String',
            AttributeTypeName: { Value: 'StringType' },
            MaxLength: 100,
            FormatName: { Value: 'Text' },
            RequiredLevel: { Value: 'None', CanBeChanged: true, ManagedPropertyLogicalName: 'canmodifyrequirementlevelsettings' },
            DisplayName: { '@odata.type': 'Microsoft.Dynamics.CRM.Label', LocalizedLabels: [LL(FX.names[1033], 1033), LL(FX.names[1036], 1036)] },
            Description: { '@odata.type': 'Microsoft.Dynamics.CRM.Label', LocalizedLabels: [LL('Translator live tests: a form label fixture (tools/e2e-suite.js)', 1033)] },
          }),
        });
        if (!r.ok) throw new Error(`create ${FX.col}: ${r.status} ${(await r.text()).slice(0, 200)}`);
      });
    // A French name given at creation may not be stored, and a failed run may have left a rename.
    const n = await colNames();
    if (n[1033] !== FX.names[1033] || n[1036] !== FX.names[1036]) await rawRename(FX.names);
    const find = async () => (await get(`systemforms?$select=formid&$filter=objecttypecode eq '${E}' and type eq 2 and name eq '${FX.form}'`)).value[0]?.formid;
    let id = await find();
    if (!id) {
      const g = () => `{${crypto.randomUUID()}}`;
      const lab = (en, fr) => `<labels><label description="${en}" languagecode="1033" />${fr ? `<label description="${fr}" languagecode="1036" />` : ''}</labels>`;
      const ctl = (cid, df) => `<control id="${cid}" classid="{4273EDBD-AC1D-40d3-9FB2-095C621B552D}" datafieldname="${df}" disabled="false" />`;
      const xml =
        `<form><tabs><tab name="dxt_fl_tab" id="${g()}" IsUserDefined="1" verticallayout="true" showlabel="true" expanded="true">${lab('Form labels', 'Libellés')}<columns><column width="100%"><sections>` +
        `<section name="dxt_fl_sec" id="${g()}" IsUserDefined="0" showlabel="true" showbar="false" columns="1">${lab('Fields', 'Champs')}<rows>` +
        `<row><cell id="${g()}">${lab('Name')}${ctl('new_name', 'new_name')}</cell></row>` +
        `<row><cell id="${g()}">${lab(FX.own[1033], FX.own[1036])}${ctl(FX.col, FX.col)}</cell></row>` +
        `</rows></section></sections></column></columns></tab></tabs>` +
        `<header id="${g()}" celllabelposition="Top" columns="111" labelwidth="115" celllabelalignment="Left"><rows><row><cell id="${g()}">${lab('Own header')}${ctl('header_' + FX.col, FX.col)}</cell></row></rows></header>` +
        `<DisplayConditions Order="99" FallbackForm="false"><Everyone /></DisplayConditions></form>`;
      await d.lang.hold(async () => {
        const r = await fetch(api + 'systemforms', { method: 'POST', headers: JH, body: JSON.stringify({ name: FX.form, description: 'Translator live tests: main-form field label fixture (tools/e2e-suite.js), kept', objecttypecode: E, type: 2, formactivationstate: 0, formxml: xml }) });
        if (!r.ok) throw new Error(`create the form "${FX.form}": ${r.status} ${(await r.text()).slice(0, 200)}`);
      });
      id = await find();
    }
    // A failed run may have left a fixture cell on a test key: its own key back (none).
    const doc = await unpubDoc(id);
    if ([...doc.getElementsByTagName('cell')].some((c) => columnCell(c) && c.getAttribute('labelid'))) await rawPatch(id, (x) => [...x.getElementsByTagName('cell')].forEach((c) => c.removeAttribute('labelid')));
    await publishE();
    return id;
  }

  await step('form labels', async () => {
    // A main form's field labels (LIVE-FINDINGS 103, 104), on the fixture form, each test with the cell new_dxtremove on a
    // test key: a save posts only the labels it changes; an emptied label is saved as 1.0.0 saves it, French as its
    // stand-in (the column's French name, a text of the label's own on the same key), which Undo writes the own text back
    // over, English refused; a column rename and an emptied French label in one save.
    // After every save the check after the write has nothing to say (no warning, no notice).
    const FL = await fixtures();
    const doc0 = await unpubDoc(FL);
    const CELL = norm([...doc0.getElementsByTagName('cell')].find((c) => c.querySelector(':scope > control')?.getAttribute('id') === FX.col)?.getAttribute('id'));
    if (!CELL) return ok('form labels: the fixture form has the cell new_dxtremove', false, FL);
    const SK = `field|${norm(FL)}|${CELL}|Label`;
    const CK = `attribute|${E}.${FX.col}|DisplayName`;
    const read = async () => {
      const doc = await unpubDoc(FL);
      return { labels: labelMap(cellIn(doc, CELL)), key: keyIn(doc, CELL) };
    };
    const at0 = await read();
    ok('form labels: the fixture cell shows its own labels, on its own id', !at0.key && at0.labels[1033] === FX.own[1033] && at0.labels[1036] === FX.own[1036], at0);
    const lname = (l) => (l === 1033 ? 'English' : 'French');
    /** Runs `fn(k)` with the cell on a test key, then puts back the column's names and the cell's own key. */
    const keyed = async (name, fn) => {
      const k = await onTestKey(FL, CELL);
      try {
        const fs = await refresh(FL, true, [ctx.user]);
        if (!fs.some((s) => s.key === SK && s.ref.sparse)) return ok(`${name}: the fixture cell loaded as a main form's column cell`, false, fs.map((s) => [s.key, s.ref.sparse]));
        await fn(k);
      } finally {
        for (const [key, l] of [[SK, 1033], [SK, 1036], [CK, 1033], [CK, 1036]]) if (store.isEdited(key, l)) store.revert(key, l);
        const n = await colNames();
        if (n[1033] !== FX.names[1033] || n[1036] !== FX.names[1036]) await rawRename(FX.names);
        const back = await k.restore();
        const now = await read();
        ok(`${name}: restored (the cell's own key and labels, the column's names)`, back && JSON.stringify(now) === JSON.stringify(at0) && JSON.stringify(await colNames()) === JSON.stringify(FX.names), now);
        await refresh(FL, true, [ctx.user]);
      }
    };

    await keyed('form: a save posts only what it changes', async (k) => {
      const d0 = await unpubDoc(FL);
      const t = FX.own[1036] + ' E2E';
      const cap = capture();
      let rep;
      try {
        rep = await editSave(SK, 1036, t);
      } finally {
        cap.stop();
      }
      const sent = cap.bodies[0] && xmlDoc(cap.bodies[0]);
      const cells = sent ? [...sent.getElementsByTagName('cell')].filter(columnCell) : [];
      const mine = cells.find((c) => norm(c.getAttribute('id')) === CELL);
      const others = cells.filter((c) => c !== mine);
      const tabs = (doc) => JSON.stringify([...doc.querySelectorAll('tab, section')].map(labelMap));
      ok(
        'form: a save posts no labels for the column cells it leaves alone (body and header), only French on the one it edits, the tab and section as read',
        cap.bodies.length === 1 && mine && JSON.stringify(labelMap(mine)) === JSON.stringify({ 1036: t }) && keyIn(sent, CELL) === k.key && others.length === 2 && others.every((c) => !c.querySelector(':scope > labels')) && tabs(sent) === tabs(d0),
        { n: cap.bodies.length, mine: mine && labelMap(mine), others: others.map((c) => [c.querySelector(':scope > control')?.getAttribute('id'), labelMap(c)]) },
      );
      const a = await read();
      ok('form: the edit saved, English kept; nothing else to say', rep.saved === 1 && clean(rep) && a.labels[1036] === t && a.labels[1033] === FX.own[1033] && a.key === k.key, { rep: res(rep), w: rep.warning, n: rep.notice, a });
    });

    // French emptied, as 1.0.0 saves it: written as its stand-in, the column's French name, a text of the label's own on
    // the same key (LIVE-FINDINGS 104), which a rename made elsewhere leaves as it is; then the undo, as Recent publishes'
    // Undo does it, writes the own text back.
    await keyed('form: French emptied', async (k) => {
      const name = 'form: French emptied';
      store.set(SK, 1036, '');
      const si = store.standIn(SK, 1036, ctx.base);
      const cap = capture();
      let rep;
      try {
        rep = await saver.save(store.changes((s) => s.key === SK), opts(true));
      } finally {
        cap.stop();
      }
      const e = saver.history().find((x) => x.id === rep.historyId);
      const a = await read();
      const sent = cap.bodies[0] && cellIn(xmlDoc(cap.bodies[0]), CELL);
      ok(
        `${name}: saved and published as the column's French name, on the same key, English kept, journaled as written; nothing else to say`,
        si?.text === FX.names[1036] && rep.saved === 1 && rep.errors + rep.conflicts === 0 && rep.published && clean(rep) &&
          a.key === k.key && a.labels[1036] === FX.names[1036] && a.labels[1033] === FX.own[1033] &&
          norm(sent?.getAttribute('labelid')) === k.key && JSON.stringify(labelMap(sent)) === JSON.stringify({ 1036: FX.names[1036] }) &&
          e?.items.length === 1 && e.items[0].before === FX.own[1036] && e.items[0].after === FX.names[1036],
        { rep: res(rep), w: rep.warning, n: rep.notice, si, a, k: k.key, sent: sent && new XMLSerializer().serializeToString(sent), e },
      );
      if (!e) return;
      await rawRename({ ...FX.names, 1036: FX.names[1036] + ' 2' });
      const b = await read();
      ok(`${name}: a rename made elsewhere leaves it (a text of its own)`, b.labels[1036] === FX.names[1036] && b.labels[1033] === FX.own[1033] && b.key === k.key, b);
      const u = await saver.undo(e, opts(true));
      const c = await read();
      ok(`${name}: Undo writes the own text back, on the same key; nothing else to say`, u.saved === 1 && u.errors + u.conflicts === 0 && u.published && clean(u) && [1033, 1036].every((l) => c.labels[l] === FX.own[l]) && c.key === k.key && !!saver.history().find((x) => x.id === e.id)?.undoneAt, { u: res(u), w: u.warning, n: u.notice, c });
    });

    // English emptied, refused as 1.0.0 refuses it: nothing stands in for the base language, and Dataverse keeps a label
    // posted empty (LIVE-FINDINGS 104), so the change is an error saying so; the label as it was, nothing journaled.
    await keyed('form: English emptied (the base language)', async (k) => {
      const ids0 = new Set(saver.history().map((x) => x.id));
      store.set(SK, 1033, '');
      const rep = await saver.save(store.changes((s) => s.key === SK), opts(true));
      const a = await read();
      ok(
        'form: English emptied is refused as in 1.0.0: Dataverse kept the label, the change an error, nothing journaled',
        rep.saved === 0 && rep.results[0]?.outcome === 'error' && rep.results[0]?.message === 'Dataverse did not keep this label. Reload the form to see what is saved.' &&
          !rep.historyId && saver.history().every((x) => ids0.has(x.id)) && a.key === k.key && a.labels[1033] === FX.own[1033] && a.labels[1036] === FX.own[1036],
        { rep: res(rep), a, k: k.key },
      );
    });

    // Last: the translator's own rename of the column makes its saves read that column's names as lagging behind it
    // for a minute (LIVE-FINDINGS 66), and the raw renames after it would hold back a save on this cell in that time.
    await keyed('form: a column rename and an emptied French label in one save', async (k) => {
      const t = FX.names[1036] + ' 3';
      store.set(CK, 1036, t);
      store.set(SK, 1036, '');
      const rep = await saver.save(store.changes((s) => s.key === SK || s.key === CK), opts(true));
      const a = await read();
      const col = await colNames();
      ok("form: a column rename and an emptied French label in one save: both saved, the label written as the column's new name once the rename is saved, English kept; nothing else to say", rep.saved === 2 && rep.errors + rep.conflicts === 0 && clean(rep) && col[1036] === t && a.labels[1036] === t && a.labels[1033] === FX.own[1033] && a.key === k.key, { rep: res(rep), w: rep.warning, n: rep.notice, col, a, k: k.key });
      await rawRename({ ...FX.names, 1036: FX.names[1036] + ' 4' });
      const b = await read();
      ok('form: …a text of its own: the next rename leaves it', b.labels[1036] === t && b.labels[1033] === FX.own[1033], b);
    });
  });

  if (window.__dxtE2EWithRibbon) {
    // Classic ribbon labels go through a translation import (LIVE-FINDINGS 72–77): two labels in one save, then
    // every ribbondiff (buttons and labels) and command of the table compared with the start, and no temporary
    // solution left. Then the application ribbon's test label (dxt.test.AppLabel, which no button uses).
    const saveKeys = async (pairs) => {
      for (const [key, text] of pairs) store.set(key, 1036, text);
      const keys = pairs.map(([k]) => k);
      return saver.save(store.changes((sl) => keys.includes(sl.key)), opts(true));
    };
    const ribbonOf = async (filter) => {
      const d = (await get(`ribbondiffs?$select=diffid,difftype,rdx,ismanaged&$filter=${filter}`)).value;
      return Object.fromEntries(d.map((x) => [`${x.diffid}#${x.difftype}#${x.ismanaged}`, x.rdx]));
    };
    const changed = (a, b) => [...new Set([...Object.keys(a), ...Object.keys(b)])].filter((k) => a[k] !== b[k]);
    const leftovers = async () => (await get(`solutions?$select=uniquename&$filter=startswith(uniquename,'dxt_ribbon_')`)).value.map((x) => x.uniquename);
    const LT = 'new.new_dxttest.DxtButton.LabelText';
    const TT = 'new.new_dxttest.DxtButton.ToolTipTitle';
    await step('ribbon', async () => {
      const sl = await providers.loadRibbonLabels(ctx, [E], lo);
      store.add(sl);
      const lab = sl.find((x) => x.ref.locLabelId === LT);
      const tip = sl.find((x) => x.ref.locLabelId === TT);
      const cmds = async () => JSON.stringify((await get(`ribboncommands?$select=command,commanddefinition&$filter=entity eq '${E}'`)).value.map((x) => [x.command, x.commanddefinition]));
      // The store updates a slot's labels after a save: keep the texts to restore now.
      const [fr1, fr2] = [lab.labels[1036], tip.labels[1036]];
      const before = await ribbonOf(`entity eq '${E}'`);
      const cmd0 = await cmds();
      const t1 = tgt(fr1, 'Lancer le test E2E');
      const t2 = tgt(fr2, 'Lancer le test du traducteur E2E');
      const t0 = Date.now();
      const rep = await saveKeys([[lab.key, t1], [tip.key, t2]]);
      const secs = Math.round((Date.now() - t0) / 1000);
      const after = await ribbonOf(`entity eq '${E}'`);
      const r1 = after[`${LT}#3#false`] || '';
      const r2 = after[`${TT}#3#false`] || '';
      ok('ribbon fr saved (two labels, one import)', rep.saved === 2 && r1.includes(`description="${t1}"`) && r2.includes(`description="${t2}"`), { rep: res(rep), r1, r2 });
      ok('ribbon: only the two french titles changed', JSON.stringify(changed(before, after).sort()) === JSON.stringify([`${LT}#3#false`, `${TT}#3#false`]) && r1.replace(t1, '') === before[`${LT}#3#false`].replace(fr1, '') && (await cmds()) === cmd0, { changed: changed(before, after), r1, r2 });
      ok(`ribbon saved in ${secs} s (under 60)`, secs < 60, secs);
      ok('ribbon temporary solution deleted', !(await leftovers()).length, await leftovers());
      // An import keeps titles it doesn't carry or leaves empty (LIVE-FINDINGS 39, 69): emptied, the title would be
      // written as its English text (model.ts standIn), never sent blank. Checked without another slow import.
      store.set(lab.key, 1036, '');
      const ls = store.standIn(lab.key, 1036, ctx.base);
      const issues = saver.validate(store.changes((s) => s.key === lab.key));
      store.set(lab.key, 1036, t1);
      ok('ribbon clear would write the English title', !!ls?.text && ls.text === store.value(lab.key, ctx.base) && !issues.some((i) => i.level === 'error'), { ls, issues });
      const rep3 = await saveKeys([[lab.key, orig(fr1, 'Lancer le test')], [tip.key, orig(fr2, 'Lancer le test du traducteur')]]);
      const back = await ribbonOf(`entity eq '${E}'`);
      ok('ribbon restored exactly', rep3.saved === 2 && !changed(before, back).length, { rep: res(rep3), changed: changed(before, back) });
    });
    await step('ribbon app', async () => {
      const sl = await providers.loadRibbonLabels(ctx, ['_app'], lo);
      const lab = sl.find((x) => x.ref.locLabelId === 'dxt.test.AppLabel');
      if (!lab) return ok('ribbon app: test label dxt.test.AppLabel present (see LIVE-FINDINGS 75)', false, sl.length);
      store.add([lab]);
      const fr = lab.labels[1036];
      const before = await ribbonOf('entity eq null');
      const t = tgt(fr, "Test du ruban de l'application E2E");
      const rep = await editSave(lab.key, 1036, t, true);
      const after = await ribbonOf('entity eq null');
      const k = 'dxt.test.AppLabel#3#false';
      ok('ribbon app fr saved', rep.saved === 1 && (after[k] || '').includes(`description="${t}"`) && (after[k] || '').includes('description="Translator app ribbon test"'), { rep: res(rep), r: after[k] });
      ok('ribbon app: nothing else changed', JSON.stringify(changed(before, after)) === JSON.stringify([k]), changed(before, after));
      const rep2 = await editSave(lab.key, 1036, orig(fr, "Test du ruban de l'application"), true);
      ok('ribbon app restored', rep2.saved === 1 && !changed(before, await ribbonOf('entity eq null')).length, res(rep2));
      ok('ribbon app temporary solution deleted', !(await leftovers()).length, await leftovers());
    });
    await step('ribbon publish fails, Try again, undo', async () => {
      // The import's publish fails (the first PublishXml after the ImportTranslation, answered 503 with no Retry-After,
      // which nothing retries; the one before the import publishes what was pending): the title is imported but not
      // published, the save says so, journals nothing and keeps the edit. Try again (the same change sent again on the
      // same saver, as the Publish dialog's Try again does) publishes it and journals it as this save's own (SW01: a
      // write that may have run); its Undo then puts the title back exactly. Every ribbondiff of the table as at the
      // start; no temporary solution left.
      const sl = await providers.loadRibbonLabels(ctx, [E], lo);
      store.add(sl);
      const lab = sl.find((x) => x.ref.locLabelId === LT);
      const fr1 = lab.labels[1036];
      const k = `${LT}#3#false`;
      const before = await ribbonOf(`entity eq '${E}'`);
      const t1 = tgt(fr1, 'Lancer le test E2E');
      const f0 = window.fetch;
      let n = 0;
      let imported = false;
      let clean = false;
      window.fetch = function (input, init) {
        const u = typeof input === 'string' ? input : input?.url || '';
        if (init?.method === 'POST' && /\/ImportTranslation$/.test(u)) imported = true;
        if (imported && init?.method === 'POST' && /\/PublishXml$/.test(u) && !n++) return Promise.resolve(new Response('', { status: 503 }));
        return f0.apply(this, arguments);
      };
      try {
        let rep;
        try {
          rep = await editSave(lab.key, 1036, t1, true);
        } finally {
          window.fetch = f0;
        }
        const mid = await ribbonOf(`entity eq '${E}'`);
        ok('ribbon publish fails: imported but not published, said so, nothing journaled, the edit kept', n >= 1 && rep.saved === 0 && rep.errors === 1 && /was imported but not published \(Dataverse returned HTTP 503\)/.test(rep.results[0]?.message || '') && !rep.historyId && !changed(before, mid).length && store.value(lab.key, 1036) === t1 && store.isEdited(lab.key, 1036), { n, rep: res(rep), changed: changed(before, mid) });
        const rep2 = await saver.save(store.changes((s) => s.key === lab.key), opts(true));
        const e = saver.history().find((x) => x.id === rep2.historyId);
        const after = await ribbonOf(`entity eq '${E}'`);
        ok("ribbon Try again: published, journaled as this save's own", rep2.errors === 0 && rep2.saved + rep2.unchanged === 1 && !rep2.results[0]?.found && rep2.published && e?.items.length === 1 && e.items[0].before === (fr1 || '') && e.items[0].after === t1 && (after[k] || '').includes(`description="${t1}"`) && JSON.stringify(changed(before, after)) === JSON.stringify([k]), { rep: res(rep2), e, changed: changed(before, after) });
        if (!e) return;
        const u = await saver.undo(e, opts(true));
        const back = await ribbonOf(`entity eq '${E}'`);
        clean = !changed(before, back).length;
        ok('ribbon undo after publish: the title back exactly, the entry undone', u.saved === 1 && u.errors === 0 && u.published && clean && !!saver.history().find((x) => x.id === e.id)?.undoneAt, { u: res(u), changed: changed(before, back) });
        ok('ribbon publish fails, Try again, undo: no temporary solution left', !(await leftovers()).length, await leftovers());
      } finally {
        if (!clean) {
          // An import left unpublished would go out with the next save: published now, then the title put back.
          await fetch(api + 'PublishXml', { method: 'POST', headers: { Accept: 'application/json', 'Content-Type': 'application/json' }, body: JSON.stringify({ ParameterXml: `<importexportxml><entities><entity>${E}</entity></entities></importexportxml>` }) });
          store.add(await providers.loadRibbonLabels(ctx, [E], lo));
          if (changed(before, await ribbonOf(`entity eq '${E}'`)).length) await editSave(lab.key, 1036, orig(fr1, 'Lancer le test'), true).catch(() => {});
        }
        if (store.isEdited(lab.key, 1036)) store.revert(lab.key, 1036);
      }
    });
  }
  window.__dxtE2E.running = false;
})();
