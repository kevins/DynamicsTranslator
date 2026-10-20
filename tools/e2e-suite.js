// Live regression suite. Load after a dev build (window.__dxtDev) in a signed-in tab of the test org:
//   dist/bridge.html?f=e2e-bundle.js,e2e-suite.js&back=<page>   (providers + saver only), or
//   dist/bridge.html?f=translator.debug.js,e2e-suite.js&back=<page>   (full app, built with --dev)
// (<page>: an https page of the test org; tools/dev/bridge.html has no default.)
// Uses only test components (table new_dxttest, app "Translator Test App", BPF "bpf test" with backup); the account
// table and its main form are only read, to check that a managed solution's components are read-only.
// Every test edits through the translator, verifies with independent reads that only the edited language
// changed, then restores. Some undo a published save from its journal entry, as Recent publishes does, and one makes a
// publish fail on purpose to check Try again. Set window.__dxtE2EWithRibbon = true first to include the classic-ribbon
// tests (~4 min).
// Results: window.__dxtE2E = { running, log: [{ name, pass, info }], progress }.
window.__dxtE2E = { running: true, log: [], progress: [] };
(async () => {
  for (let i = 0; i < 80 && !window.__dxtDev?.ready && !window.__dxtDev?.app?.saver; i++) await new Promise((r) => setTimeout(r, 250));
  const d = window.__dxtDev;
  const { ctx, store, providers } = d;
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
  const E = 'new_dxttest';
  const step = async (name, fn) => {
    try {
      await fn();
    } catch (e) {
      log.push({ name: name + ' EXCEPTION', pass: false, info: String((e && e.stack) || e).slice(0, 900) });
    }
  };
  const xmlDoc = (x) => new DOMParser().parseFromString(x, 'application/xml');
  const norm = (id) => String(id || '').replace(/[{}]/g, '').toLowerCase();
  const labelMap = (el) => Object.fromEntries([...(el?.querySelector(':scope > labels')?.children || [])].map((l) => [l.getAttribute('languagecode'), l.getAttribute('description')]));
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

    const key = `attribute|${E}.new_name|Description`;
    const slot = store.get(key);
    const theirs = 'Theirs ' + Date.now().toString(36);
    store.set(key, 1036, 'Mine');
    await fetch(api + `EntityDefinitions(LogicalName='${E}')/Attributes(LogicalName='new_name')`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json', 'MSCRM.MergeLabels': 'true' },
      body: JSON.stringify({ '@odata.type': 'Microsoft.Dynamics.CRM.StringAttributeMetadata', LogicalName: 'new_name', Description: { LocalizedLabels: [{ Label: slot.labels[1033] || 'Primary name', LanguageCode: 1033 }, { Label: theirs, LanguageCode: 1036 }] } }),
    });
    const rep4 = await saver.save(store.changes((s) => s.key === key), opts());
    const ca = labelsOf((await get(`EntityDefinitions(LogicalName='${E}')/Attributes(LogicalName='new_name')?$select=Description`)).Description);
    ok('conflict detected, server kept', rep4.conflicts === 1 && ca[1036] === theirs, { rep: res(rep4), ca });
    store.resolve(key, 1036, false);
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
    const FORM = (await get(`systemforms?$select=formid&$filter=objecttypecode eq '${E}' and type eq 2`)).value[0].formid;
    for (const [kind, id, set, col, prop] of [
      ['view', 'b0618642-69fb-449b-8a46-565d2776976f', 'savedqueries', 'name', 'Name'],
      ['form', FORM, 'systemforms', 'name', 'Name'],
      ['command', '19c28017-3fc8-f111-b377-7ced8da4e57c', 'appactions', 'buttonlabeltext', 'Label'],
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
    const V = 'b0618642-69fb-449b-8a46-565d2776976f';
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
    const FORM = (await get(`systemforms?$select=formid&$filter=objecttypecode eq '${E}' and type eq 2`)).value[0].formid;
    const fref = await providers.getForm(ctx, FORM);
    const fs = await providers.loadFormXml(ctx, [fref], [1033, 1036], lo);
    store.add(fs);
    const cell = fs.find((s) => s.kind === 'field' && s.ref?.controlId === 'new_name');
    const tab = fs.find((s) => s.kind === 'tab');
    const unpub = async () => xmlDoc((await get(`systemforms(${FORM})/Microsoft.Dynamics.CRM.RetrieveUnpublished()?$select=formxml`)).formxml);
    const cellId = norm(cell.key.split('|')[2]);
    const tabId = norm(tab.key.split('|')[2]);
    const cellLabels = (doc) => labelMap([...doc.getElementsByTagName('cell')].find((c) => norm(c.getAttribute('id')) === cellId));
    const tabLabels = (doc) => labelMap([...doc.getElementsByTagName('tab')].find((c) => norm(c.getAttribute('id')) === tabId));
    const cb = cellLabels(await unpub());
    const t = tgt(cb[1036], 'Nom E2E');
    const rep = await editSave(cell.key, 1036, t);
    const ca = cellLabels(await unpub());
    ok('cell fr saved', rep.saved === 1 && ca[1036] === t && ca[1033] === cb[1033], { rep: res(rep), cb, ca });
    // Field labels can't be removed (LIVE-FINDINGS 37): clearing writes what the field shows without one, its column's
    // French name, else its English name (LIVE-FINDINGS 42, model.ts standIn); with the column's names not loaded here,
    // it is refused and nothing is written.
    store.set(cell.key, 1036, '');
    const si = store.standIn(cell.key, 1036, ctx.base);
    const rep2 = await editSave(cell.key, 1036, '');
    const cc = cellLabels(await unpub());
    ok('cell clear writes its column name (field label)', (si?.text ? rep2.saved === 1 && cc[1036] === si.text : blocked(rep2) && cc[1036] === t) && cc[1033] === cb[1033], { rep: res(rep2), cc, si });
    store.set(cell.key, 1036, t);
    const rep3 = await editSave(cell.key, 1036, orig(cb[1036], 'Nom'));
    ok('cell restored', rep3.saved === 1 || rep3.noop, res(rep3));

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
    // marked undone, and the undo journaled and published (its Redo).
    const FORM = (await get(`systemforms?$select=formid&$filter=objecttypecode eq '${E}' and type eq 2`)).value[0].formid;
    const fs = await providers.loadFormXml(ctx, [await providers.getForm(ctx, FORM)], [1033, 1036], lo);
    store.add(fs);
    const cell = fs.find((s) => s.kind === 'field' && s.ref?.controlId === 'new_name');
    const cellId = norm(cell.key.split('|')[2]);
    const unpub = async () => xmlDoc((await get(`systemforms(${FORM})/Microsoft.Dynamics.CRM.RetrieveUnpublished()?$select=formxml`)).formxml);
    const cellLabels = (doc) => labelMap([...doc.getElementsByTagName('cell')].find((c) => norm(c.getAttribute('id')) === cellId));
    /** Every label of the form: `<element>#<id>` -> its labels. */
    const allLabels = (doc) => Object.fromEntries([...doc.querySelectorAll('[id]')].filter((x) => x.querySelector(':scope > labels')).map((x) => [`${x.tagName}#${norm(x.getAttribute('id'))}`, labelMap(x)]));
    // Published once the published form's version is the unpublished one (the Publish dialog's own check, review.ts).
    const versions = async () => [(await get(`systemforms(${FORM})?$select=versionnumber`)).versionnumber, (await get(`systemforms(${FORM})/Microsoft.Dynamics.CRM.RetrieveUnpublished()?$select=versionnumber`)).versionnumber];
    const d0 = await unpub();
    const b = cellLabels(d0);
    const all0 = allLabels(d0);
    const t = tgt(b[1036], 'Nom E2E');
    try {
      const rep = await editSave(cell.key, 1036, t, true);
      const e = saver.history().find((x) => x.id === rep.historyId);
      const [p1, u1] = await versions();
      ok('undo after publish (form): saved, published and journaled', rep.saved === 1 && rep.published && !rep.publishError && e?.published && e.items.length === 1 && e.items[0].before === (b[1036] || '') && e.items[0].after === t && cellLabels(await unpub())[1036] === t && p1 === u1, { rep: res(rep), e, p1, u1 });
      if (!e) return;
      const u = await saver.undo(e, opts(true));
      const d1 = await unpub();
      const [p2, u2] = await versions();
      ok('undo after publish (form): the French text is back and published, every other label as it was', u.saved === 1 && u.errors === 0 && u.conflicts === 0 && u.published && !u.publishError && cellLabels(d1)[1036] === b[1036] && JSON.stringify(allLabels(d1)) === JSON.stringify(all0) && p2 === u2, { u: res(u), now: cellLabels(d1), b, p2, u2 });
      const marked = saver.history().find((x) => x.id === e.id);
      const redo = saver.history().find((x) => x.id === u.historyId);
      ok('undo after publish (form): the entry is undone, the undo journaled and published', !!marked?.undoneAt && !marked.kept && redo?.published && redo.items.length === 1 && redo.items[0].before === t && redo.items[0].after === (b[1036] || ''), { marked, redo });
    } finally {
      // Read again first: a write whose answer was lost commits nothing, and the store would take the text for unchanged.
      if (cellLabels(await unpub())[1036] !== b[1036]) {
        store.revert(cell.key, 1036);
        store.add(await providers.loadFormXml(ctx, [await providers.getForm(ctx, FORM)], [1033, 1036], lo));
        await editSave(cell.key, 1036, orig(b[1036], 'Nom'), true);
      }
      // A publish that failed leaves the form unpublished, its published text the test's.
      const [p, u] = await versions();
      if (p !== u) await fetch(api + 'PublishXml', { method: 'POST', headers: { Accept: 'application/json', 'Content-Type': 'application/json' }, body: JSON.stringify({ ParameterXml: `<importexportxml><entities><entity>${E}</entity></entities></importexportxml>` }) });
    }
  });

  await step('sitemap', async () => {
    const SM = '44926ffc-3ec8-f111-b377-7ced8da4e57c';
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
    const WF = '9a6faaaa-82a5-f111-b374-002248b13bc4';
    const orig0 = await get(`workflows(${WF})?$select=xaml,clientdata`);
    localStorage.setItem('dxt:test:bpfOriginal', JSON.stringify({ xaml: orig0.xaml, clientdata: orig0.clientdata }));
    let t = '';
    try {
      const bs = await (providers.loadBpf || providers.loadBpfLabels)(ctx, WF, lo);
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
    const WF = '9a6faaaa-82a5-f111-b374-002248b13bc4';
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
      const bs = await (providers.loadBpf || providers.loadBpfLabels)(ctx, WF, lo);
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
    const WF = '9a6faaaa-82a5-f111-b374-002248b13bc4';
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
      const bs = await providers.loadBpfLabels(ctx, WF, lo);
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
      store.add(await providers.loadBpfLabels(ctx, WF, lo));
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
        const fresh = await providers.loadBpfStored(ctx, await providers.loadBpfLabels(ctx, WF, lo), { entity: orig0.primaryentity, record, app }, lo).catch(() => null);
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
    const sm = await providers.loadSitemap(ctx, '44926ffc-3ec8-f111-b377-7ced8da4e57c', lo);
    ok('unmanaged test sitemap: read as unmanaged, its items editable', sm.length && sm.every((s) => s.ref.managed === false) && sm.some((s) => !s.readOnly), sm.slice(0, 5).map((s) => [s.key, s.readOnly, s.ref.managed]));
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
