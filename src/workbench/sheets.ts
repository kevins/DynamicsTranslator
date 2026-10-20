// Sheets of the workbook, as in the XrmToolBox Easy Translator bookmarklet: one sheet per kind of
// component, each with its own key columns (ids and logical names read from slot.ref, slot.entity,
// slot.path and slot.sub), a Type column and one column per language. Pure: no DOM, no network.
// Sheet names match the Excel export (io/workbook.ts), so the tab a developer sees is the sheet name in
// the exported file. A slot that fits no sheet goes to "Other", so nothing loaded is ever invisible.

import { KIND_NAMES, PROP_NAMES, type Kind, type Lcid, type Prop, type Slot } from '../core/model';
import { fold } from '../core/search';
import type { Store } from '../core/store';
import { notLoaded } from '../ui/editor';
import { problem } from './grid';
import type { KeyCol, LabelMode, RowsMode, SetupOpt, SheetCtx, SheetDef } from './types';

/** The searches' folding (core/search.ts): "Filter rows" compares folded texts. */
export { fold };

// ---- key columns ----

/** A GUID as the old workbook showed it: lower case, without braces. */
const B = (id: unknown): string => (id ? String(id).replace(/[{}]/g, '').toLowerCase() : '');
const str = (v: unknown): string => (v === undefined || v === null ? '' : String(v));
type Get = (s: Slot, x: SheetCtx) => string;
/** GUID column: first in the sheet as in the old UI, 120px monospace, the full value as tooltip (grid). */
const G = (id: string, name: string, get: Get): KeyCol => ({ id, name, w: 120, mono: true, get });
/** Name column; `keep` stays visible in a narrow grid. */
const N = (id: string, name: string, get: Get, o: { w?: number; keep?: boolean } = {}): KeyCol => ({ id, name, w: o.w ?? 160, ...(o.keep ? { keep: true } : {}), get });

const ENT = 'Entity Logical Name';
const ent = (o?: { keep?: boolean }) => N('entity', ENT, (s) => s.entity, o);
const formId = (n = 'Form Id') => G('form', n, (s) => B(s.ref?.formId));
const formName = (n = 'Form Name') => N('formname', n, (s) => str(s.path[1]));
const cap = (t: string): string => t.charAt(0).toUpperCase() + t.slice(1);
/** Tab of a form element: its tab's name; header and footer cells say where they are instead. */
const tabOf = (s: Slot): string => (s.ref?.area && s.ref.area !== 'body' ? cap(String(s.ref.area)) : str(s.ref?.tabName ?? s.path[2]));
const sectionOf = (s: Slot): string => str(s.ref?.sectionName ?? s.path[3]);

const names = new WeakMap<Store, { dirty: boolean; m: Map<string, string> }>();
/**
 * Control names of the form fields in the store, by slot key. Copies of one column placed several times on a
 * form can share one control id in the form XML; Dynamics names them <id>, <id>1, <id>2… in form order
 * (LIVE-FINDINGS 41, inspector/scan.ts fieldOf). Plain numbering can repeat a control the form already has:
 * on a customer's Service request form `contoso_client2` is a control of its own (its copies are contoso_client21
 * and contoso_client22), and the copies of contoso_client are contoso_client5, 6 and 7 at runtime (live probes
 * P10). So a copy gets the next number that no other control of the form has, and every row of Forms Fields
 * has its own Control Id. (That Dynamics skips exactly the taken numbers is inferred, not verified.)
 */
