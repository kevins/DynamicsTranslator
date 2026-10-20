// Unit tests for inspector/parts.ts: texts that show several labels (multi-select values, linked-table headers), the
// tables a grid's query reads, and the form and grid ids the DOM carries (LIVE-FINDINGS 54–58, 88). Pure: no DOM.
import { formIdOf, linkedColumn, linkedHeader, lpGrid, lpQuickForm, namePart, queryLinks, queryTable, relatedTable, valueParts } from '../../../src/inspector/parts';
import { pickPart } from '../../../src/inspector/overlay';
import type { Anchor } from '../../../src/inspector/types';
import type { Kit } from './kit';

const FORM = 'a9c89206-0000-4000-8000-000000000073';
const VIEW = 'b0618642-0000-4000-8000-000000000061';
/** contact's "People Associated View" (savedquery, querytype 2), live on account "DXT BPF Test". */
const ASSOC = '00000000-0000-0000-00aa-000010001210';

export function register(t: Kit): void {
  const { test, eq } = t;
  const set = (...v: string[]) => new Set(v);
  const at = (p: { start: number; end: number; text: string } | undefined) => p && [p.start, p.end, p.text];

  test('valueParts: each selected value where the control text shows it, in the chips\' order', () => {
    eq(valueParts('Rouge, Bleu', ['Rouge', 'Bleu'])?.map(at), [
      [0, 5, 'Rouge'],
      [7, 11, 'Bleu'],
    ]);
    eq(valueParts(' Rouge ; Bleu ', ['Rouge', 'Bleu'])?.map(at), [
      [1, 6, 'Rouge'],
      [9, 13, 'Bleu'],
    ], 'semicolons and spaces');
    eq(valueParts('Oui, peut-être, Bleu', ['Oui, peut-être', 'Bleu'])?.map((p) => p.text), ['Oui, peut-être', 'Bleu'], 'a label holding a comma');
    eq(valueParts('Rouge', ['Rouge'])?.map(at), [[0, 5, 'Rouge']], 'one value');
    eq(valueParts('Bleu, Rouge', ['Rouge', 'Bleu']), null, 'another order: the text is not these chips');
    eq(valueParts('Rouge, Vert, Bleu', ['Rouge', 'Bleu']), null, 'a value the chips do not have');
    eq(valueParts('Rouge Bleu', ['Rouge', 'Bleu']), null, 'no separator');
    eq(valueParts('Rouge, Bleu, ', ['Rouge', 'Bleu']), null, 'something after the last value');
    eq(valueParts('x Rouge', ['Rouge']), null, 'something before the first value');
    eq(valueParts('Rouge', ['']), null, 'a chip without text');
  });

  test('linkedHeader: the related column\'s name, and the lookup\'s name in brackets (LIVE-FINDINGS 57)', () => {
    const r = linkedHeader('Nom lié (Test lié)', set('nom lié', 'linked name'), set('test lié', 'linked test'));
    eq([at(r.col), at(r.look)], [
      [0, 7, 'Nom lié'],
      [9, 17, 'Test lié'],
    ]);
    // Names with brackets of their own: the split where both are known names.
    const b = linkedHeader('Montant (HT) (Compte (principal))', set('montant (ht)'), set('compte (principal)'));
    eq([at(b.col), at(b.look)], [
      [0, 12, 'Montant (HT)'],
      [14, 32, 'Compte (principal)'],
    ]);
    // The lookup's name unknown (not loaded, or a preview): only the column's part, at the last bracket.
    const u = linkedHeader('  Nom lié (Autre)  ', set('nom lié'), set('test lié'));
    eq([at(u.col), u.look], [[2, 9, 'Nom lié'], undefined]);
    eq(at(linkedHeader('Nom lié', set('nom lié'), set()).col), [0, 7, 'Nom lié'], 'no brackets: the whole text is the column');
    eq(at(linkedHeader('Nouveau nom (Test lié)', set('nom lié'), set('test lié')).col), [0, 11, 'Nouveau nom'], 'the column renamed since: still its part');
    eq(linkedHeader('', set(), set()), {});
  });

  test('queryLinks / linkedColumn: aliases of a grid query, nested links, the columns they read', () => {
    const fx = `<fetch><entity name="new_dxttest"><attribute name="new_name"/>
      <link-entity alias="a_c0b2" name="new_dxtlinked" to="new_linkedid" from="new_dxtlinkedid" link-type="outer"><attribute name="new_name"/><attribute name="new_linkedkind"/>
        <link-entity alias="A_OWN" name="systemuser" to="ownerid" from="systemuserid"><all-attributes/></link-entity>
      </link-entity>
      <link-entity name="new_dxttest" from="new_dxttestid" to="new_parenttestid" alias="bb"><filter/></link-entity>
      <link-entity name="account" to="x" from="y"><attribute name="name"/></link-entity></entity></fetch>`;
    const m = queryLinks(fx);
    eq([...m.keys()], ['a_c0b2', 'a_own', 'bb'], 'aliased links only, lower case');
    eq({ ...m.get('a_c0b2')!, attrs: [...m.get('a_c0b2')!.attrs!] }, { entity: 'new_dxtlinked', to: 'new_linkedid', parent: 'new_dxttest', attrs: ['new_name', 'new_linkedkind'] });
    eq({ ...m.get('a_own')!, attrs: m.get('a_own')!.attrs }, { entity: 'systemuser', to: 'ownerid', parent: 'new_dxtlinked', attrs: null }, 'nested: linked from the outer link');
    eq(linkedColumn('a_c0b2.new_linkedkind', m)?.entity, 'new_dxtlinked');
    eq(linkedColumn('A_C0B2.New_Name', m)?.attr, 'new_name', 'any case');
    eq(linkedColumn('a_own.fullname', m)?.parent, 'new_dxtlinked', 'all-attributes');
    eq(linkedColumn('a_c0b2.createdon', m), null, 'a column the link does not read');
    eq(linkedColumn('zz.new_name', m), null, 'an alias the query does not have');
    eq(linkedColumn('new_name', m), null, 'not a linked column');
    eq(linkedColumn('a_c0b2.new_name', null), null, 'query unknown');
    eq(queryLinks('<fetch><entity'), new Map(), 'unreadable');
  });

  test('queryTable: the table a view query reads', () => {
    eq(queryTable('<fetch><entity name="Contact"><attribute name="fullname"/><link-entity name="account" alias="a"/></entity></fetch>'), 'contact');
    eq(queryTable(''), '', 'no query (the view is gone)');
    eq(queryTable('<fetch><entity'), '', 'unreadable');
  });

  test("relatedTable: an associated grid's related table only when the page table and its view's query agree", () => {
    const g = lpGrid(`Microsoft.PowerApps.PowerAppsOneGrid|entity_control|account|${ASSOC}|contact|msa_contact_managingpartner`)!;
    eq(relatedTable(g, 'account', 'contact'), 'contact');
    eq(relatedTable(g, 'Account', 'contact'), 'contact', 'any case');
    eq(relatedTable(g, 'account', undefined), null, 'the view\'s query not read yet');
    eq(relatedTable(g, 'account', 'account'), '', 'the view reads another table');
    eq(relatedTable(g, 'account', ''), '', 'the view is gone');
    eq(relatedTable(g, 'contact', 'contact'), '', 'another page table');
    eq(relatedTable({ ...g, view: '' }, 'account', 'contact'), '', 'no view named');
    const self = lpGrid(`Microsoft.PowerApps.PowerAppsOneGrid|entity_control|account|${VIEW}|account|account_parent_account`)!;
    eq(relatedTable(self, 'account', 'account'), 'account', 'a relationship to the same table');
  });

  test('formIdOf, lpGrid, lpQuickForm: the ids UCI puts in the DOM', () => {
    eq(formIdOf(`id-${FORM.toUpperCase()}-1-new_name-FieldSectionItemContainer`), FORM, 'quick view field (LIVE-FINDINGS 56)');
    eq(formIdOf('id-f5e07410-0000-4000-8000-000000000072-12-header_new_name-FieldSectionItemContainer'), 'f5e07410-0000-4000-8000-000000000072');
    for (const bad of ['', null, 'id-1a2b-name-field-label', `x-${FORM}-1-a`, `id-${FORM}-name`]) eq(formIdOf(bad), '', String(bad));
    eq(lpGrid(`Microsoft.PowerApps.PowerAppsOneGrid|children|new_dxttest|${VIEW}|new_dxttest|new_dxttest_parent`), { control: 'children', table: 'new_dxttest', view: VIEW, parent: 'new_dxttest' });
    eq(lpGrid(`Microsoft.PowerApps.PowerAppsOneGrid|entity_control|New_DxtTest|{${VIEW.toUpperCase()}}|new_dxttest`), { control: 'entity_control', table: 'new_dxttest', view: VIEW, parent: 'new_dxttest' });
    eq(lpGrid('Microsoft.PowerApps.PowerAppsOneGrid|entity_control|account'), { control: 'entity_control', table: 'account', view: '', parent: 'account' }, 'no view');
    // An associated grid (a related tab's view, LIVE-FINDINGS 88): part 2 the page's table, part 4 the grid's own.
    eq(lpGrid(`Microsoft.PowerApps.PowerAppsOneGrid|entity_control|account|${ASSOC}|contact|msa_contact_managingpartner`), { control: 'entity_control', table: 'contact', view: ASSOC, parent: 'account' });
    eq(lpGrid(`Microsoft.PowerApps.PowerAppsOneGrid|entity_control|account|${VIEW}|a b`)?.table, 'account', 'part 4 not a table name: part 2');
    // The classic read-only grid (the Connections associated view, live 2026-10-17): the same parts.
    eq(lpGrid(`MscrmControls.Grid.GridControl|entity_control|account|${VIEW}|connection|account_connections1`), { control: 'entity_control', table: 'connection', view: VIEW, parent: 'account' });
    eq(lpGrid('MscrmControls.Grid.GridControlX|entity_control|account'), null, 'another control');
    eq(lpGrid('MscrmControls.Containers.QuickForm|linkedqv|new_dxttest|' + FORM), null, 'not a grid');
    eq(lpGrid('commandbar-HomePageGrid:new_dxttest'), null);
    eq(lpQuickForm(`MscrmControls.Containers.QuickForm|linkedqv|new_dxttest|${FORM}`), { control: 'linkedqv', host: FORM });
    eq(lpQuickForm('MscrmControls.Containers.QuickForm|linkedqv|new_dxttest|notaguid'), null);
    eq(lpQuickForm('MscrmControls.Containers.FieldSectionItem|linkedqv.new_name|new_dxttest'), null);
  });

  test("namePart: where a built-in command's text shows its table's name, the longest one, as a whole word in any case", () => {
    const hit = (raw: string, names: string[]) => {
      const r = namePart(raw, names);
      return r && [r.i, ...at(r.part)!];
    };
    eq(hit('New Person', ['Person', 'People']), [0, 4, 10, 'Person']);
    eq(hit('Add Existing Person', ['Person', 'People']), [0, 13, 19, 'Person']);
    eq(hit('Export People', ['Person', 'People']), [1, 7, 13, 'People']);
    eq(hit('Exporter éléments liés', ['Élément lié', 'Éléments liés']), [1, 9, 22, 'éléments liés'], 'any case; the plural, not the name inside it');
    eq(hit('Export Tests', ['Test', 'Tests']), [1, 7, 12, 'Tests'], 'the longest');
    eq(hit('Nouvel équipement', ['Équipement', 'Équipement']), [0, 7, 17, 'équipement'], 'two names that read the same: the first');
    eq(hit('Contests', ['Test', 'Tests']), null, 'whole words only');
    eq(hit('Test2 report', ['Test']), null, 'a digit joins the word');
    eq(hit('Actualiser', ['Person', '']), null);
    eq(hit('', ['Person']), null);
  });

  test('pickPart: the part under the pointer (within 2 px of its mark), none between or past them; the first without a pointer (F2)', () => {
    const a = { key: 'a' } as Anchor;
    const b = { key: 'b' } as Anchor;
    const c = { key: 'c' } as Anchor;
    // "Rouge, Bleu": Rouge at x 246–290, Bleu at 293–323; c has no marks (scrolled away).
    const boxes = new Map<Anchor, Array<[number, number, number, number]>>([
      [a, [[246, 381, 44, 21]]],
      [b, [[293, 381, 30, 21]]],
      [c, []],
    ]);
    const pick = (x: number, y: number) => pickPart([a, b, c], (z) => boxes.get(z) || [], { x, y })?.key ?? null;
    eq([pick(260, 390), pick(300, 390), pick(291, 390), pick(244, 390), pick(324, 390)], ['a', 'b', 'a', 'a', 'b']);
    eq([pick(600, 390), pick(100, 395), pick(243, 390), pick(300, 420)], [null, null, null, null], 'past every part, or off the line: none (never the nearest)');
    eq(pickPart([a, b], () => [], { x: 1, y: 1 }), null, 'no marks drawn: nothing');
    eq(pickPart([b, a], (z) => boxes.get(z) || [], null)?.key, 'b', 'keyboard');
  });
}
