// Unit tests for why a table's or column's labels can't be translated here (providers/metadata.ts notCustomizable,
// notRenameable): a managed solution's component is read-only whatever its managed properties allow (MANAGED), an
// unmanaged one as its managed properties say, the same words wherever the reason shows (popup, list, Workbench, Publish
// dialog, an import's skipped rows) and when a save finds it changed. The side menu's "Catégories" (the system table category, IsRenameable false
// and locked, LIVE-FINDINGS 99) keeps Microsoft's language-pack reason. register() is called by tools/dev/unit.ts.
import { MANAGED, PublishSet, type Change, type Kind, type Slot } from '../../../src/core/model';
import { Store } from '../../../src/core/store';
import { describe } from '../../../src/inspector/describe';
import { look } from '../../../src/inspector/status';
import type { Anchor } from '../../../src/inspector/types';
import { CSV_KEY, createIo } from '../../../src/io/workbook';
import { loadMetadataScope, loadTables, metadataWriters, notCustomizable, notRenameable } from '../../../src/providers/metadata';
import type { Scope } from '../../../src/providers/types';
import type { AppApi } from '../../../src/ui/types';
import type { Kit } from './kit';
import { fast } from './lang';

const EN = 1033;
const FR = 1036;
const ID = '0c0c0c0c-0000-4000-8000-00000000000c';
const lab = (en: string, fr: string) => ({ LocalizedLabels: [{ Label: en, LanguageCode: EN }, { Label: fr, LanguageCode: FR }] });
const ren = (Value: boolean, CanBeChanged?: boolean) => ({ Value, ...(CanBeChanged === undefined ? {} : { CanBeChanged }), ManagedPropertyLogicalName: 'isrenameable' });

/**
 * A metadata read as Dataverse answers it: only what its $select and $expand name (annotations kept), everything without
 * a $select. A writer whose read stops asking for IsManaged then never sees it.
 */