function controlNames(store: Store): Map<string, string> {
  let c = names.get(store);
  if (!c) {
    const y = { dirty: true, m: new Map<string, string>() };
    store.on((e) => {
      if (e.type === 'slots') y.dirty = true;
    });
    names.set(store, (c = y));
  }
  if (c.dirty) {
    c.m.clear();
    const forms = new Map<string, Slot[]>();
    for (const x of store.slots.values()) {
      if (x.kind !== 'field' || !x.ref?.controlId) continue;
      const f = String(x.ref.formId);
      const a = forms.get(f);
      if (a) a.push(x);
      else forms.set(f, [x]);
    }
    for (const a of forms.values()) {
      a.sort((p, q) => p.order - q.order || cmp(p.comp, q.comp));
      // Every control id of the form, then every name handed out: a copy's number never repeats one of them.
      const taken = new Set(a.map((x) => String(x.ref.controlId).toLowerCase()));
      const first = new Set<string>();
      for (const x of a) {
        const id = String(x.ref.controlId);
        const k = id.toLowerCase();
        if (!first.has(k)) {
          first.add(k);
          c.m.set(x.key, id);
          continue;
        }
        let n = 1;
        while (taken.has(k + n)) n++;
        taken.add(k + n);
        c.m.set(x.key, id + n);
      }
    }
    c.dirty = false;
  }
  return c.m;
}
/** The name of a form field's control; a copy that shares its control id gets a number (controlNames). */
const controlName = (s: Slot, store: Store): string => (s.ref?.controlId ? (controlNames(store).get(s.key) ?? str(s.ref.controlId)) : '');

/** OptionSet Id of a global choice row: the set's own id, also on the rows of its values. */
const setId = (s: Slot, x: SheetCtx): string =>
  B(s.kind === 'globaloptionset' ? s.ref?.metadataId : (x.store.get(`globaloptionset|${s.ref?.name}|DisplayName`)?.ref?.metadataId ?? s.ref?.setId));

const ATTR_TYPE: Partial<Record<Kind, string>> = { state: 'State', status: 'Status' };

// ---- sheets ----

const sm = (lv: 'Area' | 'Group' | 'SubArea', kind: Kind, i: number): SheetDef => ({
  id: `sitemap${kind}s`,
  name: `SiteMap ${lv}s`,
  kinds: [kind],
  cols: [
    N('sitemap', 'SiteMap Name', (s) => str(s.path[0])),
    G('sitemapid', 'SiteMap Id', (s) => B(s.ref?.sitemapId)),
    ...(i > 0 ? [N('area', 'Area Id', (s: Slot) => str(s.ref?.areaId))] : []),
    ...(i > 1 ? [N('group', 'Group Id', (s: Slot) => str(s.ref?.groupId))] : []),
    N('id', `${lv} Id`, (s) => str(s.ref?.id), { keep: true }),
  ],
  help: `Sitemap ${lv === 'SubArea' ? 'subarea' : lv.toLowerCase()} titles and descriptions: the app's navigation.`,
});

