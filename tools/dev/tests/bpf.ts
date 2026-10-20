// Unit tests for the business process flow stage and step names Dynamics keeps (providers/bpf.ts, LIVE-FINDINGS 83,
// 85): reading them from a GetClientMetadata answer, filling the languages the definition has none in, the read per
// language through the language switch, how such a name looks in the popup and on the page, and saving one (measured
// against that name; the writer refuses a blank one, which the popup and the saver turn into the English text).
// register() is called by tools/dev/unit.ts.
import { DvError, type BatchPart } from '../../../src/core/http';
import { CANT_CLEAR_TEXT, MANAGED, PublishSet, canClear, cantClearText, type Change, type Kind, type Lcid, type Slot } from '../../../src/core/model';
import { Store } from '../../../src/core/store';
import { look } from '../../../src/inspector/status';
import { bpfWriter, clientLabels, clientMetadataPart, loadBpfLabels, loadBpfScope, loadBpfStored, mergeStored, withStored } from '../../../src/providers/bpf';
import type { LoadOptions, ProcessPage, SaveOptions } from '../../../src/providers/types';
import { becomes, isMissing, placeholderOf, problem } from '../../../src/ui/callout';
import type { AppApi } from '../../../src/ui/types';
import { blankEdit, textOf } from '../../../src/workbench/grid';
import type { Kit } from './kit';
import { batchOf } from './records';

const EN = 1033;
const FR = 1036;
const DE = 1031;
const WF = '9a6faaaa-0000-4000-8000-0000000000b1';
const S1 = '8f912143-0000-4000-8000-000000000051';
const S2 = '2c3b1a8e-5d4f-4e6a-9b7c-1d2e3f4a5b6c';
const P1 = '4550377b-1c2d-4e5f-8a9b-0c1d2e3f4a5b';
const REC = '6f3e0a52-0000-0000-0000-000000000001';
const APP = 'b0d1e2f3-0000-0000-0000-000000000002';
const LANGS = [
  { lcid: EN, name: 'English', isBase: true },
  { lcid: FR, name: 'French', isBase: false },
  { lcid: DE, name: 'German', isBase: false },
];
const PAGE: ProcessPage = { entity: 'account', record: REC, app: APP };
const KEEPS_STAGE = "Dynamics keeps a stage's translation once it is stored: type the text you want instead.";
const KEEPS_STEP = "Dynamics keeps a step's translation once it is stored: type the text you want instead.";

const tag = (id: string, l: Lcid, t: string) => `<mxswa:StepLabel Description="${t}" LabelId="${id}" LanguageCode="${l}" />`;
const entry = (id: string, l: Lcid, t: string) => ({ labelId: id, languageCode: l, description: t });
const step = (cls: string, o: object) => ({ __class: `${cls}:#Microsoft.Crm.Workflow.ObjectModel`, ...o });

/**
 * "bpf test" on account as found live (LIVE-FINDINGS 83): stage 1 and its step in English only in the definition,
 * stage 2 in English and French.
 */
function workflow() {
  const clientdata = step('EntityStep', {
    description: 'account',
    steps: {
      list: [
        step('StageStep', {
          stageId: S1,
          stepLabels: { list: [entry(S1, EN, 'Test1s')] },
          steps: { list: [step('StepStep', { stepStepId: P1, stepLabels: { list: [entry(P1, EN, 'Account Name')] }, steps: { list: [step('ControlStep', { dataFieldName: 'name', controlDisplayName: 'Account Name' })] } })] },
        }),
        step('StageStep', { stageId: S2, stepLabels: { list: [entry(S2, EN, 'Test2'), entry(S2, FR, 'Test2 FR')] } }),
      ],
    },
  });
  const xaml = `<Activity><mxswa:StepLabels>${tag(S1, EN, 'Test1s')}</mxswa:StepLabels><x><mxswa:StepLabels>${tag(P1, EN, 'Account Name')}</mxswa:StepLabels></x><mxswa:StepLabels>${tag(S2, EN, 'Test2')} ${tag(S2, FR, 'Test2 FR')}</mxswa:StepLabels></Activity>`;
  return { name: 'bpf test', primaryentity: 'account', ismanaged: false, iscustomizable: { Value: true }, xaml, clientdata: JSON.stringify(clientdata), '@odata.etag': 'W/"1"' };
}