const selected = (u: string, v: any): any => {
  const sel = /[?&]\$select=([^&]*)/.exec(u)?.[1].split(',');
  if (!sel || !v || typeof v !== 'object') return v;
  const exp = (/[?&]\$expand=([^&]*)/.exec(u)?.[1] ?? '').split(',').map((x) => x.replace(/\(.*$/, ''));
  return Object.fromEntries(Object.entries(v).filter(([k]) => k.startsWith('@') || sel.includes(k) || exp.includes(k)));
};

const MS_TABLE ="Microsoft locks renaming of this table: its names can't be changed, in any language. Dynamics shows Microsoft's own text for them (the language pack).";
const MS_COLUMN = "Microsoft locks renaming of this column: its name can't be changed, in any language. Dynamics shows Microsoft's own text for it (the language pack).";
const OFF_COLUMN = "Renaming is turned off for this column (its “Display name can be modified” managed property). Turn it on in the column's managed properties to translate it here.";

export function register(t: Kit): void {
  const { test, eq } = t;

  test("lock reasons: renaming locked by Microsoft (its language pack, managed or not), by a solution, turned off; not customizable; a managed solution's component always; the right noun", () => {
    const sys = { IsCustomizable: { Value: true }, IsManaged: true, IsRenameable: ren(false, false) };
    // Microsoft's own names keep their reason (the grey built-in look), although the table is managed.
    eq(notRenameable(sys, 'table', false), MS_TABLE);
    eq(notRenameable(sys, 'column', false), MS_COLUMN);
    // Anything else of a managed solution's component: MANAGED, whatever its managed properties allow.
    eq(notRenameable(sys, 'table', true), MANAGED, 'a solution locks renaming it');
    eq(notRenameable({ ...sys, IsRenameable: ren(false, true) }, 'column', false), MANAGED, 'renaming turned off');
    eq([notRenameable({ ...sys, IsRenameable: ren(true, false) }, 'table', false), notCustomizable(sys, 'table')], [MANAGED, MANAGED], 'renameable, customizable');
    eq(notRenameable({ ...sys, IsCustomizable: { Value: false } }, 'table', false), MANAGED, 'not customizable');
    for (const noun of ['table', 'column', 'choice column', 'relationship', 'global choice'] as const) eq(notCustomizable(sys, noun), MANAGED, noun);
    // An unmanaged one follows its managed properties.
    const own = { ...sys, IsManaged: false };
    eq(notRenameable(own, 'table', true), "The solution this table comes from locks renaming it: its names can't be changed, in any language.");
    eq(notRenameable({ ...own, IsRenameable: ren(false, true) }, 'column', false), OFF_COLUMN);
    eq(notRenameable({ ...own, IsRenameable: ren(false) }, 'table', false), "Renaming is turned off for this table, so its names can't be changed here.", 'CanBeChanged not read');
    eq([notRenameable({ ...own, IsRenameable: ren(true, false) }, 'table', false), notCustomizable(own, 'table')], ['', ''], 'renameable, customizable');
    // Not customizable comes first: renaming says nothing then.
    const locked = { ...own, IsCustomizable: { Value: false } };
    eq(notRenameable(locked, 'table', false), "This table is marked as not customizable (its “Allow customizations” managed property is off), so its labels can't be changed here.");
    eq(notCustomizable(locked, 'choice column'), "This choice column is marked as not customizable (its “Allow customizations” managed property is off), so its labels can't be changed here.");
    eq(notCustomizable(locked, 'relationship', true), MANAGED, 'managed as told');
  });

  test('lock reasons as loaded: a system table whose renaming Microsoft locks (category) has both names read-only with that reason, grey built-in where every language has text; its description and its managed column are read-only with MANAGED; an unmanaged column its solution locks says so', async () => {
    const category = {
      LogicalName: 'category',
      MetadataId: ID,
      DisplayName: lab('Category', 'Catégorie'),
      DisplayCollectionName: lab('Categories', 'Catégories'),
      Description: lab('Category for a knowledge article.', ''),
      IsCustomizable: { Value: true },
      IsManaged: true,
      IsCustomEntity: false,
      IsRenameable: ren(false, false),
      Attributes: [
        { LogicalName: 'title', MetadataId: ID, AttributeType: 'String', DisplayName: lab('Title', 'Titre'), Description: lab('', ''), IsCustomizable: { Value: true }, IsManaged: true, IsCustomAttribute: false, IsRenameable: ren(false, true), IsValidForForm: true },
        { LogicalName: 'new_code', MetadataId: ID, AttributeType: 'String', DisplayName: lab('Code', 'Code'), Description: lab('', ''), IsCustomizable: { Value: true }, IsManaged: false, IsCustomAttribute: true, IsRenameable: ren(false, false), IsValidForForm: true },
      ],
    };
    const urls: string[] = [];
    const http = {
      get: async (u: string) => (urls.push(u), category),
      all: async () => [],
    };
    const slots = await loadTables({ http, user: FR, base: EN, langs: [] } as never, ['category'], new Set<Kind>(['entity', 'attribute']), { signal: new AbortController().signal, progress() {} });
    const ro = Object.fromEntries(slots.map((s) => [s.key, s.readOnly]));
    eq(ro['entity|category|DisplayName'], MS_TABLE);
    eq(ro['entity|category|DisplayCollectionName'], MS_TABLE);
    eq(ro['entity|category|Description'], MANAGED);
    eq([ro['attribute|category.title|DisplayName'], ro['attribute|category.title|Description']], [MANAGED, MANAGED]);
    eq([ro['attribute|category.new_code|DisplayName'], ro['attribute|category.new_code|Description']], ["The solution this column comes from locks renaming it: its name can't be changed, in any language.", '']);
    eq(Object.fromEntries(slots.map((s) => [s.key, s.ref.managed])), {
      'entity|category|DisplayName': true,
      'entity|category|DisplayCollectionName': true,
      'entity|category|Description': true,
      'attribute|category.new_code|DisplayName': false,
      'attribute|category.new_code|Description': false,
      'attribute|category.title|DisplayName': true,
      'attribute|category.title|Description': true,
    });
    t.ok(urls[0].includes('IsCustomEntity') && urls[0].includes('IsCustomAttribute'), urls[0]);

    // The page: the subarea "Catégories" maps to the plural name (scan.ts). Grey built-in (text in every language), and
    // its popup says why, without the full stop.
    const store = new Store();
    store.add(slots);
    const app = { store, ctx: { base: EN, user: FR, langs: [{ lcid: EN, name: 'English', isBase: true }, { lcid: FR, name: 'French', isBase: false }] }, prefs: { target: FR, shown: [], showNames: false, dock: 'right' } } as unknown as AppApi;
    eq(look(app, 'entity|category'), 'builtin');
    const a: Anchor = { el: {} as Element, comp: 'entity|category', kind: 'entity', key: 'entity|category|DisplayCollectionName', role: 'nav', focus: 'entity|category|DisplayCollectionName' };
    const m = describe(app, 'entity|category', a);
    eq([m.kind, m.title, m.readOnly], ['Menu item', 'Catégories', MS_TABLE.replace(/\.$/, '')]);
  });

  test('lock reasons at save: an unmanaged column whose renaming was turned off since it loaded is refused with the words of its load (never written); a choice of a column no longer customizable too; one from a managed solution, as loaded or as read, with MANAGED', () =>
    fast(async () => {
      let view: any = { '@odata.type': '#Microsoft.Dynamics.CRM.StringAttributeMetadata', LogicalName: 'title', DisplayName: lab('Title', 'Titre'), Description: lab('', ''), IsCustomizable: { Value: true }, IsRenameable: ren(false, true) };
      const sent: string[] = [];
      const http = {
        get: async (u: string) => (sent.push(`GET ${u.split('?')[0]}`), selected(u, view)),
        batch: async () => {
          sent.push('batch');
          throw new Error('nothing may be written');
        },
        put: async () => void sent.push('PUT'),
        post: async () => void sent.push('POST'),
      };
      const ctx = { http, base: EN, user: FR, orgId: `locks-${Math.random()}`, langs: [EN, FR].map((l) => ({ lcid: l, name: String(l), isBase: l === EN })) };
      const slot = (kind: string, prop: string, ref: Record<string, unknown>): Slot =>
        ({ ...t.slot(kind, `${kind}|category.title|${prop}`, { [EN]: 'Title', [FR]: 'Titre' }), prop, comp: `${kind}|category.title`, group: `${kind}|category.title`, ref }) as Slot;
      const o = () => ({ signal: new AbortController().signal, publish: new PublishSet(), progress() {}, force: new Set<string>(), lang: null as never, allowPublish: true });
      const w = (k: string) => metadataWriters.find((x) => x.kinds.includes(k as never))!;
      const dn = slot('attribute', 'DisplayName', { entity: 'category', attribute: 'title', managed: false, custom: false });
      const res = await w('attribute').save(ctx as never, [{ slot: dn, lcid: FR, before: 'Titre', after: 'Intitulé' } as Change], o());
      eq(res.map((r) => [r.outcome, r.message]), [['error', OFF_COLUMN]]);
      view = { ...view, IsCustomizable: { Value: false } };
      const res2 = await w('attribute').save(ctx as never, [{ slot: dn, lcid: FR, before: 'Titre', after: 'Intitulé' } as Change], o());
      eq(res2.map((r) => r.message), ["This column is marked as not customizable (its “Allow customizations” managed property is off), so its labels can't be changed here."]);
      // The read right before the write shows it from a managed solution now: refused, whatever its managed properties allow.
      view = { ...view, IsCustomizable: { Value: true }, IsRenameable: ren(true, true), IsManaged: true };
      const res2b = await w('attribute').save(ctx as never, [{ slot: dn, lcid: FR, before: 'Titre', after: 'Intitulé' } as Change], o());
      eq(res2b.map((r) => [r.outcome, r.message]), [['error', MANAGED]]);
      // Loaded from a managed solution: refused before anything is read.
      const reads = sent.length;
      const mdn = slot('attribute', 'Description', { entity: 'category', attribute: 'title', managed: true, custom: false });
      const res2c = await w('attribute').save(ctx as never, [{ slot: mdn, lcid: FR, before: '', after: 'Le titre' } as Change], o());
      eq([res2c.map((r) => [r.outcome, r.message]), sent.length - reads], [[['error', MANAGED]], 0]);
      // A local choice: its column's IsCustomizable and IsManaged, and its own choice's IsManaged, as the option writer reads them.
      view = { LogicalName: 'k', IsCustomizable: { Value: false }, IsManaged: false, OptionSet: { IsManaged: false, Options: [{ Value: 1, Label: lab('One', 'Un'), Description: lab('', '') }] } };
      const opt = { ...slot('option', 'Label', { entity: 'category', attribute: 'k', value: 1, cast: 'Picklist', managed: false }), key: 'option|category.k|1|Label', comp: 'option|category.k|1', group: 'option|category.k' } as Slot;
      const res3 = await w('option').save(ctx as never, [{ slot: opt, lcid: FR, before: 'Un', after: 'Une' } as Change], o());
      eq(res3.map((r) => r.message), ["This choice column is marked as not customizable (its “Allow customizations” managed property is off), so its labels can't be changed here."]);
      view = { ...view, IsCustomizable: { Value: true }, OptionSet: { ...view.OptionSet, IsManaged: true } };
      const res4 = await w('option').save(ctx as never, [{ slot: opt, lcid: FR, before: 'Un', after: 'Une' } as Change], o());
      eq(res4.map((r) => [r.outcome, r.message]), [['error', MANAGED]], 'its choice from a managed solution');
      eq(sent.filter((x) => !x.startsWith('GET')), [], 'nothing written');
    }),
  );

  test("managed metadata as loaded: a managed solution's table, column, local choice (its column's or its own choice), Yes/No, status, status reason, relationship menu label and global choice with its options are read-only with MANAGED; an unmanaged custom column, choice, relationship and global choice of the managed table stay editable; the Workbench leaves the read-only ones out unless asked for", async () => {
    const opt = (v: number, en: string, fr: string) => ({ Value: v, MetadataId: ID, Label: lab(en, fr), Description: lab('', '') });
    const col = (n: string, managed: boolean, o: Record<string, unknown> = {}) => ({
      LogicalName: n,
      MetadataId: ID,
      AttributeType: 'String',
      DisplayName: lab(n, n + ' fr'),
      Description: lab('', ''),
      IsCustomizable: { Value: true },
      IsManaged: managed,
      IsCustomAttribute: !managed,
      IsRenameable: ren(true, true),
      IsValidForForm: true,
      ...o,
    });
    const menu = (en: string) => ({ Behavior: 'UseLabel', Label: lab(en, en + ' fr') });
    const account = {
      LogicalName: 'account',
      MetadataId: ID,
      DisplayName: lab('Account', 'Compte'),
      DisplayCollectionName: lab('Accounts', 'Comptes'),
      Description: lab('Business', 'Entreprise'),
      IsCustomizable: { Value: true },
      IsManaged: true,
      IsCustomEntity: false,
      IsRenameable: ren(true, true),
      Attributes: [col('name', true), col('new_tier', false)],
      OneToManyRelationships: [{ SchemaName: 'account_contacts', MetadataId: ID, ReferencedEntity: 'account', ReferencingEntity: 'contact', AssociatedMenuConfiguration: menu('Contacts'), IsCustomizable: { Value: true }, IsManaged: true }],
      ManyToOneRelationships: [{ SchemaName: 'new_account_tier', MetadataId: ID, ReferencedEntity: 'account', ReferencingEntity: 'new_tier', AssociatedMenuConfiguration: menu('Tiers'), IsCustomizable: { Value: true }, IsManaged: false }],
      ManyToManyRelationships: [],
    };
    const global = (name: string, managed: boolean) => ({ Name: name, MetadataId: ID, IsGlobal: true, IsManaged: managed, IsCustomizable: { Value: true }, DisplayName: lab(name, name + ' fr'), Description: lab('', ''), Options: [opt(1, 'One', 'Un')] });
    const local = (managed: boolean, options = [opt(1, 'One', 'Un')]) => ({ IsGlobal: false, IsManaged: managed, Options: options });
    const typed: Record<string, unknown[]> = {
      Picklist: [
        { LogicalName: 'industrycode', MetadataId: ID, IsManaged: true, IsCustomizable: { Value: true }, OptionSet: local(true) },
        { LogicalName: 'new_size', MetadataId: ID, IsManaged: false, IsCustomizable: { Value: true }, OptionSet: local(false) },
        { LogicalName: 'new_mixed', MetadataId: ID, IsManaged: false, IsCustomizable: { Value: true }, OptionSet: local(true) },
        { LogicalName: 'new_color', MetadataId: ID, IsManaged: false, IsCustomizable: { Value: true }, OptionSet: global('new_color', false) },
        { LogicalName: 'new_ms', MetadataId: ID, IsManaged: false, IsCustomizable: { Value: true }, OptionSet: global('msdyn_global', true) },
      ],
      MultiSelectPicklist: [],
      Boolean: [
        { LogicalName: 'donotemail', MetadataId: ID, IsManaged: true, OptionSet: { IsGlobal: false, IsManaged: true, TrueOption: opt(1, 'Do Not Allow', 'Ne pas autoriser'), FalseOption: opt(0, 'Allow', 'Autoriser') } },
        { LogicalName: 'new_ok', MetadataId: ID, IsManaged: false, OptionSet: { IsGlobal: false, IsManaged: false, TrueOption: opt(1, 'Yes', 'Oui'), FalseOption: opt(0, 'No', 'Non') } },
      ],
      Status: [{ LogicalName: 'statuscode', MetadataId: ID, IsManaged: true, OptionSet: local(true, [opt(1, 'Active', 'Actif')]) }],
      State: [{ LogicalName: 'statecode', MetadataId: ID, IsManaged: true, OptionSet: local(true, [opt(0, 'Active', 'Actif')]) }],
    };
    const http = {
      get: async (u: string) => {
        if (u.startsWith("EntityDefinitions(LogicalName='account')?")) return account;
        throw new Error(`unexpected GET ${u}`);
      },
      all: async (u: string) => typed[/CRM\.(\w+)AttributeMetadata\?/.exec(u)?.[1] ?? ''] ?? [],
    };
    const ctx = { http, user: FR, base: EN, langs: [] } as never;
    const lo = () => ({ signal: new AbortController().signal, progress() {} });
    const kinds = new Set<Kind>(['entity', 'attribute', 'option', 'boolean', 'status', 'state', 'relationship', 'globaloptionset', 'globaloption']);
    const slots = await loadTables(ctx, ['account'], kinds, lo());
    const ro = Object.fromEntries(slots.map((x) => [x.key, x.readOnly === MANAGED ? 'managed' : x.readOnly || 'editable']));
    eq(ro, {
      'entity|account|DisplayName': 'managed',
      'entity|account|DisplayCollectionName': 'managed',
      'entity|account|Description': 'managed',
      'attribute|account.name|DisplayName': 'managed',
      'attribute|account.name|Description': 'managed',
      'attribute|account.new_tier|DisplayName': 'editable',
      'attribute|account.new_tier|Description': 'editable',
      'option|account.industrycode|1|Label': 'managed',
      'option|account.industrycode|1|Description': 'managed',
      'option|account.new_size|1|Label': 'editable',
      'option|account.new_size|1|Description': 'editable',
      'option|account.new_mixed|1|Label': 'managed',
      'option|account.new_mixed|1|Description': 'managed',
      'boolean|account.donotemail|0|Label': 'managed',
      'boolean|account.donotemail|0|Description': 'managed',
      'boolean|account.donotemail|1|Label': 'managed',
      'boolean|account.donotemail|1|Description': 'managed',
      'boolean|account.new_ok|0|Label': 'editable',
      'boolean|account.new_ok|0|Description': 'editable',
      'boolean|account.new_ok|1|Label': 'editable',
      'boolean|account.new_ok|1|Description': 'editable',
      'status|account.statuscode|1|Label': 'managed',
      'status|account.statuscode|1|Description': 'managed',
      'state|account.statecode|0|Label': 'managed',
      'state|account.statecode|0|Description': 'managed',
      'relationship|account_contacts|Label': 'managed',
      'relationship|new_account_tier|Label': 'editable',
      'globaloptionset|msdyn_global|DisplayName': 'managed',
      'globaloptionset|msdyn_global|Description': 'managed',
      'globaloption|msdyn_global|1|Label': 'managed',
      'globaloption|msdyn_global|1|Description': 'managed',
      'globaloptionset|new_color|DisplayName': 'editable',
      'globaloptionset|new_color|Description': 'editable',
      'globaloption|new_color|1|Label': 'editable',
      'globaloption|new_color|1|Description': 'editable',
    });
    t.ok(slots.every((x) => !!x.ref.managed === (x.readOnly === MANAGED)), 'ref.managed says the same');
    // The Workbench, without read-only labels: the editable ones only; with them, all, read-only as loaded.
    const wb = await loadMetadataScope(ctx, { entities: ['account'], kinds }, lo());
    eq(wb.map((x) => x.key).sort(), Object.keys(ro).filter((k) => ro[k] === 'editable').sort());
    eq((await loadMetadataScope(ctx, { entities: ['account'], kinds, includeReadOnly: true }, lo())).length, slots.length);
  });

  test('managed metadata at save: a table, a global choice and its option, and a relationship menu label, from a managed solution as loaded (nothing read) or as read right before the write, are refused with MANAGED and never written', () =>
    fast(async () => {
      const sent: string[] = [];
      let managed = false;
      const views: Array<[string, () => unknown]> = [
        ["EntityDefinitions(LogicalName='account')?", () => ({ LogicalName: 'account', DisplayName: lab('Account', 'Compte'), DisplayCollectionName: lab('Accounts', 'Comptes'), Description: lab('', ''), IsCustomizable: { Value: true }, IsRenameable: ren(true, true), IsManaged: managed })],
        ["GlobalOptionSetDefinitions(Name='new_color')", () => ({ MetadataId: ID, Name: 'new_color', DisplayName: lab('Color', 'Couleur'), Description: lab('', ''), IsCustomizable: { Value: true }, IsManaged: managed, Options: [{ Value: 1, Label: lab('Red', 'Rouge'), Description: lab('', '') }] })],
        [`RelationshipDefinitions(${ID})/`, () => ({ SchemaName: 'account_contacts', AssociatedMenuConfiguration: { Behavior: 'UseLabel', Label: lab('Contacts', 'Contacts') }, IsCustomizable: { Value: true }, IsManaged: managed })],
      ];
      const http = {
        get: async (u: string) => {
          sent.push(`GET ${u.split('?')[0]}`);
          const v = views.find(([k]) => u.startsWith(k));
          if (!v) throw new Error(`unexpected GET ${u}`);
          // Only what the read asks for: one that leaves out IsManaged gets no IsManaged.
          return selected(u, v[1]());
        },
        batch: async () => {
          sent.push('batch');
          throw new Error('nothing may be written');
        },
        put: async () => void sent.push('PUT'),
        post: async () => void sent.push('POST'),
      };
      const ctx = { http, base: EN, user: FR, orgId: `managed-${Math.random()}`, langs: [EN, FR].map((l) => ({ lcid: l, name: String(l), isBase: l === EN })) };
      const o = () => ({ signal: new AbortController().signal, publish: new PublishSet(), progress() {}, force: new Set<string>(), lang: null as never, allowPublish: true });
      const w = (k: string) => metadataWriters.find((x) => x.kinds.includes(k as never))!;
      const mk = (kind: string, comp: string, prop: string, labels: Record<number, string>, ref: Record<string, unknown>, group = comp): Slot =>
        ({ ...t.slot(kind, `${comp}|${prop}`, labels), prop, comp, group, ref }) as Slot;
      const cases: Array<[Slot, string, string]> = [
        [mk('entity', 'entity|account', 'Description', {}, { entity: 'account', metadataId: ID, custom: false }), '', 'Entreprise'],
        [mk('globaloptionset', 'globaloptionset|new_color', 'DisplayName', { [EN]: 'Color', [FR]: 'Couleur' }, { name: 'new_color', metadataId: ID, boolean: false }), 'Couleur', 'Teinte'],
        [mk('globaloption', 'globaloption|new_color|1', 'Label', { [EN]: 'Red', [FR]: 'Rouge' }, { name: 'new_color', value: 1, optionMetadataId: ID, setId: ID, usedBy: [], boolean: false }, 'globaloption|new_color'), 'Rouge', 'Carmin'],
        [mk('relationship', 'relationship|account_contacts', 'Label', { [EN]: 'Contacts', [FR]: 'Contacts' }, { schemaName: 'account_contacts', metadataId: ID, type: 'OneToMany', referenced: 'account', referencing: 'contact' }, 'relationship|account_contacts'), 'Contacts', 'Les contacts'],
      ];
      for (const [slot, before, after] of cases) {
        // As loaded from a managed solution: nothing read.
        const n = sent.length;
        const asLoaded = await w(slot.kind).save(ctx as never, [{ slot: { ...slot, ref: { ...slot.ref, managed: true } }, lcid: FR, before, after } as Change], o());
        eq([asLoaded.map((r) => [r.outcome, r.message]), sent.length - n], [[['error', MANAGED]], 0], slot.kind);
        // Loaded as this environment's, read as a managed solution's right before the write.
        managed = true;
        const asRead = await w(slot.kind).save(ctx as never, [{ slot: { ...slot, ref: { ...slot.ref, managed: false } }, lcid: FR, before, after } as Change], o());
        eq(asRead.map((r) => [r.outcome, r.message]), [['error', MANAGED]], slot.kind);
        managed = false;
      }
      eq(sent.filter((x) => !x.startsWith('GET')), [], 'nothing written');
    }),
  );

  test("import: rows of a managed solution's table and column, loaded through the Workbench's loader as the file's scope asks, are skipped with the managed reason, never as not matched; the row of its unmanaged column is staged", async () => {
    const col = (n: string, managed: boolean) => ({ LogicalName: n, MetadataId: ID, AttributeType: 'String', DisplayName: lab(n, `${n} fr`), Description: lab('', ''), IsCustomizable: { Value: true }, IsManaged: managed, IsCustomAttribute: !managed, IsRenameable: ren(true, true), IsValidForForm: true });
    const account = { LogicalName: 'account', MetadataId: ID, DisplayName: lab('Account', 'Compte'), DisplayCollectionName: lab('Accounts', 'Comptes'), Description: lab('', ''), IsCustomizable: { Value: true }, IsManaged: true, IsCustomEntity: false, IsRenameable: ren(true, true), Attributes: [col('name', true), col('new_tier', false)] };
    const http = {
      get: async (u: string) => {
        if (u.startsWith("EntityDefinitions(LogicalName='account')?")) return account;
        throw new Error(`unexpected GET ${u}`);
      },
      all: async () => [],
    };
    const ctx = { http, user: FR, base: EN, langs: [] } as never;
    const io = createIo();
    const rows = [`${CSV_KEY},Type,Table,Component,Property,1033,1036`, 'entity|account|DisplayName,,account,,,Account,Compte 2', 'attribute|account.name|DisplayName,,account,,,name,Nom 2', 'attribute|account.new_tier|DisplayName,,account,,,new_tier,Niveau'];
    const p = await io.parse(new File([rows.join('\r\n')], 'labels.csv'));
    // As the Workbench imports: the file's scope loaded, then applied.
    const imported = async (scope: Scope) => {
      const store = new Store();
      store.add(await loadMetadataScope(ctx, scope, { signal: new AbortController().signal, progress() {} }));
      return { r: io.apply(p, store), store };
    };
    const { r, store } = await imported(p.scope);
    eq(r.skipped.map((s) => [s.key, s.reason]), [
      ['entity|account|DisplayName', `Read-only: ${MANAGED}`],
      ['attribute|account.name|DisplayName', `Read-only: ${MANAGED}`],
    ]);
    eq(store.changes().map((c) => [c.slot.key, c.after]), [['attribute|account.new_tier|DisplayName', 'Niveau']]);
    // Loaded as an extraction without read-only labels is, they would not be there to say why.
    const without = await imported({ ...p.scope, includeReadOnly: false });
    eq(without.r.skipped.map((s) => s.reason), ['No matching component in this environment', 'No matching component in this environment']);
  });
}