/** Every sheet in tab order: the 20 Easy Translator sheets (Form Navigation right after Forms Fields), then the new ones, 'Other' last. */
export const SHEETS: SheetDef[] = [
  {
    id: 'entities',
    name: 'Entities',
    kinds: ['entity'],
    cols: [G('id', 'Entity Id', (s) => B(s.ref?.metadataId)), ent({ keep: true })],
    help: 'Table names: display name, plural name and description.',
  },
  {
    id: 'attributes',
    name: 'Attributes',
    kinds: ['attribute'],
    cols: [G('id', 'Attribute Id', (s) => B(s.ref?.metadataId)), ent(), N('attr', 'Attribute Logical Name', (s) => str(s.ref?.attribute), { keep: true })],
    type: (s) => (s.prop === 'Description' ? 'Description (tooltip)' : s.prop),
    help: "Column names and descriptions. The name is also the list column header; the description is the field's tooltip on forms.",
  },
  {
    id: 'relationships',
    name: 'Relationships',
    kinds: ['relationship'],
    match: (s) => s.ref?.type === 'OneToMany',
    cols: [G('id', 'Relationship Id', (s) => B(s.ref?.metadataId)), ent(), N('schema', 'Schema Name', (s) => str(s.ref?.schemaName), { w: 200, keep: true })],
    type: () => 'AssociatedMenuLabel',
    help: 'Labels of related-records menu items (one-to-many relationships that use a custom label).',
  },
  {
    id: 'relationshipsnn',
    name: 'RelationshipsNN',
    kinds: ['relationship'],
    match: (s) => s.ref?.type === 'ManyToMany',
    cols: [
      G('id', 'Relationship Id', (s) => B(s.ref?.metadataId)),
      ent(),
      N('schema', 'Schema Name', (s) => str(s.ref?.schemaName), { w: 200, keep: true }),
      N('intersect', 'Intersect Entity', (s) => str(s.ref?.intersect)),
    ],
    // One row per side; the side tells the two rows of a self-referential relationship apart.
    type: (s) => (s.ref?.side === 1 || s.ref?.side === 2 ? `Entity${s.ref.side}AssociatedMenuLabel` : 'AssociatedMenuLabel'),
    help: 'Menu labels of many-to-many relationships, one row for each side.',
  },
  {
    id: 'globaloptionsets',
    name: 'Global OptionSets',
    kinds: ['globaloptionset', 'globaloption'],
    cols: [
      G('id', 'OptionSet Id', setId),
      N('name', 'OptionSet Name', (s) => str(s.ref?.name), { keep: true }),
      N('value', 'Value', (s) => (s.kind === 'globaloption' ? str(s.ref?.value) : ''), { w: 90 }),
      N('usedby', 'Used By', (s) => (Array.isArray(s.ref?.usedBy) ? s.ref.usedBy.join(', ') : ''), { w: 220 }),
    ],
    help: 'Global choices and their values. Changing a value here changes it in every column that uses the choice (Used By).',
  },
  {
    id: 'optionsets',
    name: 'OptionSets',
    kinds: ['option', 'state', 'status'],
    cols: [
      G('id', 'Attribute Id', (s) => B(s.ref?.attributeMetadataId)),
      N('entity', ENT, (s) => str(s.ref?.entity ?? s.entity)),
      N('attr', 'Attribute Logical Name', (s) => str(s.ref?.attribute), { keep: true }),
      N('attrtype', 'Attribute Type', (s) => ATTR_TYPE[s.kind] ?? str(s.ref?.cast || 'Picklist'), { w: 140 }),
      N('value', 'Value', (s) => str(s.ref?.value), { w: 90 }),
    ],
    help: 'Labels of choice values. These are what list cells show for a choice column. Choices that use a global choice are on the Global OptionSets sheet.',
  },
  {
    id: 'booleans',
    name: 'Booleans',
    kinds: ['boolean'],
    cols: [
      G('id', 'Attribute Id', (s) => B(s.ref?.attributeMetadataId)),
      N('entity', ENT, (s) => str(s.ref?.entity ?? s.entity)),
      N('attr', 'Attribute Logical Name', (s) => str(s.ref?.attribute), { keep: true }),
      N('value', 'Value', (s) => str(s.ref?.value), { w: 90 }),
    ],
    help: 'The two labels of Yes/No columns. Yes/No columns that use a global choice are on the Global OptionSets sheet.',
  },
  {
    id: 'views',
    name: 'Views',
    kinds: ['view'],
    cols: [
      G('id', 'View Id', (s) => B(s.ref?.id)),
      ent({ keep: true }),
      N('viewtype', 'ViewType', (s) => (s.ref?.type === undefined || s.ref?.type === null ? s.sub : `${s.sub} (${s.ref.type})`), { w: 180 }),
    ],
    help: 'View names and descriptions. View column headers are the column names on the Attributes sheet.',
  },
  {
    id: 'charts',
    name: 'Charts',
    kinds: ['chart'],
    cols: [G('id', 'Chart Id', (s) => B(s.ref?.id)), ent({ keep: true })],
    help: 'Chart names and descriptions.',
  },
  {
    id: 'forms',
    name: 'Forms',
    kinds: ['form'],
    cols: [G('id', 'Form Id', (s) => B(s.ref?.id)), ent({ keep: true }), N('formtype', 'Form Type', (s) => s.sub)],
    help: 'Form names and descriptions.',
  },
  {
    id: 'formtabs',
    name: 'Forms Tabs',
    kinds: ['tab'],
    cols: [formId(), ent(), formName(), N('tab', 'Tab Name', (s) => str(s.ref?.tabName ?? s.ref?.elId), { keep: true })],
    help: 'Labels of form tabs.',
  },
  {
    id: 'formsections',
    name: 'Forms Sections',
    kinds: ['section'],
    cols: [formId(), ent(), formName(), N('tab', 'Tab Name', (s) => str(s.ref?.tabName)), N('section', 'Section Name', (s) => str(s.ref?.sectionName ?? s.ref?.elId), { keep: true })],
    help: 'Labels of form sections.',
  },
  {
    id: 'formfields',
    name: 'Forms Fields',
    kinds: ['field'],
    cols: [
      formId(),
      ent(),
      formName(),
      N('tab', 'Tab Name', tabOf),
      N('section', 'Section Name', sectionOf),
      N('field', 'Field Name', (s) => str(s.ref?.datafield || s.ref?.controlId), { keep: true }),
      N('control', 'Control Id', (s, x) => controlName(s, x.store)),
    ],
    help: 'The label of this field on this form only. The same column can be on a form several times (header, tabs, quick view); each copy is its own row (Control Id).',
  },
  {
    id: 'formnav',
    name: 'Form Navigation',
    kinds: ['navitem'],
    cols: [formId(), ent(), formName(), N('item', 'Item Id', (s) => str(s.ref?.elId), { w: 200, keep: true })],
    help: "Labels of the related-records items in a form's navigation.",
  },
  sm('Area', 'area', 0),
  sm('Group', 'group', 1),
  sm('SubArea', 'subarea', 2),
  {
    id: 'dashboards',
    name: 'Dashboards',
    kinds: ['dashboard'],
    cols: [G('id', 'Dashboard Id', (s) => B(s.ref?.id)), N('dashtype', 'Dashboard Type', (s) => s.sub, { keep: true })],
    help: 'Dashboard names and descriptions.',
  },
  {
    id: 'dashboardtabs',
    name: 'Dashboards Tabs',
    kinds: ['dtab'],
    cols: [formId('Dashboard Id'), formName('Dashboard Name'), N('tab', 'Tab Name', (s) => str(s.ref?.tabName ?? s.ref?.elId), { keep: true })],
    help: 'Labels of dashboard tabs.',
  },
  {
    id: 'dashboardsections',
    name: 'Dashboards Sections',
    kinds: ['dsection'],
    cols: [
      formId('Dashboard Id'),
      formName('Dashboard Name'),
      N('tab', 'Tab Name', (s) => str(s.ref?.tabName)),
      N('section', 'Section Name', (s) => str(s.ref?.sectionName ?? s.ref?.elId), { keep: true }),
    ],
    help: 'Labels of dashboard sections.',
  },
  {
    id: 'dashboardfields',
    name: 'Dashboards Fields',
    kinds: ['dfield'],
    cols: [
      formId('Dashboard Id'),
      formName('Dashboard Name'),
      N('tab', 'Tab Name', tabOf),
      N('section', 'Section Name', sectionOf),
      N('component', 'Component', (s) => str(s.ref?.controlId), { keep: true }),
    ],
    help: 'Labels of the charts, lists and other components on dashboards.',
  },
  {
    id: 'apps',
    name: 'Apps',
    kinds: ['app'],
    cols: [G('id', 'App Id', (s) => B(s.ref?.id)), N('unique', 'Unique Name', (s) => s.sub, { w: 200, keep: true })],
    help: 'App names and descriptions.',
  },
  {
    id: 'bpfs',
    name: 'Business Process Flows',
    kinds: ['bpf'],
    cols: [G('id', 'Process Id', (s) => B(s.ref?.id)), ent(), N('unique', 'Unique Name', (s) => s.sub, { w: 200, keep: true })],
    help: 'Business process flow names and descriptions.',
  },
  {
    id: 'bpfstages',
    name: 'BPF Stages',
    kinds: ['stage'],
    cols: [
      G('process', 'Process Id', (s) => B(s.ref?.workflowId)),
      N('processname', 'Process Name', (s) => str(s.path[0]), { keep: true }),
      ent(),
      G('stage', 'Stage Id', (s) => B(s.ref?.labelId)),
    ],
    help: 'Stage names of business process flows.',
  },
  {
    id: 'bpfsteps',
    name: 'BPF Steps',
    kinds: ['step'],
    cols: [
      G('process', 'Process Id', (s) => B(s.ref?.workflowId)),
      N('processname', 'Process Name', (s) => str(s.path[0])),
      N('stagename', 'Stage Name', (s) => str(s.path[1])),
      G('step', 'Step Id', (s) => B(s.ref?.labelId)),
      N('attr', 'Attribute', (s) => str(s.ref?.attribute), { keep: true }),
    ],
    help: 'Step labels of business process flows.',
  },
  {
    id: 'commands',
    name: 'Commands',
    kinds: ['command'],
    // The button's own label is its Label row, so no separate name column is needed. A blank table = a global command.
    cols: [G('id', 'Command Id', (s) => B(s.ref?.id)), ent(), N('location', 'Location', (s) => s.sub, { w: 240, keep: true })],
    help: 'Modern command bar buttons: label, tooltip and accessibility text.',
  },
  {
    id: 'ribbon',
    name: 'Ribbon Labels',
    kinds: ['ribbon'],
    cols: [
      N('entity', ENT, (s) => (s.ref?.entity === '_app' ? '(application ribbon)' : str(s.ref?.entity ?? s.entity))),
      N('loclabel', 'LocLabel Id', (s) => str(s.ref?.locLabelId), { w: 280, keep: true }),
    ],
    help: 'Classic command bar (ribbon) labels. Saving them takes about 20 seconds per table.',
  },
  {
    id: 'envvars',
    name: 'Environment Variables',
    kinds: ['envvar'],
    cols: [G('id', 'Variable Id', (s) => B(s.ref?.id)), N('schema', 'Schema Name', (s) => s.sub, { w: 200, keep: true })],
    help: 'Environment variable names, descriptions and hints.',
  },
  {
    id: 'customapis',
    name: 'Custom APIs',
    kinds: ['customapi'],
    cols: [G('id', 'Custom API Id', (s) => B(s.ref?.id)), N('unique', 'Unique Name', (s) => s.sub, { w: 200, keep: true }), N('bound', 'Bound Entity', (s) => s.entity)],
    help: 'Custom API names and descriptions.',
  },
  {
    id: 'other',
    name: 'Other',
    kinds: [],
    cols: [
      { id: 'key', name: 'Key', w: 220, mono: true, get: (s) => s.key },
      N('kind', 'Kind', (s) => KIND_NAMES[s.kind]?.[0] ?? s.kind),
      N('component', 'Component', (s) => [...s.path, s.title].filter(Boolean).join(' › '), { w: 320, keep: true }),
    ],
    help: 'Labels that fit no other sheet.',
  },
];

