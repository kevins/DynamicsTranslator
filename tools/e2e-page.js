// Live suite for translation mode (the page editor). Load a dev build of the full app on one of these pages:
//   dist/bridge.html?f=translator.debug.js,e2e-page.js&back=<page>
//   * a record of the test table new_dxttest ("Translator smoke test"): form labels, tooltip, tab, table name, values
//     of a multi-select, a quick view, a sub-grid's linked columns, a side pane, the related menu;
//   * the new_dxttest list in the Translator Test App: a modern command and a classic ribbon button;
//   * a record with a business process flow (the account "DXT BPF Test", "bpf test"): a stage and a step, and the
//     account form (a managed solution's) read-only, nothing staged on it.
// It opens real popups through the dev handles (app.dev.mode), types into their inputs, presses Done (the edits
// are staged), publishes them through app.review() and the Publish dialog (clicking its Publish button), and checks
// with independent reads (raw fetch, Consistency: Strong, no HTTP cache) that exactly the intended slot changed, in
// exactly the target language, then restores the same way. app.dev.noRefresh keeps the page from reloading after
// a successful publish (the dialog shows "Done" instead). Some steps make one request fail on purpose (a publish
// answered 503, a write whose answer is lost) to check the dialog's Publish again and Try again, and some put labels
// back through Recent publishes' Undo, as a user would.
// Results: window.__dxtPage = { running, log: [{ name, pass, info }] }.
window.__dxtPage = { running: true, log: [] };
(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const log = window.__dxtPage.log;
  const ok = (name, cond, info) => log.push({ name, pass: !!cond, info: cond ? undefined : String(JSON.stringify(info)).slice(0, 900) });
  const step = async (name, fn) => {
    try {
      await fn();
    } catch (e) {
      log.push({ name: name + ' EXCEPTION', pass: false, info: String((e && e.stack) || e).slice(0, 900) });
    }
  };
  for (let i = 0; i < 160 && !window.__dxtDev?.app?.dev?.mode?.(); i++) await sleep(250);
  const d = window.__dxtDev;
  const app = d.app;
  const { ctx, store } = d;
  const mode = app.dev.mode();
  app.dev.noRefresh = true;
  const E = 'new_dxttest';
  const T = app.prefs.target;
  const B = ctx.base;
  const api = ctx.http.api;
  const H = { Accept: 'application/json', 'If-None-Match': 'null', Consistency: 'Strong' };
  const get = async (u) => {
    const r = await fetch(api + u, { headers: { ...H, 'x-ms-sw-skipcache': '1' }, cache: 'no-store' });
    if (!r.ok) throw new Error(`${r.status} ${u}: ${(await r.text()).slice(0, 200)}`);
    return r.json();
  };
  // The user's Dynamics language now (ctx.user is read once at load; the user may have switched since): published form
  // XML and RetrieveUnpublished tab labels come back in this language only.
  const uiLang = async () => (await get(`usersettingscollection(${ctx.userId})?$select=uilanguageid`)).uilanguageid;
  const labelsOf = (L) => Object.fromEntries((L?.LocalizedLabels || []).map((l) => [l.LanguageCode, l.Label]));
  const xml = (x) => new DOMParser().parseFromString(x, 'application/xml');
  const norm = (id) => String(id || '').replace(/[{}]/g, '').toLowerCase();
  // Which steps run depends on the page: a record of the test table (its form, quick view, sub-grid, side pane, related
  // menu), the test table's list (command bar: modern and classic buttons), a record with a business process flow.
  for (let i = 0; i < 120 && !mode.dev.loader.page; i++) await sleep(250);
  const page = mode.dev.loader.page;
  const where = page?.info.type === 'entityrecord' && page.entity === E ? 'record' : page?.info.type === 'entitylist' && page.entity === E ? 'list' : page?.bpfId ? 'process' : '';
  ok('a page this suite knows (a new_dxttest record or list, a record with a process)', where, page?.info);
  // The page's loads start on the mode's first tick (later when the window is hidden): wait for what the steps need.
  const has = (fn) => () => [...store.slots.values()].some(fn);
  const ready = { record: has((s) => s.kind === 'field' && s.entity === E && s.ref?.controlId === 'new_name'), list: () => true, process: has((s) => s.kind === 'stage') }[where] || (() => true);
  for (let i = 0; i < 180 && (!ready() || mode.loading()); i++) await sleep(500);
  await sleep(1500);

  const slots = [...store.slots.values()];
  const cell = slots.find((s) => s.kind === 'field' && s.ref?.controlId === 'new_name');
  const FORM = cell?.ref?.formId;
  const unpub = async () => xml((await get(`systemforms(${FORM})/Microsoft.Dynamics.CRM.RetrieveUnpublished()?$select=formxml`)).formxml);
  const pub = async () => xml((await get(`systemforms(${FORM})?$select=formxml`)).formxml);
  const cellLabels = (doc, id) => {
    const c = [...doc.getElementsByTagName('cell')].find((x) => norm(x.getAttribute('id')) === norm(id));
    return Object.fromEntries([...(c?.querySelector(':scope > labels')?.children || [])].map((l) => [Number(l.getAttribute('languagecode')), l.getAttribute('description')]));
  };
  const setValue = (inp, v) => {
    const proto = Object.getPrototypeOf(inp);
    Object.getOwnPropertyDescriptor(proto, 'value').set.call(inp, v);
    inp.dispatchEvent(new Event('input', { bubbles: true }));
  };
  const callout = () => app.root.querySelector('.co');
  const dialog = () => app.root.querySelector('.dialog');
  const button = (root, text) => [...(root?.querySelectorAll('button') || [])].find((b) => b.textContent.trim() === text && !b.disabled && b.offsetParent !== null);
  /**
   * Opens a component's popup and returns the input of `key` in language `l` (opening disclosures if needed). `from`:
   * the page element of the label clicked (the popup opens on that label, as after a click on it).
   */
  async function input(comp, key, l, focus, from) {
    if (callout()) callout().querySelector('.co-f .btn.primary')?.click(); // Done
    await sleep(150);
    const opened = mode.open(comp, { focus: focus || key, lcid: l, ...(from ? { from } : {}) });
    await sleep(400);
    const co = callout();
    if (!opened || !co) return { err: 'popup did not open', opened };
    const sel = `[data-k="${CSS.escape(key + '#' + l)}"]`;
    let inp = co.querySelector(sel);
    for (let i = 0; !inp && i < 3; i++) {
      for (const b of co.querySelectorAll('[aria-expanded="false"]')) b.click();
      await sleep(200);
      inp = co.querySelector(sel);
    }
    return inp ? { co, inp } : { err: 'no input for ' + key, text: co.innerText.slice(0, 600) };
  }
  /** Types `text` into a component's input and presses Done: the edit is staged, nothing is saved. */
  async function stage(comp, key, l, text, focus, from) {
    const r = await input(comp, key, l, focus, from);
    if (r.err) return r;
    setValue(r.inp, text);
    await sleep(100);
    const done = r.co.querySelector('.co-f .btn.primary');
    if (!done) return { err: 'no Done button', why: r.co.innerText.slice(0, 400) };
    done.click();
    await sleep(200);
    if (callout()) return { err: 'Done did not close the popup' };
    if (store.value(key, l) !== text) return { err: 'not staged', v: store.value(key, l) };
    return { ok: true };
  }
  /** The dialog on top (the Undo question opens over Recent publishes) and its title. */
  const top = () => [...app.root.querySelectorAll('.dialog')].pop();
  const topTitle = () => top()?.querySelector('h3')?.textContent.trim() || '';
  /** Closes every dialog: Close, else Cancel, else the title bar's X (a run in progress has none: it stays). */
  async function closeAll() {
    for (let i = 0; i < 4 && top(); i++) {
      (button(top(), 'Close') || button(top(), 'Cancel') || top().querySelector('.dlg-h .btn:not([disabled])'))?.click();
      await sleep(300);
    }
  }
  /** The Publish dialog's promise once it is closed; null if it hasn't closed within 10 seconds. */
  const closed = (pending) => Promise.race([pending, sleep(10000).then(() => null)]);
  /**
   * Clicks Publish (`during` runs right after the click) and waits for the run's end, its Close button. A click before
   * the check of others' unpublished work answers waits for it and goes on by itself only when it has nothing to say;
   * once its sentence shows, the next click publishes. Resolves with the Close button, or null.
   */
  async function runPublish(pb, during) {
    pb.click();
    if (during) during();
    let again = true;
    for (let i = 0; i < 1600 && !button(dialog(), 'Close'); i++) {
      await sleep(250);
      const o = dialog()?.querySelector('.pd-o');
      const p = again && o && !o.hidden && !o.querySelector('.wait') && button(dialog(), 'Publish');
      if (p) {
        again = false;
        p.click();
      }
    }
    return button(dialog(), 'Close');
  }
  /**
   * Publishes every staged change through app.review(): waits for the Publish dialog, clicks Publish (`during`
   * runs right after the click), waits for its result and closes it. Resolves with the report and the dialog's text.
   */
  async function publish(during) {
    const pending = app.review();
    let dlg = null;
    for (let i = 0; i < 40 && !(dlg = dialog()); i++) await sleep(100);
    if (!dlg) return { err: 'no Publish dialog', rep: await closed(pending) };
    const listText = dlg.innerText;
    const pb = button(dlg, 'Publish');
    if (!pb) {
      await closeAll();
      return { err: 'no Publish button', text: listText.slice(0, 600) };
    }
    const closeB = await runPublish(pb, during);
    const text = dialog()?.innerText || '';
    if (!closeB) {
      await closeAll();
      return { err: 'the publish never ended', text: text.slice(0, 600) };
    }
    closeB.click();
    const rep = await closed(pending);
    return { ok: /Done\./.test(text), rep, listText, text: text.slice(0, 600), outcomes: rep?.results?.map((x) => [x.outcome, x.message]) };
  }
  const tgt = (cur, t) => (cur === t ? t + ' 2' : t);
  const orig = (v, fb) => (v && !/E2E/.test(v) ? v : fb);
  /** Stages `text` and publishes it. */
  async function viaPopup(comp, key, l, text, focus, from) {
    const s = await stage(comp, key, l, text, focus, from);
    if (s.err) return s;
    return publish();
  }
  /** The id of the journal entry the publish just made for `key` (newer than `last`, the newest before it), else null. */
  const madeFor = (last, key) => {
    const e = app.saver.history()[0];
    return e && e.id !== last && e.items.some((it) => it.key === key) ? e.id : null;
  };
  /**
   * Makes the next request `match(url, init)` accepts fail, once: '503', answered 503 with no Retry-After (Dataverse's
   * "busy", which nothing retries); 'lost', sent and then its answer lost, as when the connection drops. `off()` puts
   * fetch back; `hit` counts the failures made.
   */
  function failOnce(match, how) {
    const f0 = window.fetch;
    const st = { hit: 0, off: () => (window.fetch = f0) };
    window.fetch = function (input, init) {
      const u = typeof input === 'string' ? input : input?.url || '';
      if (!st.hit && match(u, init || {})) {
        st.hit++;
        if (how === '503') return Promise.resolve(new Response('', { status: 503 }));
        return f0.apply(this, arguments).then(() => {
          throw new TypeError('Failed to fetch');
        });
      }
      return f0.apply(this, arguments);
    };
    return st;
  }
  /**
   * Opens the Publish dialog on what is staged and clicks Publish while `match` fails once (failOnce), then waits for
   * the run's end (its Close button), leaving the dialog open. Resolves with its title and text, and the dialog's promise.
   */
  async function publishFailing(match, how) {
    const pending = app.review();
    let dlg = null;
    for (let i = 0; i < 40 && !(dlg = dialog()); i++) await sleep(100);
    const pb = button(dlg, 'Publish');
    if (!pb) {
      const text = dlg?.innerText.slice(0, 400);
      await closeAll();
      return { err: 'no Publish button', text, pending };
    }
    const f = failOnce(match, how);
    let closeB = null;
    try {
      closeB = await runPublish(pb);
    } finally {
      f.off();
    }
    const out = { hit: f.hit, title: topTitle(), text: dialog()?.innerText.slice(0, 800) || '', pending };
    if (!closeB) {
      await closeAll();
      return { err: 'the publish never ended', ...out };
    }
    return out;
  }
  /** Clicks `label` in the dialog and waits for the run it starts to end (its Close button again). */
  async function clickAndWait(label) {
    const b = button(dialog(), label);
    if (!b) return { err: `no ${label} button`, text: dialog()?.innerText.slice(0, 600) };
    b.click();
    await sleep(300);
    for (let i = 0; i < 1600 && !button(dialog(), 'Close'); i++) await sleep(250);
    const out = { title: topTitle(), text: dialog()?.innerText.slice(0, 800) || '' };
    return button(dialog(), 'Close') ? out : { err: `${label} never ended`, ...out };
  }
  /**
   * Undoes the publish `id` (a journal entry) as a user does: More options › Recent publishes, its Undo, then Undo in
   * "Undo this publish?" (which reads each label first and waits for the check of others' unpublished work). Closes the
   * dialogs. An undo is listed as a publish of its own (its Redo), newest.
   */
  async function undoPublish(id) {
    const at = id ? app.saver.history().findIndex((e) => e.id === id) : -1;
    const more = app.dev.bar()?.el?.querySelector('button[aria-label="More options"]');
    if (at < 0 || !more) return { err: at < 0 ? 'not in Recent publishes' : 'no More options button', id };
    more.click();
    let mi = null;
    for (let i = 0; i < 20 && !(mi = [...app.root.querySelectorAll('[role="menuitem"]')].find((b) => b.textContent.trim().startsWith('Recent publishes'))); i++) await sleep(100);
    if (!mi) return { err: 'no Recent publishes in the menu' };
    mi.click();
    // Listed newest first, as the journal is.
    let row = null;
    for (let i = 0; i < 40 && !(row = top()?.querySelectorAll('.pd-he')[at]); i++) await sleep(100);
    const ub = row && [...row.querySelectorAll('button')].find((b) => b.textContent.trim() === 'Undo');
    if (!ub || ub.disabled) {
      const text = top()?.innerText.slice(0, 400);
      await closeAll();
      return { err: 'no Undo on that publish', text };
    }
    ub.click();
    let go = null;
    for (let i = 0; i < 300 && !go; i++) {
      await sleep(100);
      const b = topTitle() === 'Undo this publish?' ? top().querySelector('.dlg-actions .btn.primary') : null;
      if (b && !b.disabled && /^Undo \d/.test(b.textContent.trim())) go = b;
    }
    if (!go) {
      const out = { err: 'the Undo question offered no Undo', title: topTitle(), text: top()?.innerText.slice(0, 600) };
      await closeAll();
      return out;
    }
    const asked = top().innerText.slice(0, 600);
    go.click();
    const END = ['Publish undone', 'Undone with problems', 'Undo stopped', 'Undo failed'];
    for (let i = 0; i < 1600 && !END.includes(topTitle()); i++) await sleep(250);
    const out = { title: topTitle(), text: top()?.innerText.slice(0, 600) || '', asked, undone: !!app.saver.history().find((e) => e.id === id)?.undoneAt };
    await closeAll();
    return { ok: out.title === 'Publish undone' && out.undone, ...out };
  }

  const anchors = () => mode.dev.anchors();
  /** The first anchor `ok` accepts, waiting for the page to render it and the scanner to find it. */
  async function anchorOf(pred, ms = 20000) {
    for (let i = 0; i < ms / 250; i++) {
      const a = anchors().find(pred);
      if (a) return a;
      await sleep(250);
    }
    return null;
  }
  const show = (a) => a && { key: a.key, part: a.part, text: a.text?.nodeValue };
  const inGrid = (a) => !!a.el.closest('[role="gridcell"],[role="columnheader"]');
  const inPane = (a) => !!a.el.closest('[data-id^="pane-container-"]');
  const options = async (entity, attr, cast) =>
    (await get(`EntityDefinitions(LogicalName='${entity}')/Attributes(LogicalName='${attr}')/Microsoft.Dynamics.CRM.${cast}?$select=LogicalName&$expand=OptionSet($select=Options)`)).OptionSet.Options;
  const optLabels = async (entity, attr, cast, v) => labelsOf((await options(entity, attr, cast)).find((o) => o.Value === v)?.Label);
  const colLabels = async (entity, attr) => labelsOf((await get(`EntityDefinitions(LogicalName='${entity}')/Attributes(LogicalName='${attr}')?$select=DisplayName`)).DisplayName);
  const formXml = async (id) => xml((await get(`systemforms(${id})/Microsoft.Dynamics.CRM.RetrieveUnpublished()?$select=formxml`)).formxml);

  /** Translations of a localizable record column (view, command…), as RetrieveLocLabels returns them (unpublished included). */
  const loc = async (set, id, col) =>
    labelsOf((await get(`RetrieveLocLabels(EntityMoniker=@e,AttributeName=@a,IncludeUnpublished=@u)?@e=${encodeURIComponent(JSON.stringify({ '@odata.id': `${set}(${id})` }))}&@a='${col}'&@u=true`)).Label);

  if (where === 'record') {
    await step('field label', async () => {
      ok('field cell found', !!cell, slots.filter((s) => s.kind === 'field').map((s) => s.ref?.controlId));
      const b = cellLabels(await unpub(), cell.ref.elId);
      const t = tgt(b[T], 'Nom page E2E');
      const r = await viaPopup(cell.comp, cell.key, T, t);
      const a = cellLabels(await unpub(), cell.ref.elId);
      ok('field label published through the popup', r.ok && a[T] === t && a[B] === b[B] && r.rep?.published, { r, b, a });
      ok('the Publish dialog lists it as a form label', /Form label/.test(r.listText || ''), r.listText);
      // Published XML has the user's language only.
      if ((await uiLang()) === T) ok('the published form has it', cellLabels(await pub(), cell.ref.elId)[T] === t, cellLabels(await pub(), cell.ref.elId));
      const r2 = await viaPopup(cell.comp, cell.key, T, orig(b[T], 'Nom'));
      ok('field label restored', r2.ok && cellLabels(await unpub(), cell.ref.elId)[T] === orig(b[T], 'Nom'), r2);
    });

    await step('field tooltip', async () => {
      const key = `attribute|${E}.new_name|Description`;
      const read = async () => labelsOf((await get(`EntityDefinitions(LogicalName='${E}')/Attributes(LogicalName='new_name')?$select=Description`)).Description);
      const b = await read();
      const r0 = await input(cell.comp, key, T, cell.key);
      ok('field popup shows the tooltip (column description)', !r0.err, r0);
      const t = tgt(b[T], 'Infobulle E2E');
      const r = await viaPopup(cell.comp, key, T, t, cell.key);
      const a = await read();
      ok('tooltip published through the field popup', r.ok && a[T] === t && a[B] === b[B], { r, b, a });
      ok('the Publish dialog says the tooltip is shared', /Tooltip \(everywhere\)/.test(r.listText || ''), r.listText);
      if (b[T]) {
        const r2 = await viaPopup(cell.comp, key, T, orig(b[T], b[T]), cell.key);
        ok('tooltip restored', r2.ok && (await read())[T] === orig(b[T], b[T]), r2);
      }
    });

    await step('undo changes and Esc', async () => {
      const before = store.value(cell.key, T);
      const r = await input(cell.comp, cell.key, T);
      if (r.err) return ok('undo changes', false, r);
      setValue(r.inp, before + ' typed');
      await sleep(100);
      const undo = [...r.co.querySelectorAll('.co-f button')].find((x) => x.textContent.trim() === 'Undo changes');
      undo?.click();
      await sleep(200);
      ok('Undo changes restores the text and leaves no edit', !!undo && store.value(cell.key, T) === before && !store.isEdited(cell.key, T), { v: store.value(cell.key, T), before });
      const r2 = await input(cell.comp, cell.key, T);
      if (r2.err) return ok('Esc', false, r2);
      setValue(r2.inp, before + ' kept');
      r2.inp.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, composed: true }));
      await sleep(200);
      ok('Esc closes the popup and keeps the text staged', !callout() && store.value(cell.key, T) === before + ' kept', { open: !!callout(), v: store.value(cell.key, T) });
      store.revert(cell.key, T);
    });

    await step('text typed after Publish stays staged', async () => {
      const b = cellLabels(await unpub(), cell.ref.elId);
      const A = tgt(b[T], 'Nom A E2E');
      const s = await stage(cell.comp, cell.key, T, A);
      if (s.err) return ok('typed after publish', false, s);
      const r = await publish(() => store.set(cell.key, T, A + ' then more')); // typed right after Publish
      const a = cellLabels(await unpub(), cell.ref.elId);
      ok('only the text shown in the dialog was written', a[T] === A && store.value(cell.key, T) === A + ' then more' && store.isEdited(cell.key, T), { r, a: a[T], v: store.value(cell.key, T) });
      store.revert(cell.key, T);
      const r2 = await viaPopup(cell.comp, cell.key, T, orig(b[T], 'Nom'));
      ok('restored after the typed-after-publish check', r2.ok, r2);
    });

    // Published once the published form's version is the unpublished one (the Publish dialog's own check).
    const versions = async () => [(await get(`systemforms(${FORM})?$select=versionnumber`)).versionnumber, (await get(`systemforms(${FORM})/Microsoft.Dynamics.CRM.RetrieveUnpublished()?$select=versionnumber`)).versionnumber];

    await step('publish fails, then Publish again', async () => {
      // The publish after the save fails (one PublishXml answered 503): the dialog says the label is saved but not
      // published, and why, and offers Publish again; the form holds unpublished changes; Recent publishes lists the save
      // as not published. Publish again publishes it. Then Recent publishes' Undo puts the earlier text back, published.
      const b = cellLabels(await unpub(), cell.ref.elId);
      const t = tgt(b[T], 'Nom publication E2E');
      const last = app.saver.history()[0]?.id;
      try {
        const s = await stage(cell.comp, cell.key, T, t);
        if (s.err) return ok('publish fails: staged', false, s);
        const r = await publishFailing((u, i) => i.method === 'POST' && /\/PublishXml$/.test(u), '503');
        if (r.err) return ok('publish fails: the Publish dialog', false, r);
        const e = app.saver.history()[0];
        const [p1, u1] = await versions();
        ok('publish fails: the dialog says saved but not published, and why, and offers Publish again', r.hit === 1 && r.title === 'Saved, but not published' && /Saved, but publishing failed: Dataverse returned HTTP 503\./.test(r.text) && !!button(dialog(), 'Publish again'), r);
        ok('publish fails: the label is saved, the form not published, the save listed as not published', cellLabels(await unpub(), cell.ref.elId)[T] === t && p1 !== u1 && e && e.id !== last && e.published === false && e.items.some((it) => it.key === cell.key && it.after === t), { p1, u1, e });
        const r2 = await clickAndWait('Publish again');
        const [p2, u2] = await versions();
        ok('Publish again publishes it, and says so', r2.title === 'Published' && /Done\. Published 1 change\./.test(r2.text) && p2 === u2 && app.saver.history().find((x) => x.id === e?.id)?.published === true, { r2, p2, u2 });
        await closeAll();
        const rep = await closed(r.pending);
        ok('the Publish dialog reports it published', rep?.published === true && !rep.publishError, rep && { published: rep.published, publishError: rep.publishError });
        const un = await undoPublish(e && e.id !== last && e.items.some((it) => it.key === cell.key) ? e.id : null);
        const [p3, u3] = await versions();
        ok('Recent publishes › Undo of a form label: the earlier text back, published', un.ok && cellLabels(await unpub(), cell.ref.elId)[T] === b[T] && p3 === u3, { un, now: cellLabels(await unpub(), cell.ref.elId)[T], b: b[T], p3, u3 });
      } finally {
        await closeAll();
        if (store.isEdited(cell.key, T)) store.revert(cell.key, T);
        // Published first: a publish that failed leaves the form unpublished, and the Publish dialog would then ask first.
        const [p, u] = await versions();
        if (p !== u) await fetch(api + 'PublishXml', { method: 'POST', headers: { Accept: 'application/json', 'Content-Type': 'application/json' }, body: JSON.stringify({ ParameterXml: `<importexportxml><entities><entity>${E}</entity></entities></importexportxml>` }) });
        if (cellLabels(await unpub(), cell.ref.elId)[T] !== b[T]) await viaPopup(cell.comp, cell.key, T, orig(b[T], 'Nom'));
      }
    });

    await step('write answer lost, then Try again', async () => {
      // The form label's write reaches Dataverse but its answer is lost (the connection drops): the dialog can't tell
      // whether it was written and offers Try again. Try again finds it written, publishes it and journals it as this
      // publish's own (reaudit 06, SW01: a write that may have run), so Recent publishes' Undo puts the earlier text back.
      const b = cellLabels(await unpub(), cell.ref.elId);
      const t = tgt(b[T], 'Nom réponse E2E');
      const last = app.saver.history()[0]?.id;
      try {
        const s = await stage(cell.comp, cell.key, T, t);
        if (s.err) return ok('write answer lost: staged', false, s);
        const r = await publishFailing((u, i) => i.method === 'POST' && /\/\$batch$/.test(u) && typeof i.body === 'string' && /PATCH [^\r\n]*systemforms\(/.test(i.body), 'lost');
        if (r.err) return ok('write answer lost: the Publish dialog', false, r);
        ok("write answer lost: the dialog says it couldn't be checked and offers Try again; nothing journaled yet", r.hit === 1 && r.title === "Some changes weren't published" && /Sent to Dataverse, but the result could not be checked/.test(r.text) && !!button(dialog(), 'Try again') && app.saver.history()[0]?.id === last, r);
        ok('write answer lost: the write reached Dataverse', cellLabels(await unpub(), cell.ref.elId)[T] === t, cellLabels(await unpub(), cell.ref.elId));
        const r2 = await clickAndWait('Try again');
        const e = app.saver.history()[0];
        const [p2, u2] = await versions();
        ok("Try again: published, and journaled as this publish's own", r2.title === 'Published' && /Done\. Published 1 change\./.test(r2.text) && p2 === u2 && e && e.id !== last && e.published && e.items.length === 1 && e.items[0].key === cell.key && e.items[0].before === (b[T] || '') && e.items[0].after === t, { r2, e, p2, u2 });
        await closeAll();
        await closed(r.pending);
        const un = await undoPublish(e && e.id !== last && e.items.some((it) => it.key === cell.key) ? e.id : null);
        const [p3, u3] = await versions();
        ok('Recent publishes › Undo after Try again: the earlier text back, published', un.ok && cellLabels(await unpub(), cell.ref.elId)[T] === b[T] && p3 === u3, { un, now: cellLabels(await unpub(), cell.ref.elId)[T], b: b[T] });
      } finally {
        await closeAll();
        if (store.isEdited(cell.key, T)) store.revert(cell.key, T);
        // Published first: a publish that failed leaves the form unpublished, and the Publish dialog would then ask first.
        const [p, u] = await versions();
        if (p !== u) await fetch(api + 'PublishXml', { method: 'POST', headers: { Accept: 'application/json', 'Content-Type': 'application/json' }, body: JSON.stringify({ ParameterXml: `<importexportxml><entities><entity>${E}</entity></entities></importexportxml>` }) });
        if (cellLabels(await unpub(), cell.ref.elId)[T] !== b[T]) await viaPopup(cell.comp, cell.key, T, orig(b[T], 'Nom'));
      }
    });

    await step('tab label', async () => {
      const tab = slots.find((s) => s.kind === 'tab' && s.ref?.formId === FORM);
      const tabLabels = (doc) => Object.fromEntries([...([...doc.getElementsByTagName('tab')].find((x) => norm(x.getAttribute('id')) === norm(tab.ref.elId))?.querySelector(':scope > labels')?.children || [])].map((l) => [Number(l.getAttribute('languagecode')), l.getAttribute('description')]));
      // RetrieveUnpublished returns tab labels in the user's Dynamics language only.
      if ((await uiLang()) !== T) return ok('tab label (skipped: UI language is not the target)', true);
      const b = tabLabels(await unpub());
      const t = tgt(b[T], 'Général page E2E');
      const r = await viaPopup(tab.comp, tab.key, T, t);
      ok('tab label published through the popup', r.ok && tabLabels(await unpub())[T] === t, { r, b });
      const r2 = await viaPopup(tab.comp, tab.key, T, orig(b[T], 'Général'));
      ok('tab label restored', r2.ok && tabLabels(await unpub())[T] === orig(b[T], 'Général'), r2);
    });

    await step('table name', async () => {
      const key = `entity|${E}|DisplayName`;
      const read = async () => labelsOf((await get(`EntityDefinitions(LogicalName='${E}')?$select=DisplayName`)).DisplayName);
      const b = await read();
      const t = tgt(b[T], 'Test page E2E');
      const r = await viaPopup(`entity|${E}`, key, T, t);
      const a = await read();
      ok('table name published through the popup', r.ok && a[T] === t && a[B] === b[B], { r, b, a });
      const r2 = await viaPopup(`entity|${E}`, key, T, orig(b[T], 'Test du traducteur'));
      ok('table name restored', r2.ok && (await read())[T] === orig(b[T], 'Test du traducteur'), r2);
    });

    // ---- labels beyond the page form's own (LIVE-FINDINGS 54–58). Fixtures on new_dxttest's main form: the
    // multi-select new_dxtmulti, the quick view 'linkedqv' (new_dxtlinked's quick view form) on the lookup new_linkedid,
    // the sub-grid 'children' whose view has columns of new_dxtlinked; the record has values and a child record. ----

    await step('multi-select values', async () => {
      const BLEU = `option|${E}.new_dxtmulti|100000001|Label`;
      // The page shows the values in the user's Dynamics language ("Bleu" in French, "Blue" in English).
      const ui = await uiLang();
      const shown = async (v) => (await optLabels(E, 'new_dxtmulti', 'MultiSelectPicklistAttributeMetadata', v))[ui];
      const af = await anchorOf((a) => a.key === BLEU && a.part && !inGrid(a) && !inPane(a));
      ok('the form shows each multi-select value as its own part', af && af.part.text === (await shown(100000001)) && af.text.nodeValue.includes(','), show(af));
      const ag = await anchorOf((a) => a.key === `option|${E}.new_dxtmulti|100000002|Label` && a.part && inGrid(a));
      ok('a sub-grid cell shows each value as its own part', ag && ag.part.text === (await shown(100000002)), show(ag));
      if (!af) return;
      const cast = 'MultiSelectPicklistAttributeMetadata';
      const before = await options(E, 'new_dxtmulti', cast);
      const b = labelsOf(before.find((o) => o.Value === 100000001).Label);
      const t = tgt(b[T], 'Bleu E2E');
      const r = await viaPopup(af.comp, af.key, T, t, af.key, af.zone ?? af.el);
      const after = await options(E, 'new_dxtmulti', cast);
      const a = labelsOf(after.find((o) => o.Value === 100000001).Label);
      const others = (os) => JSON.stringify(os.filter((o) => o.Value !== 100000001).map((o) => [o.Value, labelsOf(o.Label)]));
      ok('the clicked value (and only it) published through its popup', r.ok && a[T] === t && a[B] === b[B] && others(after) === others(before), { r, b, a });
      const r2 = await viaPopup(af.comp, af.key, T, orig(b[T], 'Bleu'), af.key);
      ok('multi-select value restored', r2.ok && (await optLabels(E, 'new_dxtmulti', cast, 100000001))[T] === orig(b[T], 'Bleu'), r2);
    });

    await step('quick view field', async () => {
      const aq = await anchorOf((a) => a.kind === 'field' && !inPane(a) && a.hit?.getAttribute('data-id') === 'linkedqv.new_name-FieldSectionItemContainer');
      const s = aq && store.get(aq.key);
      const QV = s?.ref?.formId;
      ok('the quick view\'s field maps to a cell of the quick view form (another table), not the page form', aq && QV && QV !== FORM && s.entity === 'new_dxtlinked', show(aq));
      if (!QV) return;
      const host = cellLabels(await unpub(), cell.ref.elId);
      const b = cellLabels(await formXml(QV), s.ref.elId);
      const t = tgt(b[T], 'Nom lié E2E');
      const r = await viaPopup(aq.comp, aq.key, T, t, undefined, aq.zone ?? aq.el);
      const a = cellLabels(await formXml(QV), s.ref.elId);
      ok('quick view field label published to the quick view form', r.ok && a[T] === t && a[B] === b[B] && r.rep?.published, { r, b, a });
      ok('the page form\'s field of the same name is untouched', JSON.stringify(cellLabels(await unpub(), cell.ref.elId)) === JSON.stringify(host));
      const r2 = await viaPopup(aq.comp, aq.key, T, orig(b[T], 'Nom lié'));
      ok('quick view field label restored', r2.ok && cellLabels(await formXml(QV), s.ref.elId)[T] === orig(b[T], 'Nom lié'), r2);
    });

    await step('linked-table column header', async () => {
      const ah = await anchorOf((a) => a.key === 'attribute|new_dxtlinked.new_name|DisplayName' && a.role === 'header' && a.part);
      const al = await anchorOf((a) => a.key === `attribute|${E}.new_linkedid|DisplayName` && a.role === 'header' && a.part);
      ok('a linked column header shows the related column\'s name and the lookup\'s name as two parts', ah && al && ah.text === al.text && ah.part.end < al.part.start, [show(ah), show(al)]);
      if (!ah) return;
      const b = await colLabels('new_dxtlinked', 'new_name');
      const page = await colLabels(E, 'new_name');
      const t = tgt(b[T], 'Nom lié E2E');
      const r = await viaPopup(ah.comp, ah.key, T, t, ah.key, ah.zone ?? ah.el);
      const a = await colLabels('new_dxtlinked', 'new_name');
      ok('the related table\'s column name published from its header', r.ok && a[T] === t && a[B] === b[B], { r, b, a });
      ok('the page table\'s column of the same name is untouched', JSON.stringify(await colLabels(E, 'new_name')) === JSON.stringify(page));
      const r2 = await viaPopup(ah.comp, ah.key, T, orig(b[T], 'Nom lié'), ah.key);
      ok('linked column name restored', r2.ok && (await colLabels('new_dxtlinked', 'new_name'))[T] === orig(b[T], 'Nom lié'), r2);
    });

    await step('side pane form', async () => {
      const LINKED = (await get(`new_dxtlinkeds?$select=new_name&$filter=new_name eq 'Linked A'`)).value[0]?.new_dxtlinkedid;
      const pane = await Xrm.App.sidePanes.createPane({ title: 'E2E pane', paneId: 'dxte2e', canClose: true, width: 420 });
      try {
        await pane.navigate({ pageType: 'entityrecord', entityName: 'new_dxtlinked', entityId: LINKED });
        const ap = await anchorOf((a) => inPane(a) && a.kind === 'field' && a.hit?.getAttribute('data-id') === 'new_name-FieldSectionItemContainer', 40000);
        const s = ap && store.get(ap.key);
        const PF = s?.ref?.formId;
        ok('a side pane\'s field (same control name as the page\'s) maps to its own form\'s cell', ap && PF && PF !== FORM && s.entity === 'new_dxtlinked', show(ap));
        const tabA = anchors().find((a) => inPane(a) && a.role === 'tab');
        ok('the side pane\'s tab maps to its own form\'s tab', tabA && store.get(tabA.key)?.ref?.formId === PF, show(tabA));
        if (!PF) return;
        const host = cellLabels(await unpub(), cell.ref.elId);
        const b = cellLabels(await formXml(PF), s.ref.elId);
        const t = tgt(b[T], 'Nom lié volet E2E');
        const r = await viaPopup(ap.comp, ap.key, T, t, undefined, ap.zone ?? ap.el);
        const a = cellLabels(await formXml(PF), s.ref.elId);
        ok('the side pane field label published to the side pane\'s form', r.ok && a[T] === t && a[B] === b[B] && r.rep?.published, { r, b, a });
        ok('the page form\'s field of the same name is untouched', JSON.stringify(cellLabels(await unpub(), cell.ref.elId)) === JSON.stringify(host));
        const r2 = await viaPopup(ap.comp, ap.key, T, orig(b[T], 'Nom lié'));
        ok('side pane field label restored', r2.ok && cellLabels(await formXml(PF), s.ref.elId)[T] === orig(b[T], 'Nom lié'), r2);
      } finally {
        pane.close();
      }
    });
    // ---- the related menu (LIVE-FINDINGS 63). Fixtures on new_dxttest: the N:N new_dxttest_self_nn (to itself: two
    // items, crossed) and the 1:N new_dxttest_dxtlinked_testid (UseCollectionName: shows new_dxtlinked's plural name). ----
    await step('related menu', async () => {
      // Its items render once it opens (Dynamics' own click on the Related tab: synthetic clicks reach the page).
      document.querySelector('li[data-lp-id="form-tab-related_tab"],li[id^="related_tab"]')?.click();
      const item = (id) => anchorOf((a) => a.role === 'nav' && a.el.getAttribute('data-id') === `form-tab-relatedEntity-${id}`);
      const [one, two, plural] = [await item('nav_new_dxttest_self_nn1'), await item('nav_new_dxttest_self_nn2'), await item('nav_new_dxttest_dxtlinked_testid')];
      ok(
        'related menu items map to the side or the table name they show',
        one?.key === 'relationship|new_dxttest_self_nn|2|Label' && two?.key === 'relationship|new_dxttest_self_nn|1|Label' && plural?.key === 'entity|new_dxtlinked|DisplayCollectionName',
        [show(one), show(two), show(plural)],
      );
      const menus = async () => {
        const r = await get(`RelationshipDefinitions(SchemaName='new_dxttest_self_nn')/Microsoft.Dynamics.CRM.ManyToManyRelationshipMetadata?$select=Entity1AssociatedMenuConfiguration,Entity2AssociatedMenuConfiguration`);
        return [labelsOf(r.Entity1AssociatedMenuConfiguration.Label), labelsOf(r.Entity2AssociatedMenuConfiguration.Label)];
      };
      if (one) {
        const [b1, b2] = await menus();
        const t = tgt(b2[T], 'Soi deux E2E');
        const r = await viaPopup(one.comp, one.key, T, t, one.key, one.zone ?? one.el);
        const [a1, a2] = await menus();
        ok("the item's menu label published to the side it shows; the other side untouched", r.ok && a2[T] === t && a2[B] === b2[B] && JSON.stringify(a1) === JSON.stringify(b1), { r, b1, b2, a1, a2 });
        const r2 = await viaPopup(one.comp, one.key, T, orig(b2[T], 'Soi deux'), one.key);
        ok('relationship menu label restored', r2.ok && (await menus())[1][T] === orig(b2[T], 'Soi deux'), r2);
      }
      if (plural) {
        const read = async () => labelsOf((await get(`EntityDefinitions(LogicalName='new_dxtlinked')?$select=DisplayCollectionName`)).DisplayCollectionName);
        const b = await read();
        const t = tgt(b[T], 'Tests liés E2E');
        const r = await viaPopup(plural.comp, plural.key, T, t, plural.key, plural.zone ?? plural.el);
        const a = await read();
        ok("the related table's plural name published from its menu item", r.ok && a[T] === t && a[B] === b[B], { r, b, a });
        const r2 = await viaPopup(plural.comp, plural.key, T, orig(b[T], 'Tests liés du traducteur'), plural.key);
        ok('plural name restored', r2.ok && (await read())[T] === orig(b[T], 'Tests liés du traducteur'), r2);
      }
    });
  }

  // ---- the command bar of the test table's list: a modern command and a classic ribbon button (slow: a solution
  // import per save, LIVE-FINDINGS 25). ----
  if (where === 'list') {
    await step('modern command', async () => {
      const a = await anchorOf((x) => x.kind === 'command' && x.role === 'command' && x.key.endsWith('|Label'), 40000);
      ok('a modern command button is marked', a, anchors().filter((x) => x.role === 'command').map(show));
      if (!a) return;
      const id = a.comp.split('|')[1];
      const b = await loc('appactions', id, 'buttonlabeltext');
      const t = tgt(b[T], 'Approuver E2E');
      const r = await viaPopup(a.comp, a.key, T, t, a.key, a.zone ?? a.el);
      const c = await loc('appactions', id, 'buttonlabeltext');
      ok("the command's label published from its button", r.ok && c[T] === t && c[B] === b[B], { r, b, c });
      const r2 = await viaPopup(a.comp, a.key, T, b[T] || '', a.key);
      ok('command label restored', r2.ok && ((await loc('appactions', id, 'buttonlabeltext'))[T] || '') === (b[T] || ''), r2);
    });
    await step('classic ribbon button', async () => {
      const a = await anchorOf((x) => x.kind === 'ribbon' && x.role === 'command' && x.key.includes('|new.new_dxttest.DxtButton.LabelText|'), 60000);
      ok('the classic ribbon button is marked', a, anchors().filter((x) => x.role === 'command').map(show));
      if (!a) return;
      const id = a.comp.split('|')[2];
      const rdx = async () => (await get(`ribbondiffs?$select=diffid,rdx&$filter=entity eq '${E}' and difftype eq 3`)).value.find((x) => x.diffid === id)?.rdx || '';
      const title = (x, l) => new RegExp(`description="([^"]*)" languagecode="${l}"|languagecode="${l}" description="([^"]*)"`).exec(x)?.slice(1).find(Boolean) || '';
      const b = await rdx();
      const t = tgt(title(b, T), 'Lancer le test E2E');
      const last = app.saver.history()[0]?.id;
      const r = await viaPopup(a.comp, a.key, T, t, a.key, a.zone ?? a.el);
      const mine = madeFor(last, a.key);
      const c = await rdx();
      ok("the button's LocLabel published from the button (translation import)", r.ok && title(c, T) === t && title(c, B) === title(b, B), { r, b: [title(b, B), title(b, T)], c: [title(c, B), title(c, T)] });
      // Put back by Recent publishes' Undo (another translation import), as a user would; by a publish if it fails.
      const un = await undoPublish(mine);
      const d = await rdx();
      ok('Recent publishes › Undo of a classic ribbon label: the earlier title back, published', un.ok && d === b, { un, now: [title(d, B), title(d, T)], b: [title(b, B), title(b, T)] });
      if (title(d, T) !== title(b, T)) {
        const r2 = await viaPopup(a.comp, a.key, T, title(b, T), a.key);
        ok('button label restored', r2.ok && title(await rdx(), T) === title(b, T), r2);
      }
    });
  }

  // ---- a record with a business process flow ("bpf test" on the account "DXT BPF Test"): a stage and a step. The
  // definition is put back byte for byte at the end, as the provider suite does (tools/e2e-suite.js 'bpf'). ----
  if (where === 'process') {
    await step('managed form read-only', async () => {
      // The account form comes from Microsoft's managed solutions: its labels are read-only (a translation would be an
      // unmanaged layer on top of it), while the process "bpf test" on it is this environment's and stays editable.
      const formId = norm(page.formId);
      const managed = formId && (await get(`systemforms(${formId})?$select=ismanaged`)).ismanaged;
      ok("the page's account form is from a managed solution (what this step checks)", managed === true, { formId, managed });
      if (managed !== true) return;
      const fields = [...store.slots.values()].filter((s) => s.kind === 'field' && norm(s.ref?.formId) === formId);
      ok('every label of the account form is read-only: it is from a managed solution', fields.length && fields.every((s) => s.ref?.managed === true && /^From a managed solution: /.test(s.readOnly)), fields.slice(0, 5).map((s) => [s.key, s.readOnly]));
      const f = fields[0];
      if (!f) return;
      const r = await input(f.comp, f.key, T);
      ok("its popup's inputs are disabled and it says why", !r.err && r.inp.disabled && /From a managed solution/.test(r.co.innerText), r.err || r.co.innerText.slice(0, 400));
      callout()?.querySelector('.co-f .btn.primary')?.click(); // Done
      await sleep(150);
      store.set(f.key, T, 'E2E managed');
      ok('nothing is staged on it', !store.isEdited(f.key), store.pendingCount());
    });

    /** A XAML attribute's text: its entities decoded, XAML's `{}` escape taken off (bpf.ts xamlText). */
    const unxml = (v) => {
      const t = String(v ?? '').replace(/&(?:#(x?)([\da-f]+)|(\w+));/gi, (m, x, n, e) => (e ? ({ amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" }[e] ?? m) : String.fromCodePoint(parseInt(n, x ? 16 : 10))));
      return t.startsWith('{}') ? t.slice(2) : t;
    };
    /**
     * A stage's or step's texts in language `l`, in the definition's xaml and in its clientdata. The xaml is read with a
     * pattern, as bpf.ts reads it: browsers refuse its `clr-namespace:` namespaces.
     */
    const stepLabels = (w, labelId, l) => {
      const out = { xaml: [], clientdata: [] };
      for (const m of String(w.xaml).matchAll(/<\w+:StepLabel\b((?:"[^"]*"|'[^']*'|[^>"'])*?)\/>/g)) {
        const a = Object.fromEntries([...m[1].matchAll(/([\w:.-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)].map(([, k, dq, sq]) => [k, dq ?? sq]));
        if (norm(a.LabelId) === norm(labelId) && Number(a.LanguageCode) === l) out.xaml.push(unxml(a.Description));
      }
      const visit = (v) => {
        if (!v || typeof v !== 'object') return;
        if (Array.isArray(v.stepLabels?.list)) for (const e of v.stepLabels.list) if (norm(e.labelId) === norm(labelId) && Number(e.languageCode) === l) out.clientdata.push(e.description);
        for (const k in v) if (k !== 'stepLabels') visit(v[k]);
      };
      visit(JSON.parse(w.clientdata || 'null'));
      return out;
    };

    await step('process stage and step', async () => {
      const WF = page.bpfId;
      const orig0 = await get(`workflows(${WF})?$select=xaml,clientdata`);
      localStorage.setItem('dxt:test:bpfOriginal', JSON.stringify({ xaml: orig0.xaml, clientdata: orig0.clientdata }));
      try {
        const st = await anchorOf((a) => a.role === 'stage');
        ok('the stage is marked', st && st.kind === 'stage', show(st));
        if (!st) return;
        const wasStage = store.get(st.key).labels[T] || '';
        const t = tgt(wasStage, 'Étape page E2E');
        const lastS = app.saver.history()[0]?.id;
        const r = await viaPopup(st.comp, st.key, T, t, st.key, st.zone ?? st.el);
        const stageAt = madeFor(lastS, st.key);
        const w = await get(`workflows(${WF})?$select=xaml,clientdata`);
        ok('the stage label published from its chip', r.ok && w.xaml.includes(t) && w.clientdata.includes(t), { r });
        // Its steps show in the stage's flyout: Dynamics' own click on the stage's button opens it.
        ((st.zone ?? st.el).querySelector('button') || st.zone || st.el).click();
        const sp = await anchorOf((a) => a.kind === 'step');
        ok('a step in the stage flyout is marked', sp, anchors().map(show).slice(0, 30));
        if (sp) {
          const was = store.get(sp.key).labels[T] || '';
          const t2 = tgt(was, 'Pas page E2E');
          const lastP = app.saver.history()[0]?.id;
          const r2 = await viaPopup(sp.comp, sp.key, T, t2, sp.key, sp.zone ?? sp.el);
          const stepAt = madeFor(lastP, sp.key);
          const w2 = await get(`workflows(${WF})?$select=xaml,clientdata`);
          ok('the step label published from its field', r2.ok && w2.xaml.includes(t2) && w2.clientdata.includes(t2) && w2.xaml.includes(t), { r2 });
          // Recent publishes' Undo writes the step's earlier French name back (the page loaded the one Dynamics keeps); a
          // stored one is replaced, never removed, so with none it would be the step's English name (model.ts standIn).
          const want = was || store.get(sp.key).labels[B];
          const un = await undoPublish(stepAt);
          const now = stepLabels(await get(`workflows(${WF})?$select=xaml,clientdata`), store.get(sp.key).ref.labelId, T);
          ok('Recent publishes › Undo of a process step: its earlier French name written back', un.ok && now.xaml.length > 0 && now.clientdata.length > 0 && [...now.xaml, ...now.clientdata].every((x) => x === want), { un, now, want });
        }
        // The stage's publish too (listed below the step's and the undo's): what Dynamics shows is then as before.
        const wantStage = wasStage || store.get(st.key).labels[B];
        const us = await undoPublish(stageAt);
        const nowStage = stepLabels(await get(`workflows(${WF})?$select=xaml,clientdata`), store.get(st.key).ref.labelId, T);
        ok('Recent publishes › Undo of a process stage: its earlier French name written back', us.ok && nowStage.xaml.length > 0 && nowStage.clientdata.length > 0 && [...nowStage.xaml, ...nowStage.clientdata].every((x) => x === wantStage), { us, nowStage, wantStage });
      } finally {
        await fetch(api + `workflows(${WF})`, { method: 'PATCH', headers: { Accept: 'application/json', 'Content-Type': 'application/json' }, body: JSON.stringify({ xaml: orig0.xaml, clientdata: orig0.clientdata }) });
        const back = await get(`workflows(${WF})?$select=xaml,clientdata`);
        ok('process definition restored byte for byte', back.xaml === orig0.xaml && back.clientdata === orig0.clientdata, 'diff');
        if (back.xaml === orig0.xaml) localStorage.removeItem('dxt:test:bpfOriginal');
      }
    });
  }

  app.dev.noRefresh = false;
  ok('nothing left pending', store.pendingCount() === 0 && !store.busy && !dialog(), { pending: store.pendingCount(), busy: store.busy, dialog: !!dialog() });
  window.__dxtPage.running = false;
})();
