// In-page end-to-end tests. Runs in a signed-in Dynamics tab after the DEV build (window.__dxtDev).
// Uses only the test components created for this purpose (table new_dxttest, app new_TranslatorTestApp).
// Every test: edit through the translator → save → verify with independent API reads that the edited
// language changed and every other language and property stayed the same → restore.
(async () => {
  const d = window.__dxtDev;
  if (!d) throw new Error('Load the dev build first.');
  const { ctx, store, providers, app } = d;
  const api = ctx.http.api;
  const H = { Accept: 'application/json', 'If-None-Match': 'null', Consistency: 'Strong' };
  const get = async (u) => {
    const r = await fetch(api + u, { headers: H });
    if (!r.ok) throw new Error(`${r.status} ${u}: ${(await r.text()).slice(0, 200)}`);
    return r.json();
  };
  const labelsOf = (L) => Object.fromEntries((L?.LocalizedLabels || []).map((l) => [l.LanguageCode, l.Label]));
  const loc = async (set, id, col) =>
    labelsOf((await get(`RetrieveLocLabels(EntityMoniker=@e,AttributeName=@a,IncludeUnpublished=@u)?@e=${encodeURIComponent(JSON.stringify({ '@odata.id': `${set}(${id})` }))}&@a='${col}'&@u=true`)).Label);
  const log = [];
  const ok = (name, cond, info) => log.push({ name, pass: !!cond, info: cond ? undefined : info });
  const opts = () => ({ signal: new AbortController().signal, publish: false, onProgress() {} });

  async function editSave(key, lcid, text) {
    store.set(key, lcid, text);
    const changes = store.changes((s) => s.key === key);
    if (!changes.length) throw new Error('no change staged for ' + key);
    return app.saver.save(changes, opts());
  }

  const E = 'new_dxttest';
  const sig = { signal: new AbortController().signal, progress() {}, lang: d.lang };
  const all = new Set(['entity', 'attribute', 'option', 'status', 'state', 'boolean', 'globaloption', 'globaloptionset', 'relationship']);
  store.add(await providers.loadTables(ctx, [E], all, sig));
  ok('metadata loaded', store.get(`attribute|${E}.new_priority|DisplayName`), [...store.slots.keys()].slice(0, 20));

  // 1. Attribute display name (French) — English must stay.
  {
    const key = `attribute|${E}.new_priority|DisplayName`;
    const before = labelsOf((await get(`EntityDefinitions(LogicalName='${E}')/Attributes(LogicalName='new_priority')?$select=DisplayName,Description`)).DisplayName);
    const rep = await editSave(key, 1036, 'Priorité E2E');
    const after = await get(`EntityDefinitions(LogicalName='${E}')/Attributes(LogicalName='new_priority')?$select=DisplayName,Description`);
    const a = labelsOf(after.DisplayName);
    ok('attribute fr saved', rep.saved === 1 && a[1036] === 'Priorité E2E', { rep, a });
    ok('attribute en untouched', a[1033] === before[1033], { before, a });
    await editSave(key, 1036, before[1036] || 'Priorité');
  }
  // 2. Entity plural name (French).
  {
    const key = `entity|${E}|DisplayCollectionName`;
    const b = labelsOf((await get(`EntityDefinitions(LogicalName='${E}')?$select=DisplayCollectionName`)).DisplayCollectionName);
    const rep = await editSave(key, 1036, 'Tests E2E');
    const a = labelsOf((await get(`EntityDefinitions(LogicalName='${E}')?$select=DisplayCollectionName`)).DisplayCollectionName);
    ok('entity plural fr saved', rep.saved === 1 && a[1036] === 'Tests E2E', { rep, a });
    ok('entity plural en untouched', a[1033] === b[1033], { b, a });
    await editSave(key, 1036, b[1036] || 'Tests du traducteur');
  }
  // 3. Option label (French) and boolean.
  for (const [key, attr, value] of [
    [`option|${E}.new_priority|100000001`, 'new_priority', 100000001],
    [`boolean|${E}.new_approved|0`, 'new_approved', 0],
  ]) {
    const cast = attr === 'new_approved' ? 'BooleanAttributeMetadata?$select=LogicalName&$expand=OptionSet($select=TrueOption,FalseOption)' : 'PicklistAttributeMetadata?$select=LogicalName&$expand=OptionSet($select=Options)';
    const read = async () => {
      const r = await get(`EntityDefinitions(LogicalName='${E}')/Attributes(LogicalName='${attr}')/Microsoft.Dynamics.CRM.${cast}`);
      const o = r.OptionSet.Options ? r.OptionSet.Options.find((x) => x.Value === value) : value ? r.OptionSet.TrueOption : r.OptionSet.FalseOption;
      return labelsOf(o.Label);
    };
    const b = await read();
    const rep = await editSave(key, 1036, 'Option E2E');
    const a = await read();
    ok(`${key} fr saved`, rep.saved === 1 && a[1036] === 'Option E2E', { rep, a });
    ok(`${key} en untouched`, a[1033] === b[1033], { b, a });
    await editSave(key, 1036, b[1036] || '');
  }
  // 4. Conflict: change the server value behind the translator's back.
  {
    const key = `attribute|${E}.new_name|Description`;
    const slot = store.get(key);
    store.set(key, 1036, 'Mine');
    await fetch(api + `EntityDefinitions(LogicalName='${E}')/Attributes(LogicalName='new_name')`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json', 'MSCRM.MergeLabels': 'true' },
      body: JSON.stringify({ '@odata.type': 'Microsoft.Dynamics.CRM.StringAttributeMetadata', LogicalName: 'new_name', Description: { LocalizedLabels: [{ Label: slot.labels[1033] || 'Primary name', LanguageCode: 1033 }, { Label: 'Theirs', LanguageCode: 1036 }] } }),
    });
    const rep = await app.saver.save(store.changes((s) => s.key === key), opts());
    const a = labelsOf((await get(`EntityDefinitions(LogicalName='${E}')/Attributes(LogicalName='new_name')?$select=Description`)).Description);
    ok('conflict detected', rep.conflicts === 1 && a[1036] === 'Theirs', { rep, a });
    store.resolve(key, 1036, false);
  }
  return log;
})();