const OTHER = SHEETS[SHEETS.length - 1];
const BY_KIND = new Map<Kind, SheetDef[]>();
for (const d of SHEETS) for (const k of d.kinds) BY_KIND.set(k, [...(BY_KIND.get(k) || []), d]);

/** The sheet a slot is shown on: the first sheet for its kind whose match() passes, else 'Other'. */
export const sheetOf = (s: Slot): SheetDef => BY_KIND.get(s.kind)?.find((d) => !d.match || d.match(s)) ?? OTHER;

/** Help shown for the Type column of a row: the property name, plus what it is where users asked (§2.4 of the design). */
export function typeTip(s: Slot): string {
  const p = PROP_NAMES[s.prop] ?? s.prop;
  if (s.kind === 'attribute' && s.prop === 'Description') return `${p}: shown as the field's tooltip on forms (the text you see when hovering a field label).`;
  if (s.kind === 'attribute' && s.prop === 'DisplayName') return `${p}: the column's name in list column headers, Advanced find, and form labels unless the form overrides them (see Forms Fields).`;
  if (s.kind === 'field') return `${p} of this field on this form only.${/label hidden/.test(s.sub) ? ' The label is hidden on the form.' : ''}`;
  if (s.kind === 'option' || s.kind === 'state' || s.kind === 'status' || s.kind === 'globaloption' || s.kind === 'boolean')
    return s.prop === 'Label' ? `${p}: what list cells and forms show for this value.` : p;
  return p;
}