/** The process's definition on a fake Dataverse: every request in `log`; the user works in French. */
function server() {
  const W = { doc: workflow(), log: [] as string[] };
  const ctx = {
    base: EN,
    user: FR,
    langs: LANGS,
    http: {
      get: async (u: string) => (W.log.push(`GET ${u.split('?')[0]}`), JSON.parse(JSON.stringify(W.doc))),
      patch: async (u: string, body: { xaml?: string; clientdata?: string }) => (W.log.push(`PATCH ${u}`), Object.assign(W.doc, body), {}),
    } as Record<string, unknown>,
  };
  ctx.http.batch = batchOf(ctx.http);
  return { W, ctx: ctx as never };
}

const opts = (lang?: unknown, signal = new AbortController().signal): LoadOptions => ({ signal, progress: () => {}, lang: lang as LoadOptions['lang'] });

/** A GetClientMetadata answer as the Web API sends it: its metadata a JSON string, non-ASCII escaped (LIVE-FINDINGS 85). */
const answer = (labels: Array<[string, string, string]>) => ({
  '@odata.context': 'https://org.test/api/data/v9.2/$metadata#Microsoft.Dynamics.CRM.GetClientMetadataResponse',
  Metadata: JSON.stringify({ Labels: labels.map(([Id, LabelColumnName, Value]) => ({ Id, LabelColumnName, Value })) }).replace(/[^\x00-\x7e]/g, (c) => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0')),
});

interface Said {
  inLang?: boolean;
  ok?: boolean;
  data?: unknown;
  throws?: unknown;
}
/** A LangSession stand-in: each hold's batches are recorded with their language and answered from `said`. */
function session(said: Record<number, Said>) {
  const seen: Array<[Lcid, BatchPart[]]> = [];
  let holds = 0;
  const lang = {
    hold: async <T>(fn: (h: unknown) => Promise<T>): Promise<T> => {
      holds++;
      return fn({
        batch: async (lcid: Lcid, parts: BatchPart[]) => {
          seen.push([lcid, parts]);
          const a = said[lcid] ?? {};
          if (a.throws) throw a.throws;
          return { inLang: a.inLang ?? true, results: [{ ok: a.ok ?? true, status: a.ok === false ? 500 : 200, data: a.data ?? null, headers: {} }] };
        },
        window: (f: () => Promise<unknown>) => f(),
      });
    },
  };
  return { lang, seen, holds: () => holds };
}

const byId = (ss: Slot[]): Record<string, Slot> => Object.fromEntries(ss.map((s) => [s.ref.labelId, s]));

/** The process's slots with the names Dynamics keeps in French (stage 1, its step; stage 2's is in the definition) and German (stage 1, the English text). */
async function kept() {
  const { ctx } = server();
  const slots = await loadBpfLabels(ctx, WF, opts());
  const read = new Map([
    [FR, new Map([[S1, 'Étape 1 FR'], [S2, 'FR Test2'], [P1, 'Pas page E2E']])],
    [DE, new Map([[S1, 'Test1s']])],
  ]);
  return { slots, merged: withStored(ctx, slots, read) };
}

export function register(t: Kit): void {
  const { test, eq, ok } = t;

  test('process names Dynamics keeps: read from a GetClientMetadata answer (its metadata a JSON string, escaped twice: \\u00c9), by stage or step id; the process name, blank texts and unreadable parts left out', () => {
    const raw = String.raw`{"@odata.context":"x","Metadata":"{\"Labels\":[{\"Id\":\"{8F912143-0000-4000-8000-000000000051}\",\"LabelColumnName\":\"description\",\"Value\":\"\\u00c9tape 1 FR\"},{\"Id\":\"9a6faaaa-0000-4000-8000-0000000000b1\",\"LabelColumnName\":\"name\",\"Value\":\"Processus test FR\"},{\"Id\":\"4550377b-1c2d-4e5f-8a9b-0c1d2e3f4a5b\",\"LabelColumnName\":\"description\",\"Value\":\"Pas page E2E\"},{\"Id\":\"2c3b1a8e-5d4f-4e6a-9b7c-1d2e3f4a5b6c\",\"LabelColumnName\":\"description\",\"Value\":\" \"}],\"Stages\":\"{not json\"}"}`;
    const data = JSON.parse(raw);
    eq([...clientLabels(data)], [[S1, 'Étape 1 FR'], [P1, 'Pas page E2E']]);
    eq([...clientLabels(data, 'name')], [[WF, 'Processus test FR']], 'the process name is its "name"');
    eq([...clientLabels(answer([[S1, 'description', 'Étape 1 FR']]))], [[S1, 'Étape 1 FR']], 'as the fake answers say it');
    eq([...clientLabels({ value: [{ Process: { Labels: [{ Id: S2, LabelColumnName: 'Description', Value: 'FR Test2' }, null, { Id: '', Value: 'x' }] } }] })], [[S2, 'FR Test2']], 'anywhere in the answer');
    eq([clientLabels(null).size, clientLabels('{oops').size, clientLabels({ Metadata: '[1,2' }).size, clientLabels({ Labels: 'none' }).size], [0, 0, 0, 0], 'nothing readable: none, never an error');
  });

  test("process names Dynamics keeps: they fill only the languages the definition has none in (the definition wins), the English text too; ref.stored lists them; titles and step paths follow the user's language; a later read replaces only the languages it read", async () => {
    const { ctx } = server();
    const { slots, merged } = await kept();
    const m = byId(merged);
    eq(m[S1].labels, { [EN]: 'Test1s', [FR]: 'Étape 1 FR', [DE]: 'Test1s' }, 'German as the page shows it: the English text');
    eq(m[S2].labels, { [EN]: 'Test2', [FR]: 'Test2 FR' }, 'the definition wins');
    eq(m[P1].labels, { [EN]: 'Account Name', [FR]: 'Pas page E2E' });
    eq([m[S1].ref.stored, m[S2].ref.stored, m[P1].ref.stored, m[S1].ref.primary], [[DE, FR], [], [FR], 'account']);
    eq([m[S1].title, m[P1].title, m[P1].path, m[S2].title], ['Étape 1 FR', 'Pas page E2E', ['bpf test', 'Étape 1 FR'], 'Test2 FR']);
    eq([byId(slots)[S1].labels, byId(slots)[S1].ref.stored, byId(slots)[P1].path], [{ [EN]: 'Test1s' }, undefined, ['bpf test', 'Test1s']], 'the loaded slots are left as they were');
    // A later read of French only: French as it says now, German as the earlier read filled it.
    const again = byId(withStored(ctx, merged, new Map([[FR, new Map([[P1, 'Pas page 2']])]])));
    eq([again[S1].labels, again[S1].ref.stored, again[S1].title, again[P1].labels[FR], again[P1].ref.stored, again[P1].path], [{ [EN]: 'Test1s', [DE]: 'Test1s' }, [DE], 'Test1s', 'Pas page 2', [FR], ['bpf test', 'Test1s']]);
  });

  test("process names Dynamics keeps: read for the page's record, one language at a time, each in a hold of its own through the language switch, the user's own first; only languages some stage or step lacks; the request the page makes", async () => {
    const { ctx } = server();
    const slots = await loadBpfLabels(ctx, WF, opts());
    const F = session({ [FR]: { data: answer([[S1, 'description', 'Étape 1 FR'], [P1, 'description', 'Pas page E2E'], [S2, 'description', 'FR Test2'], [WF, 'name', 'Processus FR']]) }, [DE]: { data: answer([[S1, 'description', 'Test1s']]) } });
    const r = await loadBpfStored(ctx, slots, { entity: 'Account', record: `{${REC.toUpperCase()}}`, app: APP }, opts(F.lang));
    eq([F.seen.map(([l]) => l), F.holds()], [[FR, DE], 2], 'English is in the definition for every stage and step');
    eq([r.missed, r.slots.map((s) => [s.ref.labelId, s.labels[FR], s.labels[DE] ?? '', s.ref.stored])], [[], [[S1, 'Étape 1 FR', 'Test1s', [DE, FR]], [P1, 'Pas page E2E', '', [FR]], [S2, 'Test2 FR', '', []]]]);
    const [part] = F.seen[0][1];
    const q = JSON.parse(decodeURIComponent(part.url.split('?@q=')[1]));
    eq([part.method, part.url.split('?')[0], q, part.headers], [
      'GET',
      'GetClientMetadata(ClientMetadataQuery=@q)',
      { MetadataType: 'businessprocessflow', EntityLogicalName: 'account', MetadataId: REC, GetDefault: false, AppId: APP },
      { 'x-ms-metadatareductionlevel': '5', ClientHost: 'Browser' },
    ]);
    eq(F.seen[1][1], [part], 'the same request in every language');
    ok(!clientMetadataPart('account', REC, '').url.includes('AppId'), 'no app known: no AppId');
  });

  test('process names Dynamics keeps: a language whose answer failed or was not proven to be in it is left out and named; a cancel stops the load; nothing read on another table\'s record, without a record, or with nothing missing', async () => {
    const { ctx } = server();
    const slots = await loadBpfLabels(ctx, WF, opts());
    const A = session({ [FR]: { inLang: false, data: answer([[S1, 'description', 'Test1s']]) }, [DE]: { ok: false } });
    const a = await loadBpfStored(ctx, slots, PAGE, opts(A.lang));
    eq([a.missed, a.slots.map((s) => [s.ref.stored, s.ref.unread]), byId(a.slots)[S1].labels], [[FR, DE], [[[], [FR, DE]], [[], [FR, DE]], [[], [FR, DE]]], { [EN]: 'Test1s' }]);
    const B = session({ [FR]: { throws: new DvError('Dataverse did not switch to language 1036 in time.', 0, 'langswitch') }, [DE]: { data: answer([[S1, 'description', 'Test1s']]) } });
    const b = await loadBpfStored(ctx, slots, PAGE, opts(B.lang));
    eq([b.missed, byId(b.slots)[S1].labels, byId(b.slots)[S1].ref.stored, byId(b.slots)[S1].ref.unread], [[FR], { [EN]: 'Test1s', [DE]: 'Test1s' }, [DE], [FR]], 'the other languages are read all the same');
    // Slots that carry an earlier read's misses (the page passes them through mergeStored): a read that misses nothing
    // clears them, else the page would read the names again on every start.
    const D = session({ [FR]: { data: answer([[S1, 'description', 'Étape FR']]) }, [DE]: { data: answer([[S1, 'description', 'Test1s']]) } });
    const d = await loadBpfStored(ctx, a.slots, PAGE, opts(D.lang));
    eq([d.missed, d.slots.map((s) => s.ref.unread)], [[], d.slots.map(() => undefined)], "an earlier read's misses are cleared");
    const C = session({ [FR]: { throws: new DOMException('The operation was cancelled.', 'AbortError') } });
    let threw = '';
    await loadBpfStored(ctx, slots, PAGE, opts(C.lang)).catch((e: Error) => (threw = e.name));
    eq([threw, C.seen.length], ['AbortError', 1], 'cancelled: no other language is read');
    for (const page of [{ ...PAGE, entity: 'contact' }, { ...PAGE, record: '' }, { ...PAGE, record: 'new' }]) {
      const N = session({});
      const n = await loadBpfStored(ctx, slots, page, opts(N.lang));
      eq([N.seen.length, n.slots === slots, n.missed], [0, true, []], JSON.stringify(page));
    }
    const full = slots.map((s) => ({ ...s, labels: { [EN]: 'x', [FR]: 'y', [DE]: 'z' } }));
    const N = session({});
    const n = await loadBpfStored(ctx, full, PAGE, opts(N.lang));
    eq([N.seen.length, n.slots.map((s) => s.ref.stored)], [0, [[], [], []]], 'every language in the definition: nothing to read');
  });

  test("process names Dynamics keeps: a real translation in the popup and on the page (its text in the input, not amber, its placeholder the kept name, not the English one); emptied, it is saved as the English text, as is a stage's translation in the definition (Dynamics keeps it too)", async () => {
    const { slots, merged } = await kept();
    const mk = (ss: Slot[]) => {
      const store = new Store();
      store.add(ss);
      const app = { store, ctx: { base: EN, user: FR, langs: LANGS }, prefs: { target: FR, shown: [], showNames: false, dock: 'right' } } as unknown as AppApi;
      return { store, app };
    };
    // Before: only the definition, as reported (French empty, "Shows “Test1s”").
    const was = mk(slots);
    const w1 = byId(slots)[S1];
    eq([was.store.value(w1.key, FR), isMissing(was.store, w1, FR, EN), look(was.app, w1.comp), placeholderOf(was.store, w1, FR, EN, 'Label', 'French')], ['', true, 'missing', 'Shows “Test1s”']);
    const { store, app } = mk(merged);
    const m = byId(merged);
    const s1 = store.get(m[S1].key)!;
    const p1 = store.get(m[P1].key)!;
    eq([store.value(s1.key, FR), isMissing(store, s1, FR, EN), look(app, s1.comp), look(app, p1.comp), placeholderOf(store, s1, FR, EN, 'Label', 'French')], ['Étape 1 FR', false, 'ok', 'ok', 'Shows “Étape 1 FR”']);
    eq(placeholderOf(store, s1, DE, EN, 'Label', 'German'), 'Shows “Test1s”', 'German shows the kept English text');
    // Emptied: Dynamics would go on showing it, so it is saved as the English text (model.ts standIn), a step's too
    // (its own English text, not its column's name). No "Shows “Étape 1 FR”" next to the line that says so: the empty
    // input names one text, the one it becomes.
    store.set(s1.key, FR, '');
    store.set(p1.key, FR, ' ');
    eq([problem(store, s1, FR, EN), problem(store, p1, FR, EN), placeholderOf(store, s1, FR, EN, 'Label', 'French'), blankEdit(s1, FR, EN, 'Étape 1 FR', '', textOf(store))], ['', '', '', 'standin']);
    eq([becomes(store, s1, FR, EN), becomes(store, p1, FR, EN)], [
      "Becomes “Test1s”: Dynamics keeps a stage's translation, so French gets the English text.",
      "Becomes “Account Name”: Dynamics keeps a step's translation, so French gets the English text.",
    ]);
    eq([canClear(s1, FR), canClear(s1, DE), canClear(p1, FR), canClear(s1), canClear(m[S2], FR), canClear(p1, DE)], [false, false, false, true, false, true], 'every stage and step translation; none in German: nothing to remove');
    eq([cantClearText(s1, FR), cantClearText(p1, FR), cantClearText(m[S2], FR), cantClearText(s1) === CANT_CLEAR_TEXT], [KEEPS_STAGE, KEEPS_STEP, KEEPS_STAGE, true]);
    // Only spaces where there is no translation change nothing, as before.
    store.set(p1.key, DE, '  ');
    eq([problem(store, p1, DE, EN), blankEdit(p1, DE, EN, '', '  ', textOf(store)), becomes(store, p1, DE, EN)], ['', '', '']);
    // French of stage 2 is in the definition: removing its StepLabel would leave the page showing it all the same
    // (LIVE-FINDINGS 83), so it can't be removed either: emptied, it is saved as the English text, which the line under
    // its input says (no placeholder naming the text the page shows now).
    store.set(m[S2].key, FR, '');
    eq([problem(store, m[S2], FR, EN), blankEdit(m[S2], FR, EN, 'Test2 FR', '', textOf(store)), placeholderOf(store, m[S2], FR, EN, 'Label', 'French'), becomes(store, m[S2], FR, EN)], ['', 'standin', '', "Becomes “Test2”: Dynamics keeps a stage's translation, so French gets the English text."]);
    // English is the base language: a stage needs it whatever Dynamics keeps. Emptied as well, nothing stands in for
    // the emptied French: refused, saying why.
    store.set(s1.key, EN, '');
    eq(problem(store, s1, EN, EN), "Can't be empty");
    eq(problem(store, s1, FR, EN), "Dynamics keeps a stage's translation once it is stored, and its English text is empty: type the text instead.");
    eq(placeholderOf(store, p1, DE, EN, 'Label', 'German'), 'Shows “Account Name”', 'no German name anywhere: the English one');
  });

  test('saving a process name Dynamics keeps writes its StepLabel, measured against the kept name (the definition has none): saved and verified; a conflict once another text is in the definition; clearing one, or a translation in the definition, is refused before anything is read or written', async () => {
    const { merged } = await kept();
    const m = byId(merged);
    const o = (): SaveOptions => ({ signal: new AbortController().signal, publish: new PublishSet(), progress: () => {}, force: new Set(), lang: {} as SaveOptions['lang'], allowPublish: true });
    const ch = (s: Slot, l: Lcid, after: string, before = s.labels[l] ?? ''): Change => ({ slot: s, lcid: l, before, after });
    const { W, ctx } = server();
    const res = await bpfWriter.save(ctx, [ch(m[S1], FR, 'Étape 1'), ch(m[P1], FR, 'Nom du compte')], o());
    eq(res.map((r) => [r.outcome, r.message ?? '']), [['saved', ''], ['saved', '']], 'before: the kept name, not a conflict with the empty definition');
    ok(W.doc.xaml.includes(`<mxswa:StepLabel Description="Étape 1" LabelId="${S1}" LanguageCode="1036" />`) && W.doc.clientdata.includes('"description":"Étape 1"'), W.doc.xaml);
    eq(W.log, [`GET workflows(${WF})`, `GET workflows(${WF})`, `PATCH workflows(${WF})`, `GET workflows(${WF})`], 'read, then in one batch: read right before, written once, read back');
    // Edited again from the kept name while another text went into the definition: a conflict showing that text.
    const late = await bpfWriter.save(ctx, [ch(m[S1], FR, 'Étape un')], o());
    eq(late.map((r) => [r.outcome, r.server]), [['conflict', 'Étape 1']]);
    // Clearing: refused in Dynamics' words before anything is read; another change of the process is saved.
    const two = server();
    const none = await bpfWriter.save(two.ctx, [ch(m[S1], FR, ''), ch(m[P1], FR, '  ')], o());
    eq([none.map((r) => [r.outcome, r.message]), two.W.log], [[['error', KEEPS_STAGE], ['error', KEEPS_STEP]], []]);
    const mixed = await bpfWriter.save(two.ctx, [ch(m[S1], FR, ''), ch(m[S2], DE, 'Phase 2')], o());
    eq([mixed.map((r) => [r.change.lcid, r.outcome]), two.W.log.length], [[[FR, 'error'], [DE, 'saved']], 4]);
    ok(!two.W.doc.xaml.includes(`LabelId="${S1}" LanguageCode="1036"`), 'nothing written for the kept name');
    // Stage 2's French is in the definition: removing it would not change what the page shows (LIVE-FINDINGS 83).
    // Refused the same way, with or without a read of the kept names; the StepLabel stays.
    const three = server();
    const plain = byId((await kept()).slots)[S2];
    const def = await bpfWriter.save(three.ctx, [ch(m[S2], FR, ''), ch(plain, FR, ' ')], o());
    eq([def.map((r) => [r.outcome, r.message]), three.W.log, three.W.doc.xaml.includes(tag(S2, FR, 'Test2 FR'))], [[['error', KEEPS_STAGE], ['error', KEEPS_STAGE]], [], true]);
    // Only spaces where no German name is known: nothing to remove, nothing written.
    const spaces = await bpfWriter.save(three.ctx, [ch(m[P1], DE, '  ')], o());
    eq([spaces.map((r) => r.outcome), three.W.log], [['unchanged'], [`GET workflows(${WF})`]]);
  });

  test("process names Dynamics keeps survive another load of the definition (the Workbench, the page's before its read): carried over with ref.stored and ref.unread, titles and step paths; the definition wins; a read of its own takes only the languages it missed; slots never read and other kinds are left as they are", async () => {
    const { ctx } = server();
    const { slots, merged } = await kept();
    const store = new Store();
    store.add(merged);
    const get = (k: string) => store.get(k);
    eq(mergeStored(ctx, slots, get), merged, 'the definition only: as read before');
    // A German name not read last time (ref.unread): still listed, so the page reads it again.
    store.add(merged.map((s) => ({ ...s, ref: { ...s.ref, unread: [DE] } })));
    eq(byId(mergeStored(ctx, slots, get))[S1].ref.unread, [DE]);
    store.add(merged);
    // A save wrote stage 1's French into the definition: the definition wins, German stays kept.
    const saved = slots.map((s) => (s.ref.labelId === S1 ? { ...s, labels: { ...s.labels, [FR]: 'Étape 1' } } : s));
    const w = byId(mergeStored(ctx, saved, get));
    eq([w[S1].labels, w[S1].ref.stored, w[S1].title, w[P1].path], [{ [EN]: 'Test1s', [FR]: 'Étape 1', [DE]: 'Test1s' }, [DE], 'Étape 1', ['bpf test', 'Étape 1']]);
    // A read of its own that missed French: French as read before, the rest as this read says.
    const missed = withStored(ctx, slots, new Map([[DE, new Map<string, string>()]])).map((s) => ({ ...s, ref: { ...s.ref, unread: [FR] } }));
    const r = byId(mergeStored(ctx, missed, get));
    eq([r[S1].labels, r[S1].ref.stored, r[S1].ref.unread, r[P1].labels[FR], r[S2].ref.stored], [{ [EN]: 'Test1s', [FR]: 'Étape 1 FR' }, [FR], [FR], 'Pas page E2E', []]);
    const full = withStored(ctx, slots, new Map([[FR, new Map([[S1, 'Étape 1 neuf']])]]));
    const f = mergeStored(ctx, full, get);
    eq([f === full, byId(f)[S1].labels[FR], byId(f)[P1].labels[FR]], [true, 'Étape 1 neuf', undefined], 'a full read: as it read');
    // Nothing read before, or another kind: untouched.
    const none = new Store();
    none.add(slots);
    eq([mergeStored(ctx, slots, (k) => none.get(k)) === slots, mergeStored(ctx, slots, () => undefined) === slots], [true, true]);
    const other = { ...merged[0], kind: 'bpf', key: 'bpf|x|Name' } as Slot;
    eq(mergeStored(ctx, [{ ...other, labels: { [EN]: 'x' } }], () => other)[0].labels, { [EN]: 'x' });
  });

  test("process names Dynamics keeps, after the Workbench loaded the process again: the popup still shows the kept name, an edit staged before is saved against it (no conflict) and clearing it is still refused", async () => {
    const { slots, merged } = await kept();
    const { W, ctx } = server();
    const store = new Store();
    store.add(merged);
    const key = byId(merged)[S1].key;
    store.set(key, FR, 'Étape un');
    // As ui/app.ts load() adds the Workbench's slots.
    store.add(mergeStored(ctx, slots, (k) => store.get(k)));
    const s1 = store.get(key)!;
    const app = { store, ctx: { base: EN, user: FR, langs: LANGS }, prefs: { target: FR, shown: [], showNames: false, dock: 'right' } } as unknown as AppApi;
    eq([store.original(key, FR), store.value(key, FR), look(app, s1.comp), canClear(s1, FR)], ['Étape 1 FR', 'Étape un', 'edited', false]);
    store.revert(key, FR);
    eq([look(app, s1.comp), placeholderOf(store, s1, FR, EN, 'Label', 'French'), isMissing(store, s1, FR, EN)], ['ok', 'Shows “Étape 1 FR”', false]);
    const o: SaveOptions = { signal: new AbortController().signal, publish: new PublishSet(), progress: () => {}, force: new Set(), lang: {} as SaveOptions['lang'], allowPublish: true };
    const res = await bpfWriter.save(ctx, [{ slot: s1, lcid: FR, before: 'Étape 1 FR', after: 'Étape un' }], o);
    eq(res.map((r) => r.outcome), ['saved'], 'measured against the kept name, not the empty definition');
    ok(W.doc.xaml.includes(tag(S1, FR, 'Étape un')), W.doc.xaml);
  });

  test("a name that starts with { goes into the definition with XAML's {} escape (else XAML reads a markup extension) and is read without it; clientdata keeps the text as typed; saved again it is unchanged", async () => {
    const { W, ctx } = server();
    // As a XAML writer stores "{Stage} 2": escaped in the xaml, as typed in clientdata.
    W.doc.xaml = W.doc.xaml.replace(tag(S2, FR, 'Test2 FR'), tag(S2, FR, '{}{Stage} 2'));
    W.doc.clientdata = W.doc.clientdata.replace('"description":"Test2 FR"', '"description":"{Stage} 2"');
    const s2 = byId(await loadBpfLabels(ctx, WF, opts()))[S2];
    eq(s2.labels[FR], '{Stage} 2', 'read without the escape');
    const o = (): SaveOptions => ({ signal: new AbortController().signal, publish: new PublishSet(), progress: () => {}, force: new Set(), lang: {} as SaveOptions['lang'], allowPublish: true });
    const res = await bpfWriter.save(ctx, [{ slot: s2, lcid: FR, before: '{Stage} 2', after: '{Phase} 2' }, { slot: s2, lcid: DE, before: '', after: '{Phase} 2 DE' }], o());
    eq(res.map((r) => r.outcome), ['saved', 'saved']);
    ok(W.doc.xaml.includes(tag(S2, FR, '{}{Phase} 2')) && W.doc.xaml.includes('Description="{}{Phase} 2 DE"'), W.doc.xaml);
    ok(W.doc.clientdata.includes('"description":"{Phase} 2"') && W.doc.clientdata.includes('"description":"{Phase} 2 DE"'), W.doc.clientdata);
    const again = await bpfWriter.save(ctx, [{ slot: s2, lcid: FR, before: '{Phase} 2', after: '{Phase} 2' }], o());
    eq(again.map((r) => r.outcome), ['unchanged'], 'the escaped definition holds the text');
  });

  test('a process from a managed solution: its stage and step labels load read-only with the managed reason, whatever its managed properties allow; an unmanaged one stays editable, also marked not customizable; the Workbench leaves the managed one out unless read-only labels are asked for', async () => {
    const { W, ctx } = server();
    W.doc.ismanaged = true;
    const slots = await loadBpfLabels(ctx, WF, opts());
    eq(slots.map((x) => [x.kind, x.readOnly, x.ref.managed]), [['stage', MANAGED, true], ['step', MANAGED, true], ['stage', MANAGED, true]]);
    W.doc = { ...workflow(), iscustomizable: { Value: false } };
    eq((await loadBpfLabels(ctx, WF, opts())).map((x) => [x.readOnly, x.ref.managed]), [['', false], ['', false], ['', false]]);
    // The Workbench: the flows of the table, this one from a managed solution or not.
    let managed = true;
    (ctx as { http: Record<string, unknown> }).http.all = async (u: string) =>
      u.startsWith('workflows?') ? [{ workflowid: WF, primaryentity: 'account', ismanaged: managed, iscustomizable: { Value: true }, businessprocesstype: 0 }] : [];
    W.doc = { ...workflow(), ismanaged: true };
    const scope = (includeReadOnly: boolean) => loadBpfScope(ctx, { entities: ['account'], kinds: new Set<Kind>(['stage', 'step']), includeReadOnly }, opts());
    eq((await scope(false)).length, 0, 'left out');
    eq([...new Set((await scope(true)).map((x) => x.readOnly))], [MANAGED], 'read-only when asked for');
    managed = false;
    W.doc = workflow();
    eq((await scope(false)).map((x) => x.readOnly), ['', '', '']);
  });
}
