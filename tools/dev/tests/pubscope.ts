// Unit tests for the Publish dialog's sentence about the whole publish scope (ui/review.ts scopeText): PublishXml
// publishes everything unpublished on each component it names, and the check of others' work reads
// only the forms, views and charts of the tables, so every other part it publishes is named, with what can't be checked.
import type { Change, Kind, Slot } from '../../../src/core/model';
import { publishTargets } from '../../../src/core/publish';
import { Store } from '../../../src/core/store';
import { scopeText } from '../../../src/ui/review';
import type { AppApi } from '../../../src/ui/types';
import type { Kit } from './kit';

const FR = 1036;
const APP = '6f0c0a4e-0000-0000-0000-0000000000a1';
const MAP = '7a1b2c3d-0000-0000-0000-0000000000b2';
const DASH = '8b2c3d4e-0000-0000-0000-0000000000c3';

export function register(t: Kit): void {
  const rig = () => {
    const store = new Store();
    const app = { store, saver: { publishTargets } } as unknown as AppApi;
    const named = (e: string, title: string) => store.add([{ ...t.slot('entity', `entity|${e}|DisplayName`), entity: e, title } as Slot]);
    named('account', 'Account');
    named('contact', 'Contact');
    const ch = (kind: Kind, o: Partial<Slot> = {}): Change => ({ slot: { ...t.slot(kind, `${kind}|${Math.random()}|Label`), entity: '', ref: {}, ...o } as Slot, lcid: FR, before: 'a', after: 'b' });
    return { app, ch };
  };

  t.test('publish scope: a table is named with what can be checked of it; other components with "can\'t check"', () => {
    const { app, ch } = rig();
    const col = ch('attribute', { entity: 'account' });
    const nav = ch('subarea', { path: ['Translator Test App', 'Area', 'Group'], ref: { sitemapId: `{${MAP.toUpperCase()}}` } });
    t.eq(scopeText(app, [col]), 'Publishing also publishes anything else not yet published on: Account (table); the translator can only check its forms, views and charts.');
    t.eq(scopeText(app, [col, nav]), "Publishing also publishes anything else not yet published on: Account (table), Translator Test App (navigation); the translator can only check a table's forms, views and charts.");
    t.eq(scopeText(app, [nav, nav]), "Publishing also publishes anything else not yet published on: Translator Test App (navigation); the translator can't check it.");
  });

  t.test('publish scope: dashboards, apps, global choices and the command bar of every table are named; a classic command label says its table is published first', () => {
    const { app, ch } = rig();
    const cs = [
      ch('dfield', { path: ['Dashboards', 'Sales overview'], ref: { formId: DASH } }),
      ch('app', { title: 'Translator Test App', ref: { id: APP } }),
      ch('globaloption', { path: ['Choice', 'Priority'], ref: { name: 'cr_priority' } }),
    ];
    t.eq(scopeText(app, cs), "Publishing also publishes anything else not yet published on: Sales overview (dashboard), Translator Test App (app), Priority (choice); the translator can't check those.");
    t.eq(
      scopeText(app, [ch('ribbon', { entity: 'contact', ref: { entity: 'contact', locLabelId: 'x' } })]),
      'Publishing also publishes anything else not yet published on: Contact (table); the translator can only check its forms, views and charts. Contact is published first, before its classic command labels are saved.',
    );
    // The application ribbon is published before its import too (ribbon.ts publishScope).
    t.eq(
      scopeText(app, [ch('ribbon', { ref: { entity: '_app', locLabelId: 'x' } })]),
      "Publishing also publishes anything else not yet published on: the command bar of every table; the translator can't check it. The command bar of every table is published first, before its classic command labels are saved.",
    );
    t.eq(
      scopeText(app, [ch('ribbon', { entity: 'contact', ref: { entity: 'contact', locLabelId: 'x' } }), ch('ribbon', { ref: { entity: '_app', locLabelId: 'y' } })]),
      "Publishing also publishes anything else not yet published on: Contact (table), the command bar of every table; the translator can only check a table's forms, views and charts. Contact and the command bar of every table are published first, before their classic command labels are saved.",
    );
  });

  t.test('publish scope: nothing published (commands, process stages, environment variables, read-only rows) says nothing; a long list is cut', () => {
    const { app, ch } = rig();
    t.eq(scopeText(app, [ch('command', { entity: 'account' }), ch('stage'), ch('envvar'), ch('attribute', { entity: 'account', readOnly: 'Managed' })]), '');
    const many = ['account', 'contact', 'lead', 'opportunity', 'incident'].map((e) => ch('attribute', { entity: e }));
    t.eq(scopeText(app, many), "Publishing also publishes anything else not yet published on: Account (table), Contact (table), lead (table) and 2 more; the translator can only check a table's forms, views and charts.");
  });
}