// ---- row order ----

const RANK: Prop[] = ['DisplayName', 'DisplayCollectionName', 'Label', 'Name', 'Title', 'ToolTipTitle', 'ToolTipDescription', 'Alt', 'Description', 'Hint'];
const cmp = <T extends string | number>(a: T, b: T): number => (a < b ? -1 : a > b ? 1 : 0);

/**
 * Row order inside a sheet (§2.5, as io/workbook.ts sorts the Excel export): table, container (the comp
 * without its last segment), natural order, comp, then property, so every property of one component sits
 * together in a fixed order. A global choice's own rows sit right above its values.
 */
export function sortSlots(slots: Slot[]): Slot[] {
  return slots
    .map((s) => {
      const set = s.kind === 'globaloptionset';
      return { s, c: set ? `globaloption|${s.ref?.name ?? s.comp.slice(s.comp.indexOf('|') + 1)}` : s.comp.slice(0, s.comp.lastIndexOf('|')), o: set ? -1 : s.order || 0, r: RANK.indexOf(s.prop) };
    })
    .sort((a, b) => cmp(a.s.entity || '', b.s.entity || '') || cmp(a.c, b.c) || a.o - b.o || cmp(a.s.comp, b.s.comp) || a.r - b.r)
    .map((d) => d.s);
}

// ---- filters ----

const NAMES = new Set<Prop>(['DisplayName', 'DisplayCollectionName', 'Label', 'Name', 'Title']);
const DESCRIPTIONS = new Set<Prop>(['Description', 'Hint', 'ToolTipTitle', 'ToolTipDescription', 'Alt']);
/** Label options of the Setup screen: Both, Only Names, Only Descriptions (client-side, nothing is reloaded). */
export const inLabelMode = (s: Slot, m: LabelMode): boolean => (m === 'names' ? NAMES.has(s.prop) : m === 'descriptions' ? DESCRIPTIONS.has(s.prop) : true);

/**
 * The Rows filter, on current values (pending edits included). A language that was not loaded (form tab and
 * section labels without the language switch) is unknown, not blank. Read-only rows don't count for the text
 * comparisons. They do count for Pending changes and Save problems: a row can turn read-only after its edit
 * (a later extraction finds it locked or can't read it), and that edit is still in the pending total while
 * the review refuses it, so it must be findable and is a save problem. A description stored (or saved) empty on
 * purpose is translated, not blank: its users see none (model.ts storedEmpty, Store.emptyOnPurpose).
 */
export function rowsTest(m: RowsMode, store: Store, base: Lcid, target: Lcid, langs: Lcid[]): (s: Slot) => boolean {
  const v = (s: Slot, l: Lcid) => store.value(s.key, l);
  const blank = (s: Slot) => !v(s, target).trim() && !store.emptyOnPurpose(s.key, target, base);
  switch (m) {
    case 'same':
      return (s) => !s.readOnly && !!v(s, base).trim() && v(s, target) === v(s, base);
    case 'sameOrBlank':
      return (s) => {
        const b = v(s, base);
        const t = v(s, target);
        return !s.readOnly && !!b.trim() && (t === b || blank(s)) && !notLoaded(s, target);
      };
    case 'blank':
      return (s) => !s.readOnly && !!v(s, base).trim() && blank(s) && !notLoaded(s, target);
    case 'pending':
      return (s) => store.isEdited(s.key);
    case 'problems':
      return (s) => (s.readOnly ? store.isEdited(s.key) : problem(store, s, langs, base));
    default:
      return () => true;
  }
}

export const ROWS_MODES: RowsMode[] = ['all', 'same', 'sameOrBlank', 'blank', 'pending', 'problems'];

/** Text of a Rows choice, e.g. 'French matches English'. */
export function rowsLabel(m: RowsMode, baseName: string, targetName: string): string {
  switch (m) {
    case 'same':
      return `${targetName} matches ${baseName}`;
    case 'sameOrBlank':
      return `${targetName} matches ${baseName} or is blank`;
    case 'blank':
      return `${targetName} is blank`;
    case 'pending':
      return 'Pending changes';
    case 'problems':
      return 'Save problems';
    default:
      return 'All rows';
  }
}

/** Folded text of everything the row shows (sheet, key columns, type, labels before and after edits), for "Filter rows". */
export function searchText(s: Slot, def: SheetDef, x: SheetCtx, store: Store): string {
  const parts: string[] = [def.name, s.key, def.type ? def.type(s) : s.prop, PROP_NAMES[s.prop] ?? '', s.title, s.sub, ...s.path];
  if (s.entity) parts.push(x.tableName(s.entity));
  for (const c of def.cols) parts.push(c.get(s, x));
  parts.push(...Object.values(s.labels));
  const e = store.edits.get(s.key);
  if (e) parts.push(...e.values());
  return fold(parts.join('\n'));
}

// ---- Setup screen options (§2.6) ----

const opt = (id: string, label: string, kinds: Kind[], needsTable: boolean, def: boolean): SetupOpt => ({ id, label, kinds, needsTable, def });

/**
 * The checkboxes of the Setup screen, with the old tool's labels, and the kinds each one loads. Choices bound to
 * a global choice load with the Picklists and Booleans options too (as globaloption, shown on Global OptionSets).
 * BPF, commands and classic ribbon buttons are slower and start off; so do sitemaps and dashboards (dashboard
 * tab and section labels need the language switch).
 */
export const SETUP_GROUPS: { entity: SetupOpt[]; global: SetupOpt[] } = {
  entity: [
    opt('entity', 'Export Entity Translation', ['entity'], true, true),
    opt('attribute', 'Export Attributes Translation', ['attribute'], true, true),
    opt('option', 'Export Picklists Option Labels Translation', ['option', 'state', 'status', 'globaloption'], true, true),
    opt('boolean', 'Export Booleans Option Labels Translation', ['boolean', 'globaloption'], true, true),
    opt('view', 'Export Views Translation', ['view'], true, true),
    opt('chart', 'Export Charts Translation', ['chart'], true, true),
    opt('form', 'Export Forms Translation', ['form'], true, true),
    opt('tab', 'Export Forms Tabs Translation', ['tab'], true, true),
    opt('section', 'Export Forms Sections Translation', ['section'], true, true),
    opt('field', 'Export Forms Fields Translation', ['field'], true, true),
    opt('relationship', 'Export Relationships that are using custom labels', ['relationship'], true, true),
    opt('navitem', 'Export Forms Navigation Translation', ['navitem'], true, true),
    opt('bpf', 'Export Business Process Flows Translation', ['bpf', 'stage', 'step'], true, false),
    opt('command', 'Export Command Bar Buttons Translation', ['command'], true, false),
    opt('ribbon', 'Export Ribbon Buttons (classic) Translation', ['ribbon'], true, false),
  ],
  global: [
    opt('globaloptionset', 'Export Global OptionSets Labels Translation', ['globaloptionset', 'globaloption'], false, true),
    opt('sitemap', 'Export SiteMap custom labels Translation', ['area', 'group', 'subarea'], false, false),
    opt('dashboard', 'Export Dashboards custom labels Translation', ['dashboard', 'dtab', 'dsection', 'dfield'], false, false),
    opt('app', 'Export Apps Translation', ['app'], false, false),
    opt('envvar', 'Export Environment Variables Translation', ['envvar'], false, false),
    opt('customapi', 'Export Custom APIs Translation', ['customapi'], false, false),
  ],
};
const ALL_OPTS = [...SETUP_GROUPS.entity, ...SETUP_GROUPS.global];

/** Kinds to load for the checked options (an option missing from `opts` counts with its default). */
export const kindsOf = (opts: Record<string, boolean>): Set<Kind> => {
  const out = new Set<Kind>();
  for (const o of ALL_OPTS) if (opts[o.id] ?? o.def) for (const k of o.kinds) out.add(k);
  return out;
};
