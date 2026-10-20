# Dynamics Translator — architecture

A bookmarklet for Microsoft Edge (a `javascript:` URL under 2,000,000 characters — Edge's 2 MiB URL cap, measured) that translates Dynamics 365 / Dataverse
model-driven apps. Two ways to work, one engine:

* **This page** (inspector): every translatable label on the page the user is looking at is highlighted;
  click one to edit it in every language right there. Covers form fields (and the sub-fields of address and name
  columns), tabs, sections, header fields, sub-grids, quick views (their title and the fields of their form), the
  timeline's title, related-menu items (and the tab of the view one opened), choice values (each value of a
  multi-select), Yes/No labels, the business process flow (stages + steps, and the open stage flyout's title),
  command bar buttons (modern and classic; the table's name in Microsoft's New, Add Existing and Export), the app
  name, the sitemap (areas, groups, subareas, and the table plural name a subarea shows), list, sub-grid and
  associated view column headers (also of linked tables, and of the classic read-only grid), view names (a list's,
  an associated view's, a sub-grid's view selector), the form name, the table name, the items of the three lists the
  page is switched with (the app's areas, the record's forms, a list's views), and forms and lists opened in side
  panes. Text that can't be translated here (Microsoft's own, a label from a managed solution, another read-only
  label) is marked grey, and its popup says why. A click opens a label only on its text (§5.4).
* **Workbench**: the Easy Translator replacement. Pick a solution or tables and component types, get
  a fast spreadsheet grid of every label in every language, edit inline, bulk-fill, import/export
  Excel workbooks that are compatible with XrmToolBox Easy Translator.

Both write through the same safe save pipeline (review → save → verify → publish → undo).

---

## 1. Principles (non-negotiable)

1. **Never clobber other languages.** Only the languages the user changed are changed. `UpdateOptionValue`
   sends only those, with `MergeLabels: true`; `SetLocLabels` sends only the edited languages (it keeps the
   others, finding 21; `''` removes one, finding 33). Metadata PUTs carry `MSCRM.MergeLabels: true` but must send
   every language of the edited label as read right before (finding 2), and `UpdateStateValue` sends the complete
   label too (§4.1). Metadata takes no If-Match, so such a write sends back the old text of a language someone else
   saved between that read and the write: the reads inside the write's own `$batch` show it, and it is written back
   or said (principle 2, §4.1).
2. **Never clobber concurrent edits.** Every writer re-reads the server value right before writing
   and reports a **conflict** (not an overwrite) when it differs from what the user started from. Form and
   sitemap XML are written with `If-Match: <published etag>`, which only catches a publish in between
   (LIVE-FINDINGS 22, 47), and a 412 triggers a fresh read-modify-write once, then a conflict. Nothing on the
   server guards the moment between that read and the write: not the *unpublished* form or sitemap, not a process
   definition (its PATCH refuses If-Match, finding 29), and `SetLocLabels`, metadata label writes and the classic
   ribbon's ImportTranslation take no If-Match at all. So each is made as safe as it can be without one. Every label
   write but the classic ribbon's, and the process update after a process name is published (§4.7 step 4), goes in one
   `$batch` right behind a read of exactly what it writes. Dataverse runs
   the parts in order, so that read shows what the write replaced; sent without continue-on-error (Http.batch `stop`;
   not a form's, which goes through LangSession, §4.3), the batch stops before the write when that read fails, and a
   form write whose read failed is never reported saved. What someone else saved after the writer's read is written
   back: a form, sitemap or process definition is rebuilt on their document with only this save's labels on it
   (`providers/repair.ts`, §4); a record label gets their text back, every other language untouched (§4.2); a table,
   column or global choice from its solution layers, which never lag (§4.1); a process's base-language name the process
   update replaced, in the same language window (§4.7 step 4); a state's default status reason, which its label write
   must send, with the labels just sent, unless the read is behind this page's own write (§4.1). The classic ribbon is
   read again right after its import and put back by a second import once this save is published, itself watched the
   same way (§4.6); a label such an import wrote is never reported plainly saved. A label whose own language they
   saved keeps their text, and the change becomes a conflict. Where only a metadata read saw a label (options, status
   values, relationships, no rights to the layers) it is said, never written back, as that read can lag (finding 66).
   A change whose outcome can't be confirmed is never reported saved. What no read can show: a save landing between
   that read and the write itself, inside the batch (for a process also one Dataverse applies during its ~9 s PATCH).
   A write Dataverse turned away unrun is never resent as built (Http's `once`): it is done again from a new read.
   **Accepted limits** (documented, not fixed: Dataverse gives no atomic way to close them). A save by another maker
   that lands between the translator's last check and its write can still be overwritten, by every writer, process
   definitions included: the check is a read, and nothing on the server ties the write to what it read (above). A
   status label's write sends the default status reason read just before it (`UpdateStateValue` with a label resets
   the default unless it is sent, finding 36), so a default someone else sets in that moment is put back to the one
   read (§4.1 `keepDefault` covers one set before the read in the write's batch). Avoid customizing the same component
   in two places at once while translating.
3. **Never discard anyone's unpublished work.** XML that a write starts from is read unpublished
   (`RetrieveUnpublished`; a sitemap's with `RetrieveUnpublishedMultiple`), never with the published GET. A published
   definition is read only for labels to show, and never written back: a form's in the quick read of a form without
   unpublished changes and for a form that `RetrieveUnpublished` doesn't find (§4.3), a sitemap's when a load can't
   read its unpublished one (§4.4). Publishing is targeted (`PublishXml`), never `PublishAllXml`.
4. **Verify every write.** Read back after writing (metadata with `Consistency: Strong`). A label that
   Dataverse silently dropped is reported as an error, never shown as saved.
5. **XML edits are surgical.** DOM edit of label nodes only, then `assertOnlyChanged` proves that the
   document is identical outside exactly the edited label/language entries, else abort.
6. **No HTML injection.** All dynamic text goes through `h()` / `textContent` / attribute setters.
   `innerHTML` only for static markup with no data (or data passed through `esc()`).
7. **No external network.** Only same-origin Dataverse calls. No telemetry, no CDN, no fonts.
8. **Fast.** Bulk reads, `$batch` for many small GETs, parallel reads (8), serialized metadata writes
   (the org allows one customization operation at a time — verified: concurrent writes get
   `0x80071151 Cannot start another [EntityCustomization]`, HTTP 429), one combined publish.
9. **Undo.** Every save records before/after for each cell; "Undo save" writes the old values back
   through the same pipeline (with the same conflict checks). A translation the save added that Dataverse can't
   remove gets its stand-in instead (§4, "Clearing a translation"); a metadata description stored empty before the
   save is saved empty again.
10. **Self-contained.** No libraries, no external network. Target browser is Microsoft Edge, which runs
    `javascript:` favorites up to its 2 MiB URL cap (measured: 2,040,060 characters run, 2,100,060 do not), so
    size is not a design constraint below ~2,000,000 characters (~310 KB of minified JS packs to ~130 KB).
    Never trade correctness, safety or clear UX text for bytes.
11. **Never an unmanaged layer.** A label whose component comes from a managed solution (its own `ismanaged` /
    `IsManaged`) is read-only, whatever its managed properties (`IsCustomizable`, `IsRenameable`) allow: any change
    here would be an unmanaged customization layered on top of the solution's component. Such texts are translated
    where their solution is developed. Every loader sets `ref.managed` from the component itself (a form's or
    dashboard's for its tabs, sections, cells, header and navigation items, a sitemap's for its items, a process's for
    its stages and steps), and the reason is one constant everywhere, `MANAGED` in core/model.ts: "From a managed
    solution: a translation here would add an unmanaged layer on top of it. Translate it where its solution is
    developed." On a managed component only Microsoft's own texts keep their own reason: a system name Microsoft locks
    for good (§4.1) and Microsoft's own sitemap labels (§4.4), read-only either way. Per component: an unmanaged form
    on a managed table is editable, and so is an unmanaged custom column on it; a managed column on an unmanaged form
    keeps its column name and tooltip read-only while the form's own cell label stays editable. The guard is layered,
    so a slot that slipped through as editable is still never written: `Store.add` makes such a slot read-only
    (`isManaged`) and `Store.set` stages nothing on it, an import skips its rows ("Read-only: <reason>"), the saver
    refuses it and never sends it to a writer, the publish set leaves it out, each writer refuses it, and refuses any
    change whose component the read right before its write shows managed (§4.1–4.6), and Undo skips it with the reason
    (§5.3).

---

## 2. Files and ownership

```
src/
  main.ts                 bootstrap: singleton, environment checks, recover language, create App
  env.d.ts
  core/
    http.ts      [done]   Http client (gates, retries, fn() aliases)        — shared
    context.ts   [done]   Ctx (ctx.xrm read live: liveXrm), findXrm, pageInfo, recordDirty — shared
    model.ts     [done]   Slot, Kind, Prop, Change, PublishSet, names; canClear, the stand-in rule (standIn) and the
                          saved-empty rule of descriptions (keepsEmpty, savesEmpty, storedEmpty) — shared
    column.ts             columnOf: the column a form cell shows (inspector/column.ts re-exports it)
    store.ts     [done]   Store (edits, undo/redo, status, commit)          — shared
    labels.ts    [done]   Label helpers                                     — shared
    xml.ts       [done]   parse/serialize/canon/assertOnlyChanged/upsert    — shared
    zip.ts       [done]   openZip (unpacked on read, size + CRC-32 checked, budget)/unzip/zip/crc32/base64 — shared
    langsession.ts [done] UI language switching (forms)                     — shared
    uilang.ts             the user's UI language set for good ("Show Dynamics in")
    lcid.ts      [done]   LCID names
    search.ts             fold/terms/hit: the one search of every search box (All labels, Filter rows, Filter
                          entities), case, accents, apostrophes and ligatures aside
    batch.ts              $batch GET helper                                  — records agent
    saver.ts              save orchestration                                 — saver agent
    publish.ts            PublishXml + lock retry, the process update after a name (rebuildProcess) — saver agent
    history.ts            undo journal (localStorage, per org and user, 90 days, under a Web Lock) — saver agent
  providers/
    types.ts     [done]   Writer / Loader / Scope contracts
    metadata.ts           tables, columns, choices, global choices, Yes/No, status, relationships
    records.ts            localizable columns: views, charts, form & dashboard names, apps, BPF names,
                          modern commands, environment variables, custom APIs
    formxml.ts            form + dashboard tab/section/field/header/footer/nav labels
    sitemap.ts            sitemap areas/groups/subareas (+ app → sitemap lookup)
    bpf.ts                BPF stage + step labels (workflow xaml + clientdata)
    repair.ts             someone else's save during a form / sitemap / process write: probe, put back (§4)
    ribbon.ts             classic ribbon LocLabels (read: ribbondiffs; write: translation import)
    index.ts              registry: kind → writer; loadScope() fan-out       — integration (lead)
  io/
    xlsx.ts               .xlsx read/write (sharedStrings + inline strings)  — io agent
    workbook.ts           Easy Translator compatible export/import mapping   — io agent
    csv.ts                CSV export/import                                  — io agent
  ui/
    types.ts     [done]   AppApi, View, Prefs
    dom.ts       [done]   h(), put(), icon(), esc(), rafThrottle, debounce, plural
    styles.css            design tokens + shell + widgets                    — ui agent
    app.ts                App controller implementing AppApi                 — ui agent
    shell.ts              window chrome: drag, resize, dock, max, minimize   — ui agent
    widgets.ts            toast, modal, confirm, menu, popover, tooltip, pills — ui agent
    editor.ts             component editor card (all languages)              — ui agent
    review.ts             Publish dialog (review, save, publish, check), Recent publishes — ui agent
    refresh.ts            cache purge + fresh reload (after publishing, "Refresh page", a language
                          switch), check after the reload
    callout.ts, bar.ts    translation mode popup and bar
    undo.ts               Ctrl+Z / Ctrl+Y: each text box's own history (never the browser's page-wide undo), else
                          the staged edits, in the translator and on the page
  workbench/
    workbench.ts          the Workbench view                                 — workbench agent
    scope.ts              solution / table / type picker
    grid.ts               virtualized editable grid
    tools.ts              bulk tools (copy base, find & replace, trim)
    regex.ts              find & replace's regular expressions: a Web Worker stopped after 1.5 s (searcher), and
                          where no worker runs, what may search on the page (heavyRegex)
    workbench.css
  inspector/
    mode.ts               translation mode controller (createPageMode)
    describe.ts           popup content per component
    status.ts             looks, list groups, page title
    pagelist.ts           "All labels on this page" sheet
    reveal.ts             finds a label for the sheet: what to open so the page renders it (form tab, header
                          flyout, process stage), form API visibility; the page and place a change was made at,
                          and going back there
    scan.ts               DOM → anchors (element ↔ comp key), per form: the page's, a side pane's, a quick view's
    parts.ts              several labels in one text (multi-select values, linked headers), grid queries, DOM form ids
    lists.ts              the lists the page is switched with (areas, forms, views): their buttons and items, what
                          Change area / form / view and an item's Open do
    overlay.ts            label marks (text-hugging boxes), click interception on a label's text
    preview.ts            the user's own-language staged text shown in place (text swap, restorable)
    pageload.ts           decides what to load for the current page
    overlay.css, pagelist.css
```

Agents only create/edit the files they own. Shared `[done]` files are read-only for agents; if one
needs a change, describe it in the final report instead.

---

## 3. Keys (canonical — every module must use exactly these)

`slot.key = ${comp}|${prop}`. `slot.group` decides which changes are written together.

| Kind | comp | props | group |
|---|---|---|---|
| entity | `entity\|<entity>` | DisplayName, DisplayCollectionName, Description | = comp |
| attribute | `attribute\|<entity>.<attr>` | DisplayName, Description | = comp |
| option (Picklist / MultiSelect local) | `option\|<entity>.<attr>\|<value>` | Label, Description | = comp |
| status (statuscode) | `status\|<entity>.statuscode\|<value>` | Label, Description | = comp |
| state (statecode) | `state\|<entity>.statecode\|<value>` | Label, Description | = comp |
| boolean (local) | `boolean\|<entity>.<attr>\|<0\|1>` | Label, Description | = comp |
| globaloptionset | `globaloptionset\|<name>` | DisplayName, Description | = comp |
| globaloption | `globaloption\|<name>\|<value>` (also used for global Yes/No sets, values 0/1) | Label, Description | = comp |
| relationship 1:N | `relationship\|<SchemaName>` | Label | `relationship\|<SchemaName>` |
| relationship N:N | `relationship\|<SchemaName>\|1` and `\|2` (Entity1/Entity2 menu) | Label | `relationship\|<SchemaName>` |
| view | `view\|<savedqueryid>` | Name, Description | = comp |
| chart | `chart\|<savedqueryvisualizationid>` | Name, Description | = comp |
| form | `form\|<formid>` | Name, Description | = comp |
| dashboard | `dashboard\|<formid>` | Name, Description | = comp |
| app | `app\|<appmoduleid>` | Name, Description | = comp |
| bpf | `bpf\|<workflowid>` | Name, Description | = comp |
| command (appaction) | `command\|<appactionid>` | Label (buttonlabeltext), ToolTipTitle, ToolTipDescription, Alt (buttonaccessibilitytext), Title (grouptitle) | = comp |
| envvar | `envvar\|<environmentvariabledefinitionid>` | DisplayName, Description, Hint | = comp |
| customapi | `customapi\|<customapiid>` | DisplayName, Description | = comp |
| tab / section / field | `tab\|<formid>\|<tabid>` · `section\|<formid>\|<sectionid>` · `field\|<formid>\|<cellid>` | Label | `formxml\|<formid>` |
| navitem | `navitem\|<formid>\|<NavBarItem Id>` | Label | `formxml\|<formid>` |
| dtab / dsection / dfield | same as tab/section/field with the dashboard formid | Label | `formxml\|<formid>` |
| area / group / subarea | `area\|<sitemapid>\|<Id>` · `group\|…` · `subarea\|…` | Title, Description | `sitemap\|<sitemapid>` |
| stage / step | `stage\|<workflowid>\|<stageId>` · `step\|<workflowid>\|<stepStepId>` | Label | `bpfxaml\|<workflowid>` |
| ribbon | `ribbon\|<entity or _app>\|<LocLabel Id>` | Label | `ribbon\|<entity or _app>` |

All GUIDs lower-case without braces (`guid()` / `normId()`). Entity and attribute names are logical names.

`slot.ref` shapes (other modules — importer, inspector — rely on these):

| Kind | ref |
|---|---|
| entity | `{ entity, metadataId, managed, custom /* IsCustomEntity: a locked name's reason names its solution, not Microsoft (§4.1) */ }` |
| attribute | `{ entity, attribute, metadataId, odataType, managed, custom /* IsCustomAttribute */ }` (odataType e.g. `Microsoft.Dynamics.CRM.StringAttributeMetadata`) |
| option / status / state / boolean | `{ entity, attribute, value, attributeMetadataId, optionMetadataId, managed /* the column's or its own choice's IsManaged */ }` |
| globaloptionset | `{ name, metadataId, boolean, managed }` |
| globaloption | `{ name, value, optionMetadataId, usedBy: string[] /* 'entity.attr' */, managed /* its global choice's */ }` |
| relationship | `{ schemaName, metadataId, type: 'OneToMany' \| 'ManyToMany', side?: 1 \| 2, entity1?, entity2?, referenced?, referencing?, managed }` |
| view, chart, form, dashboard, app, bpf, command, envvar, customapi | `{ id, table /* record table, e.g. 'savedquery' */, entitySet, column /* e.g. 'name' */, entity /* related table or '' */, type? /* querytype / form type / location */, managed /* the record's ismanaged */ }` |
| tab, section, field, navitem, dtab, dsection, dfield | `{ formId, elId, formType, area: 'body' \| 'header' \| 'footer' \| 'nav', tabName?, sectionName?, controlId?, datafield?, classid?, quickForms? /* a quick view control's form ids (lower case) */, managed /* the form's or dashboard's ismanaged */, partial? /* not known in every language: the languages in labels are the ones read */, unread? /* per language not read: why its read failed */, unreadable? /* why no read can bring the others (PUB_ONLY, §4.3) */ }` |
| area, group, subarea | `{ sitemapId, id, areaId?, groupId?, entity? /* SubArea Entity attr */, plural? /* it shows that table's plural name (§4.4) */, resource? /* its ResourceId's last segment */, unnamed? /* no Titles */, placeholder? /* the app designer's placeholder: nameable here (§4.4) */, managed /* the sitemap's ismanaged */ }` |
| stage, step | `{ workflowId, labelId, attribute? /* step's field */, stageId?, primary /* the process's table */, managed, stored? /* languages filled from the names Dynamics keeps (§4.5) */, unread? /* languages of those not read */ }` |
| ribbon | `{ entity /* '_app' for the application ribbon */, locLabelId, managed }` |

Slot fields: `title` = component name in the user's language (e.g. "Account Name"); `path` = breadcrumb (e.g.
`['Account', 'Information (Main form)', 'Summary', 'Account Information']`); `sub` = logical/schema name or id hint;
`order` = natural order (document order, option order). `readOnly` reasons are plain English the user can act on (the
popup, All labels, the Workbench and the Publish dialog show them as they are): `MANAGED` for a component of any kind
from a managed solution (principle 11); for metadata the other §4.1 ones; for sitemaps "Microsoft's own text, already
shown in every installed language. To use your own name, set a title in the app designer." (§4.4); for an unmanaged
form whose “Allow customizations” is off, "This form is marked as not customizable (its “Allow customizations” managed
property is off), so its labels can't be changed here." ("This dashboard …" for a dashboard; formxml.ts
`loadFormXml`). Managed properties bind only managed layers, so an unmanaged record (view, chart, app, command…),
process or classic button label stays editable in its own environment. `baseRequired` true for metadata labels (base
language can't be blank). `max` from metadata (`MaxLength`) or known limits (form name 100, description 2000,
appaction label 256, tooltip description 500, CrmTranslations 500).

---

## 4. Providers — verified facts and required behavior

General: see `providers/types.ts`. Loaders return `Slot[]`; writers implement `Writer`. Writers also implement
`read(ctx, changes, {signal, lang})`, the read their save makes before writing and nothing else (the Undo question and
the saver's check of the texts a stand-in is made of use it too, `SaverApi.current`), returning each change's
text (or an Error) by change id (`ServerTexts`): metadata the same strong GET (shared `Source`), read again while it is
behind this page's own last write of the label (MINE, as flowOnce waits) and an Error if still behind, a deleted choice
option an Error; records RetrieveLocLabels; forms `loadFormXml` of the unpublished form, other languages' tab and section
labels through LangSession; sitemaps RetrieveUnpublishedMultiple; processes the definition, with a kept name where it has
none; classic ribbon the ribbondiffs, unpublished ones included. A label gone from its form, sitemap or process is an
Error, as its save says. Read with `$select`; follow `@odata.nextLink` (`Http.all`, below); use `ctx.http`. Labels
come back in **all** provisioned languages in `LocalizedLabels` for metadata (verified). Use `Consistency: Strong` on
verification reads. A writer's `save` adds to `SaveOptions.ran` the change id of each change it sent a write for that
Dataverse did not refuse: answered (2xx, whatever the read after it shows) or with its answer lost (`mayHaveRun`),
before throwing too; never one not sent (a read before it failed, a check, Stop), turned away unrun or refused (4xx).
The saver journals a change a Try again finds already as asked only when an earlier attempt's write is in that set
(§4.7 step 5, "Only what this run wrote").

**A list that can't be read is no list** (core/http.ts `Http.all`). A successful answer is a collection only when its
`value` is an array; its `@odata.nextLink`, if any, is followed only to an address of the environment's own site that
was not followed before. Anything else throws ("Dataverse sent an answer that could not be read (not a list of rows).")
instead of counting as no rows: read as empty, the publish's check for pending work (§4.7) would say there is none.

**Clearing a translation** (verified live 2026-10-14; stand-ins 2026-10-20; descriptions saved empty 2026-10-22). A
change whose `after` is empty or only whitespace for a non-base language asks for no translation of its own: that
language is to show what it shows without one. `canClear(slot, lcid)` in `core/model.ts` says where Dataverse can
remove one:
* **Can remove** — records via `SetLocLabels` with `Label: ''` (deletes the label; finding 33); form
  navigation item titles (remove the `<Title LCID=…>` element; finding 38); sitemap titles/descriptions
  (remove the element). Verification expects the language to be absent.
* **Cannot remove** (Dataverse merges these per language: a write adds or changes a language, never
  deletes one) — metadata kinds (entity, attribute, relationship, option, globaloptionset, globaloption,
  boolean, state, status): `MergeLabels: false` with the language left out keeps it (even after publish),
  and `''` is stored and shown to that language's users as a **blank** label (findings 31, 32); an empty cell of
  a translation import removes nothing either (finding 67). Form and dashboard tab, section and **field** (cell)
  labels: a form update without the label, or with it empty, keeps it in any UI language (finding 37; dashboard cells
  assumed the same). **Classic ribbon** titles: an import keeps titles it doesn't carry or leaves empty (findings 39,
  69). BPF stage and step labels (model.ts `stays`, `canClear` given the language): once Dynamics has stored a stage or
  step translation, removing its `StepLabel` leaves it showing (LIVE-FINDINGS 83).
* **The stand-in** (model.ts `standIn`). Where Dataverse can't remove it, an emptied translation is written as its
  stand-in: the text that language shows where the label has no translation of its own, so the page looks as it
  would without one, which is what emptying it asks for. Earlier builds refused such a change, which left the old
  translation showing unless the user typed another text. A form or dashboard cell that shows a column
  (core/column.ts `columnOf`) gets the column's name in that language, else the column's base-language name (finding
  42: a cell without a label in the user's language shows its column's name in that language; a column without one
  falls back to its base-language name, finding 32). Everything else, a stage or step translation Dynamics keeps
  included, gets the label's own base-language text. Once written it is a translation like any other: a later change
  of the base text or of the column's name doesn't reach it. A metadata description has none: it is saved empty
  (next bullet). The rule, `core/model.ts` `standIn`:

  ```ts
  export function standIn(s: Slot, l: Lcid, base: Lcid, before: string, after: string, text: TextOf, untranslated?: boolean): StandIn | undefined {
    if (l === base || after.trim() || (before === '' && !untranslated) || canClear(s, l) || savesEmpty(s, l, base, untranslated)) return undefined;
    const got = (x: StandIn): StandIn => (bare(x.text) === bare(before) ? { ...x, same: true } : x);
    const k = columnKey(s);
    if (k) {
      const own = text(k, l);
      const b = text(k, base);
      if (own === undefined || b === undefined) return { text: '', from: 'column', why: "its column's names aren't loaded", unloaded: true };
      if (own.trim()) return got({ text: own, from: 'column' });
      return b.trim() ? got({ text: b, from: 'columnBase' }) : { text: '', from: 'columnBase', why: `its column has no ${lcidName(base)} name` };
    }
    const b = text(s.key, base);
    if (b === undefined) return { text: '', from: 'base', why: `its ${lcidName(base)} text isn't loaded`, unloaded: true };
    return b.trim() ? got({ text: b, from: 'base' }) : { text: '', from: 'base', why: `its ${lcidName(base)} text is empty` };
  }
  ```

  - `text` reads the texts as they will be on the server once the run is over (core/saver.ts `saveText`): the
    changes the run writes first (a base text or a column's name written in the same save; for an undo, the earlier
    texts it writes back), else the server's (as the Undo question read them, else as loaded). Never a pending edit
    the run doesn't write, nor one it holds back. Which changes are written depends on the checks, and the checks on
    the stand-ins (one without a stand-in is refused), so `measure()` works this out again until it holds: four rounds
    at most (a base text, then a column's name, then a form label made of it). A change whose server text moved since
    it was edited is not counted as written (its writer finds a conflict), unless it is forced or chosen with Undo
    anyway.
  - The saver applies it before its checks and the writers (`withStandIns`): the change's `after` becomes the
    stand-in, marked with `Change.standIn` (`from`, and the blank text `typed`), so no writer ever sees it blank (but
    a metadata description saved empty), and the results, the store and the journal carry the text written.
    `Store.commit` drops the staged blank edit once its stand-in is saved.
  - Before anything is written, the saver reads every text a stand-in is made of again (model.ts `standInSources`;
    saver.ts `sources()`, through the writers' `read()` as `current()` does). A stand-in made of a text that changed
    on the server since it was loaded would be the old one: it is never written, and its change fails with
    `sourceMoved` ("Its English text changed on the server since it was loaded (now “…”), so nothing was written: Try
    again to put the new text in its place."). `Store.seen` takes the new text, so Try again measures that. A text
    that can't be read fails the change too (`sourceUnread`).
  - A stand-in made of a text the same run writes (a field label emptied while its column's name changes in the same
    save; in an undo, a text it writes back) is that text only once it is saved (saver.ts `deps`, `ready()`). Written
    by the same job, it goes in the same write, one request that fails as a whole. Written by another job (`apart`: a
    form label made of its column's new name), the stand-in's job waits until the jobs before it have ended (`after`,
    `gate`, §4.7 step 2), and the stand-in is written only where that text was saved ('saved' or 'unchanged') and
    still gives the text it was measured as. Else it is held back, outcome 'skipped', with `sourceUnsaved` ("Its
    column's French name wasn't saved, so nothing was written here either: Try again to save both."), or with
    `sourceMoved` when the saved texts give another stand-in; the rest of its job is written. Undo goes through the
    same run.
  - A stand-in that is the text it replaces already (`same`; only spaces count as no text) writes nothing and adds
    nothing to the publish: outcome 'unchanged', but only while the server still holds that text. It is read first,
    with the texts the stand-ins are made of (`sources()`, its `now`), and compared as a writer compares
    (providers/types.ts `check`): another text there is a conflict ("Someone changed this label after you loaded
    it."), never a silent 'unchanged' over a newer text; one that can't be read goes to its writer, which reads it
    again. One made of a text the same run writes waits for that text's result (`decide`): 'unchanged' once it is
    saved, else held back as above. The popup says "Already the English text: Dataverse can't remove a translation
    here, so nothing changes."
  - A stand-in that isn't known (`why`: an empty base text, a column with no name in that language nor in the base
    language) is refused with `noStandIn` ("Dataverse can't remove this translation, and its English text is empty:
    type the text instead."). One unknown only because a text isn't loaded (`unloaded`: the column's names, or a
    tab's or section's base text read without a language switch) is held back, never refused for good
    (`Issue.unloaded`, outcome 'skipped'), and says what to load: "…, and its column's names aren't loaded: load its
    table's columns to put the column's name in its place, or type the text."
  - The writers keep their own guard: a blank change of a label `canClear` says can't be removed is refused with
    `CANT_CLEAR_TEXT` (a stage or step: `cantClearText`), outcome `error`, nothing written. The saver never sends one,
    but a metadata description's, which the metadata writer saves empty (`refusal()` lets it through).
  - Only spaces typed where there is no translation yet, on a label Dataverse can't remove, are still refused
    (`onlySpaces`): stored, they would show a blank label (finding 32); on a metadata description they are saved
    empty. An empty cell in an imported workbook or CSV changes nothing (io/workbook.ts).
  - One rule everywhere: the saver, the popup, the editor card, the page preview, the Publish dialog, the Undo question
    and the Workbench all use `standIn` (the popup, the editor card and the preview through `Store.standIn`, the
    Workbench with the store's texts, the dialogs through `SaverApi.prepare`, §4.7), so what they show is what the save
    writes (§5.2–§5.5).
  - Verified live on a development environment (2026-10-20): the live save suite (75/75) empties the French text of a
    view, a form, a command and an app navigation title (removed), of a choice value and a tab label (the English
    text written) and of a field label (the column's French name written), and undoes a publish that added a view's
    and a column's French name (the view's removed, the column's English name written in its place); by hand, a
    French tooltip added to a column and undone came back as the English tooltip in French.
* **Saved empty** (model.ts `keepsEmpty`, `savesEmpty`, `storedEmpty`; verified live 2026-10-22: a column's French
  tooltip emptied through the popup was stored as `""`, then put back). The description of a metadata component (a
  table's, a column's, which forms show as the field's tooltip, a choice option's, a global choice's and its options',
  a Yes/No option's, a status's or status reason's; a relationship has none) is the one place where the blank label of
  finding 32 is wanted. A non-base translation emptied there, or left only spaces, over a translation or where there
  was none, is saved empty, whatever the base text is: the metadata writer sends `''` for that language, every other
  language as it is (MergeLabels), Dataverse stores a blank label, and that language's users see no tooltip or
  description there. No stand-in, no refusal, no warning of its own (a global choice value keeps its
  "Global choice: …" warning); the decision of finding 32 ("never write `''` to metadata") now holds for names and
  labels only. Form and dashboard labels and classic button texts keep the stand-in; a record's description (a
  view's, chart's, process's) is still removed (`SetLocLabels` `''`).
  - Loading: `providers/metadata.ts` `stored(label, keepsEmpty(…))` keeps a stored `''` for descriptions only, and
    store.ts `setServer` does the same after a save, so a description **stored empty** (`storedEmpty`) is apart from a
    missing one. Stored empty counts as translated (`Store.emptyOnPurpose`: the marks, `isMissing`, All labels and
    its Not translated filter, the editor card, the Workbench's `missing` and its Rows filters, Copy base language);
    its placeholder is "No French tooltip" / "No French description" (`noneText`). A missing one (never translated)
    shows its users the base text: its placeholder says "Shows “…”" with it, and it stays amber.
  - What each view says, from model.ts: under the emptied input of the popup and the editor card, `savedEmptyText`
    ("Saved empty: French users see no tooltip."; "…no description." for anything but a column); in the Publish
    dialog, "&lt;old&gt; → (empty)" with that note (`emptyNote`; where the language had no label at all,
    `Change.beforeMissing`, the old side is `missingSide`: "Shows “&lt;base text&gt;”" or "(no translation)", never
    "(empty) → (empty)"); in Recent publishes, the same note (`savedEmptyText`), the old side "(no translation)" where
    the journal item's `before` is `''` without `empty`; in the Workbench a green cell with a muted "(empty)"
    (`.is-em`, `EMPTY`) and `savesEmptyText`'s tooltip ("Saved empty when you save: French users then see no tooltip.
    Was “…”."), a cell just saved "(empty)" with the check mark ("Saved and verified on the server."), a cell loaded
    stored empty "(empty)" with `savedEmptyText`. In the popup, spaces typed where there is no French text are trimmed
    when it closes (`tidy`): nothing is saved, and the line under the input says nothing.
  - Conflicts: an edit made where the language had no label at all carries `Change.beforeMissing` (the store's base
    is `null`, `Store.baseOf`), so a `''` someone else stored there since is a conflict for an edit with text
    (metadata.ts `compare`), shown as "(empty)", and `Store.moved` reports it; a blank one finds it already as asked.
    The write is read back: a description saved empty counts as written only once a read shows `''` stored in its
    language (`unset()`); no label there is an empty write Dataverse didn't keep, waited for and reported ("Dataverse
    did not keep this change: there is still no French text. Reload and try again."), never "saved".
  - Undo puts the earlier text back (saver.ts `undoChange`). The journal marks an item whose `before` was a
    description stored empty (`HistoryItem.empty`, from `wasEmpty` in `run()`), and Undo saves it empty again. An item
    whose `before` is `''` without `empty` (the publish gave the description its first text, or saved it empty where
    it had none; entries journaled before this rule count so) is undone to no translation: the change is marked
    `untranslated`, `savesEmpty` is false for it, and it gets its stand-in, the base text, as before the publish;
    where that text is empty too, `withStandIns` drops the mark and it is saved empty, which is what its users saw.
  - Excel and CSV: an empty cell is still no change on import; a stored-empty description exports as an empty cell.
* A stored label of only spaces counts as a translation: emptying it is a removal (`''` is sent, or the
  element removed) and is never reported as already up to date. A removal is 'unchanged' only when the
  server holds no label in that language at all (a description saved empty is not a removal: it is written where there
  is no label at all, and is 'unchanged' only where `''` is stored, `compare` with `empty`); an empty element left
  behind is removed.
* Loaders treat a stored `''` label as missing (it is not put into `slot.labels`), but in a metadata description,
  where it is kept as stored empty (above).
* Undo of a save that added a translation writes `''` back, so it removes it where possible; where Dataverse can't,
  it writes its stand-in, measured by the texts as the undo leaves them (the earlier texts it writes back, else the
  server's), so the page looks as it did before the publish. Only one without a stand-in is reported as "can't
  remove" (`refusedBlank`). Such refusals can never succeed, so the history entry is marked undone with `kept` = their
  number ("Undone · 2 kept" in Recent publishes) instead of offering Undo forever; "Try again" / "Retry failed" leave
  them out. One whose stand-in waits for a text to be loaded is skipped, saying what to load, and the publish stays
  undoable. A metadata description goes back as "Saved empty" above says: its stand-in where the publish gave it its
  first text, saved empty again where it was stored empty before.
* Undo never writes the labels of a publish that named a sitemap item without a base-language title (review.ts
  `namings`, from the journal alone): the base-language Title of an area, group or subarea journaled `''` → a name, and
  the titles that item got in the same publish where it had none. Its base title can't be blank again, so the app
  designer's placeholder ("New Group") can't come back. Recent publishes shows no Undo for a publish made only of them,
  and one line under its row: "Naming a group can't be undone: Dynamics needs a name once it has one. Rename it here if
  needed." In a publish that changed more, the Undo question lists them as "Stays: naming a group can't be undone":
  never read, not counted in Undo N changes, outside the undo's publish; Try again and Redo never write them. The
  publish is marked undone with them counted in `kept`, and the badge's tooltip names them apart from the translations
  Dataverse can't remove. A later rename of the item (a name before → another) is an ordinary, undoable change. The
  Publish dialog's per-row Undo (it only unstages) is unchanged.

**Write batches behind a read** (core/http.ts `Http.batch`). A write that must be checked against what it replaces
goes in one `$batch` right after a read of exactly that (§1 principle 2): records, metadata, sitemaps and processes
with `stop`, sent without `Prefer: odata.continue-on-error`, so a read that fails stops the batch before the write
(LIVE-FINDINGS 49); the parts after the failed one come back with status 0. A batch sent with `stop` that Dataverse
answers with an error status as a whole is still read part by part when its body is multipart (Http `parts`): the
parts before the failed one count as run, the failed one says why, the rest come back with status 0. It is never one
error for the whole batch. Not verified live: the shape of that answer (whether it holds the answers of the parts
before the failed one, as assumed, or only the failed part).

**A 503 alone is not "not run"** (core/http.ts `turnedAway`, `mayHaveRun`; `DvError.write` and `DvError.retryAfter`,
set by `Http.req`). A write answered 503 as a whole without `Retry-After` counts as possibly applied, never as turned
away: a 503 by itself says nothing of what ran, as a gateway can give up with it while Dataverse goes on (a
`POST solutions` hung about 2 minutes, then failed with 503, LIVE-FINDINGS 71). Its writer handles it as an answer
that was lost: never reported saved, not tried again by itself, its component published with the rest (§4.1), its
changes named in `SaveOptions.ran`, and the next run that finds its text already there journals it as that write (§4.7
step 5). A LangSession batch that switches the language is then in doubt (§4.3). A 503 with `Retry-After`, a read's
503 (it changed nothing) and a part's 503 inside a `$batch` (Dataverse's own answer for that part) still mean not run:

```ts
// turnedAway, in src/core/http.ts
export const turnedAway = (e: unknown): boolean =>
  e instanceof DvError &&
  (e.status === 429 || (e.status === 503 && (!e.write || e.retryAfter > 0)) || /cannot start another|0x80071151|customizationlock|another \[/i.test(`${e.message} ${e.code}`));
```

**Someone else's save in the middle of a whole-document write** (forms, sitemaps, process definitions;
`providers/repair.ts`). Nothing guards these documents between the writer's fresh read and its PATCH: form and sitemap
If-Match is checked against the published row (LIVE-FINDINGS 22, 47) and the process PATCH refuses If-Match (29). So
each write is one `$batch` `[read the whole document (the probe), PATCH, read it back]`. Dataverse runs a batch's parts
in order, so the probe shows exactly the document the PATCH replaced. The sitemap and process batches are sent without
continue-on-error (`stop`): a probe Dataverse answers with an error stops the batch before the PATCH, and the pass
starts again from a new read after 2, 4 and 8 s. Form batches go through LangSession, which must send continue-on-error
(its switch back must run), so their PATCH runs anyway. A probe that is the document the edit was built on: the
read-back is checked as before. Otherwise someone saved in between and the PATCH erased their change, and `settle()`
does the following:
  * An edited label/language pair they changed too (its entries differ between the read and the probe, and not to our
    text) keeps their text. The change becomes a conflict: "Someone else saved this label at the same moment. Theirs
    was put back: choose which one to keep." A label they removed is an error.
  * A new read must still show our own PATCH (the same document as its read-back). Anything else (someone saved after
    it, or a read that fails) gets nothing more written, and the result says so: "Saved, but someone else saved this
    form at the same moment, and this save may have replaced their change. Check the form, then Try again to publish
    it.", or "Someone else saved this form at the same moment, and this label is not in it now. Check the form, then
    save again."
  * The remaining pairs are built on the probe's document, only those pairs. The writer's safety check runs:
    assertOnlyChanged skipping exactly those entries; for processes, splice + sanity. The result is written in the same
    kind of batch with the new read's published etag.
  * The result is "saved" only when that write's probe is the new read and its read-back is the probe's document
    outside our pairs, with our pairs as asked. Another save landing just before the repair is put back too, on the
    newest document. Because its author may have built on our first PATCH, the result is then the "may have replaced
    their change" error. At most 3 repair writes. A repair turned away, stopped at its probe, or answered 412 is done
    again from a new read after 2, 4 and 8 s. Any other failure is reported. Repairs are not cancelled by Stop.
  * A probe older than the read it is compared with (a lower `versionnumber`: a read that lags, LIVE-FINDINGS 66) shows
    no save of anyone's, and written back it would undo the saves it lags behind. It counts as a probe that can't be
    read, in the first write and in a repair's own batch. The form, sitemap and process reads all carry `versionnumber`
    for this; when either is unknown, the contents decide as before.
  * A probe that can't be read never gives "saved": a part that failed, an answer without the document, one older than
    the read, or a form batch not proven to be in its language. When the read-back is exactly the read with the edit,
    the result is "Saved, but the form right before the save could not be read, so a save someone else made at the
    same moment can't be ruled out. Check the form, then Try again to publish it." Nothing is ever written back from it.
  * Comparisons are always between two reads. "Same document": equal text or equal `canon()`. "Alike outside our
    pairs": forms and sitemaps use `canon()` skipping exactly our entries (the element's label or Title in that
    language, plus a container holding nothing else). Processes use the xaml outside our StepLabel tags byte for byte,
    plus clientdata with sorted keys and without our entries.
  * What no read can show: a save landing between the probe and the PATCH inside the batch, and, for processes, one
    Dataverse applies while the ~9 s PATCH runs. No 3-way merge: when two other makers save one after the other around
    our write, one of their changes can be lost; that is the "may have replaced their change" error, never "saved".
  Not verified live: the whole-document probe inside these batches, a workflow PATCH inside a `$batch`, and whether a
  repair's read-back equals the probe's document after canon() (Dataverse may normalize what it stores; if not, a
  repaired race says "may have replaced their change" instead of "saved").

**A read answered after a newer text** (core/store.ts `tick`, `add(slots, since)`). Loads run while the user edits and
saves: the page loader's (pageload.ts `run`, `process`), the Workbench's Extract translations (app.ts `load`) and Read
again (workbench.ts), the editor card's read of a form's other languages (editor.ts). Each takes a tick of the store's
clock as it starts and hands it to `add` with what it read. The store keeps the tick of the load each slot came from
(`loadedAt`) and of each text a cell got since (`cellAt`: a save's result in `commit`, a text read again in `seen`, a
conflict settled in `resolve`). A language whose text is newer than the load keeps that text: a late answer to an
older read never puts its text back over a newer one, nor drops as saved an edit typed over the newer text because the
edit matches the older one. A language the held slot has not loaded (`notLoaded`) takes the read's text. Every other
language takes it as before, each pending edit still measured against its base.

### 4.1 metadata.ts (lane `metadata`)
* **List tables** (scope picker): `EntityDefinitions?$select=LogicalName,SchemaName,DisplayName,DisplayCollectionName,IsCustomizable,IsRenameable,IsManaged,IsCustomEntity,IsIntersect,IsActivity,ObjectTypeCode,MetadataId&$filter=IsIntersect eq false`. Solution tables: `solutioncomponents?$select=objectid&$filter=_solutionid_value eq <id> and componenttype eq 1` → match MetadataId.
* **Load a table**: entity labels (with `IsCustomizable,IsRenameable,IsManaged,IsCustomEntity`); attributes via `EntityDefinitions(LogicalName='x')/Attributes?$select=LogicalName,SchemaName,DisplayName,Description,AttributeType,AttributeTypeName,AttributeOf,IsCustomizable,IsRenameable,IsManaged,IsCustomAttribute,IsValidForForm,IsLogical,MetadataId` (skip `AttributeOf != null`, `IsLogical` system helpers, `_base`, `yomi*`, `versionnumber`-like non-form columns unless includeReadOnly); options with one GET per type cast (Picklist, MultiSelectPicklist, State, Status, Boolean) `…/Attributes/Microsoft.Dynamics.CRM.PicklistAttributeMetadata?$select=LogicalName&$expand=OptionSet($select=Options,IsGlobal,Name),GlobalOptionSet($select=Name)` (Boolean: `TrueOption,FalseOption`). Attributes bound to a **global** set produce `globaloption` slots for that set (once, deduped by set name), never local copies. Relationships: `OneToManyRelationships`/`ManyToOneRelationships`/`ManyToManyRelationships` expanded with `SchemaName,MetadataId,ReferencedEntity,ReferencingEntity,AssociatedMenuConfiguration,Entity1LogicalName,Entity2LogicalName,Entity1AssociatedMenuConfiguration,Entity2AssociatedMenuConfiguration,IsCustomizable,IsManaged`; dedupe by SchemaName; only `Behavior == 'UseLabel'` menus are editable (others shown read-only with "Uses the related table's plural name").
* **Read-only reasons** (`notCustomizable`, `notRenameable`; LIVE-FINDINGS 99), naming the component (table, column,
  choice column, relationship, global choice), in this order:
  - A system name Microsoft locks for good (`IsRenameable {Value: false, CanBeChanged: false}` on a component that is
    not custom and is customizable; Dataverse refuses a new name in every language): "Microsoft locks renaming of this
    table: its names can't be changed, in any language. Dynamics shows Microsoft's own text for them (the language
    pack)." (a column: "its name … for it"). Also where the component is managed: it is Microsoft's own text.
  - From a managed solution (`IsManaged`; a local choice's options: its column's or its own choice's): `MANAGED`
    (principle 11), whatever `IsCustomizable` and `IsRenameable` say. A managed property only binds managed layers, so
    it never makes such a label editable.
  - Not customizable (unmanaged only): "This table is marked as not customizable (its “Allow customizations” managed
    property is off), so its labels can't be changed here."
  - Renaming locked for good on a custom one (`IsCustomEntity` / `IsCustomAttribute`): "The solution this table comes
    from locks renaming it: its names can't be changed, in any language." Turned off only (`CanBeChanged: true`):
    "Renaming is turned off for this column (its “Display name can be modified” managed property). Turn it on in the
    column's managed properties to translate it here." Without `CanBeChanged`: "Renaming is turned off for this table,
    so its names can't be changed here."
  - Renaming applies to a table's Name and Plural name and a column's name; descriptions, choices and the rest follow
    the managed flag and IsCustomizable only. Looks (status.ts `readOnlyLook`): `MANAGED` is always `ro` (grey,
    "Read-only" in lists), even with text in every language; any other reason is grey `builtin` where every language
    has text, else `ro`. Microsoft's locked system names on its own (managed) tables stay built-in.
  - The writers refuse a slot loaded as managed before any server call (`refusal`). Their reads right before the write
    select `IsManaged` (a table's, a column's, a global choice's; a local choice's column read expands its
    `OptionSet`, a relationship and a global option are read whole), and their guard (`guard`) gives the same words
    from that read: managed when the read says so for the component or a local choice's own choice, or the slot was
    loaded as managed; the custom flag comes from the slot.
* **Global choices**: `GlobalOptionSetDefinitions` (no `$filter` support) → for each, options via `GlobalOptionSetDefinitions(Name='x')` (cast to OptionSetMetadata / BooleanOptionSetMetadata as needed). Limit to sets used by loaded tables or in the solution; with `Scope.allGlobals` (the Workbench's "Global OptionSets", outside solution mode) or with neither tables nor a solution, every global choice in the environment.
* **!! VERIFIED LIVE — label PUT trap:** a PUT whose Label contains only the changed language (e.g. only
  1036) makes Dataverse write that text into the **base / UI language too** ("Name" became "Nom"). So every
  metadata label PUT must send **all languages currently on the server for that label property** (fresh
  read), with only the changed languages replaced. With that, a **sparse** PUT (only `@odata.type`,
  `LogicalName` and the edited Label properties) is correct and leaves every other property untouched
  (verified by full before/after diff on an entity and an attribute). Use the sparse form — it cannot
  revert other makers' unpublished non-label changes the way a full-definition PUT could.
* **Write entity**: GET `EntityDefinitions(LogicalName='x')?$select=LogicalName,DisplayName,DisplayCollectionName,Description,IsRenameable,IsCustomizable,IsManaged` with `Consistency: Strong` → conflict check per change → body `{ "@odata.type":"Microsoft.Dynamics.CRM.EntityMetadata", LogicalName, <each edited prop>: mergeInto(current label, changes) }` (mergeInto keeps all current languages) → `PUT EntityDefinitions(LogicalName='x')` with `MSCRM.MergeLabels: true` → verify. ~6 s per PUT server-side: combine all props of one table into ONE PUT. Publish `<entity>`. Respect IsManaged (never a managed table) and IsRenameable for DisplayName/DisplayCollectionName (`guard`, above).
* **Write attribute**: GET `…/Attributes(LogicalName='y')?$select=LogicalName,DisplayName,Description,IsRenameable,IsCustomizable,IsManaged,AttributeType,AttributeTypeName` (+ `@odata.type` from the response, e.g. `#Microsoft.Dynamics.CRM.StringAttributeMetadata`) with Strong consistency → body `{ "@odata.type": "Microsoft.Dynamics.CRM.<Type>AttributeMetadata", LogicalName, DisplayName?/Description?: mergeInto(...) }`, plus `AttributeType` and `AttributeTypeName` as read when the type is `LookupAttributeMetadata` (an Owner or Customer column sent without them is refused as "a Lookup type", finding 59) → `PUT …/Attributes(LogicalName='y')` + MergeLabels → verify (re-GET; every language of the edited props must equal current-with-changes; anything else differing is reported as an error with details). Never include `OptionSet`/`GlobalOptionSet`. All `LocalizedLabel` objects carry `"@odata.type":"Microsoft.Dynamics.CRM.LocalizedLabel"`, the Label `"Microsoft.Dynamics.CRM.Label"`.
* **Write option / status / boolean**: `POST UpdateOptionValue {EntityLogicalName, AttributeLogicalName, Value, Label?, Description?, MergeLabels: true}` with **only changed languages** in Label/Description (verified: Label-only update keeps Description; MergeLabels keeps other languages). Both parameters are nullable and a property left out stays exactly as it is (finding 35), so a description-only edit sends no `Label` (never re-writing the base label). State: `POST UpdateStateValue {EntityLogicalName, AttributeLogicalName, Value, Label?, Description?, DefaultStatusCode, MergeLabels: true}` (finding 36) — each label sent carries the **complete current label** (every language, changes applied), which cannot fall into the base-language trap above, plus the current `DefaultStatusCode`; a description-only edit sends no `Label`. The read in the write's batch shows the default status reason the write replaced. When it differs from the one sent (someone else set it after the writer's read), theirs is put back (`keepDefault`). First comes a fresh strong read: a default that moved again since is newer and is left as it is. Then `UpdateStateValue` goes out with the labels just sent and their `DefaultStatusCode` (no `Description`), in a batch behind its own read, sent again from a new read (after 2 and 4 s) only while Dataverse turns it away or that read fails on the server's side. A label text the fresh read shows someone else saved since the write goes back as they saved it, never the text from before. Such a text is one no read behind the write could show: not as sent, not as read before the write, not as in the write's batch, and not a text this page's own writes replaced. A text that only the put-back's own batch read shows is said ("…; putting it back also put back “Active” over someone else's English text “Live”"). It is then read back (again after 1 and 2 s while it still shows ours). Options have no solution layers, so a batch read behind this page's own write (`lags()`) is said, never written back. Every outcome is a note on the write's changes, never plainly saved: "Saved, but someone else set this status's default status reason to “Waiting” (100000000) at the same moment, and this save set it back to “Open” (1); theirs is back. Check it." (or: it now shows a newer one, so it was left as it is / putting it back replaced a third one / failed / could not be confirmed). The names come from the table's statuscode options in the user's language; the value alone when they can't be read. Not covered: a batch read that lags behind someone else's recent change of the default (not this page's) shows an older one, which is then put back over the newer one; the message names both, to check. The post-write check also compares the state's default status reason before and after the write ("Saved, but this status's default status reason changed too (value 1 before this save, 100000001 now). Check it."), excused when the read in the batch already showed it. Should an org's action ever reject `Description` ("not a valid parameter"), nothing was written: the label edits are re-sent alone and each description edit gets a clear error. Global option / global Yes/No: `UpdateOptionValue {OptionSetName, Value, …}` → publish `<optionset>`. Global set DisplayName/Description: sparse PUT `GlobalOptionSetDefinitions(<MetadataId>)` `{@odata.type: OptionSetMetadata, Name, IsGlobal: true, <edited labels with all current languages>}` + MergeLabels (same shape as the SDK's update-global-option-set sample; never touches the options).
* **Post-write check** (every metadata writer): label properties that were not edited (the other entity/attribute/global-set labels, an option's label after a description-only edit and vice versa, the relationship's cascade rules and other menu fields, the other N:N side) must read back unchanged; otherwise the change is reported as an error with details.
* **Someone else's save between the read and the write**: every write goes in one `$batch`
  `[GET <component> (Strong), GET msdyn_componentlayers (tables, columns, global choices), PUT/POST]`, sent `once` and
  without continue-on-error (`request()`, §4 "Write batches behind a read").
  - A read that fails stops the batch before the write. 429, 503 and 5xx are tried again from a new read; 4xx: "Could
    not read the current labels right before saving, so nothing was saved".
  - Layers the user can't read (400/403/404) are left out; the batch is sent again at once without them, and left out of
    later batches (`NO_DB`). A layers read that fails otherwise (429, 5xx) stopped the batch before the write (nothing
    written). The batch is sent again with the layers after 1 and 2 s (Stop during that wait writes nothing: skipped),
    so someone else's text can still be written back from the database. Still failing, the layers are left out of that
    batch only, whose race is then said, not written back (item 2 below); the next write asks for them again.
  - race() compares those reads, which show the component as the write found it, with flowOnce's read:
    1. Layers hold the label: a language the write sent back as read that held another text is written back (`putBack`).
       A second PUT is built from the layers read again just before it (every language as the database holds it,
       finding 2), in a batch behind its own reads. What that batch shows changed since is written back the same way (at
       most three rounds), and MINE learns it as this page's write. A language the save edited (or found already as
       asked, or in conflict) that held someone else's text gets theirs back, and the change is a `conflict` (server =
       theirs). The same text from both changes nothing. A put-back write whose answer was lost takes the reads of its
       batch with it: if the layers read after it show theirs, the change is still a conflict (own language) or carries
       the note "…theirs is back, but Dataverse's answer to that was lost, so a save made at that moment can't be ruled
       out" (`blind`), never plainly saved.
    2. No layers: the metadata read is the only witness and can lag, so what it shows is said ("Dataverse showed “X”
       here right before this save: someone else may have saved it…"), never written back. A text there from before one
       of this page's own writes that the read is not past (`stale`) says nothing, as the read may lag behind that write.
       Any other difference is said, also in a read that looks behind such a write: someone may have put that text back.
       A relationship whose other side or settings moved is said. With no witness that can't lag, a text the read shows
       is never restored: written back from a lagging read, it would put back a text older than the one the write found.
       So the message names the language, their text and the text this save put back, to check.
    3. A read that could not be read: no change of that label is called saved.
  - What the read before the write showed that the write replaced is kept in MINE as from before it (`replacedBy`; this
    page's own recent text excepted).
  - verify() does not call someone else's earlier save "Dataverse also changed …" (`Pre`).
  - Notes are added when the save's answer is final (`NOTE`), so a change still waiting to be confirmed keeps waiting.
  - Not measured live: the batched write forms (PUT with `MSCRM.MergeLabels` as a part header, UpdateOptionValue,
    UpdateStateValue, a relationship PUT), msdyn_componentlayers inside a batch, and UpdateStateValue putting a default
    status reason back.
* **Write relationship**: GET `RelationshipDefinitions(<MetadataId>)/Microsoft.Dynamics.CRM.OneToManyRelationshipMetadata` (or ManyToMany) → merge into `AssociatedMenuConfiguration.Label` (or Entity1/2…) keeping every other menu field → PUT `RelationshipDefinitions(<MetadataId>)` with `@odata.type` + MergeLabels → publish both tables.
* Empty string under MergeLabels sets the label to "" (verified, it does NOT remove it), so an emptied metadata name
  or label is never sent blank: the saver writes its stand-in, the base-language text (see "Clearing a translation"
  above), and the writer refuses a blank one (`refusal()`); blanking a required base-language text is refused too. A
  description's emptied translation is the exception: that "" is what is wanted, and it is sent for that language
  alone (`savesEmpty`; "Saved empty" above). `compare()` takes it as a write where the language has no label at all
  (that language still shows the base text), and verify()/settle() call it written only once `''` reads back stored
  there (`unset()`).
* Verify: re-GET with `Consistency: Strong`, compare each changed lcid.
  **Reads that lag** (LIVE-FINDINGS 66): in the user's Edge the reads right after a write, and the read before the
  next write, showed text from before saves just made, for seconds, although the writes had been applied.
  - After a write: a text that reads exactly as before it is read again after 1, 2, 4 and 8 s (`settle`); each later
    read gets the full check (the edited language, the label's other languages, the post-write check below). Still
    old: written once more from a new read (a write can really be dropped, finding 62) and waited for the same way,
    then reported as accepted but not confirmed ("… Dataverse accepted the change but doesn't show it yet"). If that
    second round fails, what the first one confirmed stays saved.
  - Before a write: PUT-style writes (table, column, global choice, status value) send every language of the edited
    labels back as read, and a relationship PUT its whole definition; a read behind an earlier save would undo it
    and verify() could not tell. `MINE` records this page's own writes for 60 s per component: the written text and
    the texts it replaced, a replaced text marked when its write was only accepted (Stop, lost answer), kept in
    localStorage `dxt:mine:<org>` so it survives the reload after a publish and is shared by tabs. A read that shows
    one of those replaced texts in what this write sends back is behind (unless it also shows a later write of ours,
    which proves it is past): read again after 1, 2, 4 and 8 s, and if still behind nothing is written ("Not saved:
    Dataverse doesn't show your last change to this column yet … Try again in a minute"). A rewrite of the same text
    (round 2, Try again) is never blocked by its own marked text. Option actions send only the languages written and
    never wait. With storage blocked, the record lasts only for this instance, so a conflict, a text already as asked,
    or a sent-back language that differs from the loaded labels also gets the 1 + 2 s re-reads first.
  - A write is confirmed as a whole: if any change of it reads as before, every change of it is read again.
  - Table, column and global choice labels are also checked against the database: when the read after a write
    still shows the old text, providers/layers.ts reads `msdyn_componentlayers` (~0.4 s, LIVE-FINDINGS 81). The topmost
    layer showing the written text means saved at once (the other-language and post-write checks then run against
    the layers); the old text means the waits and second write as above, then "Dataverse answered OK but didn't apply
    this change"; no answer (403, 404, other shape) means exactly the path above. Every metadata write of the page is
    logged (providers/writelog.ts, last 30), and a failed row in the Publish dialog has "Copy details".
  - verify() and the post-write check don't count this page's own earlier save catching up (the read before showed
    a replaced text, the read after shows the written one) as "Dataverse also changed …"; the reverse still counts.
  - Metadata saves of one org run one at a time across tabs (Web Locks `dxt:meta:<org>`; without Web Locks, as before).
  - Cancel stops any of these waits at once; a write already accepted then says so ("Stopped before Dataverse
    confirmed it … Try again publishes it once Dataverse shows it").
  - `tools/dev/tests/metafuzz.ts` replays 407 seeded random sequences (lagging reads, dropped writes, lost answers,
    Stop, two tabs, someone else's edits) and the scripted cases of earlier reviews, and checks: no save silently undoes
    text a tab wrote or confirmed (I1), nothing is reported saved that the server doesn't hold (I2), no wait or refusal
    without a lagging read (never past 60 s, I3), fresh reads = 2 reads and 1 write (I4), and someone else's text saved
    between a save's read and its write that the write sent back is written back or said (I5, see "Someone else's save
    between the read and the write" above; the writes go through a batch whose read lags like any other, and only where
    no read could show it is it excused). Cases no client can decide from reads, listed in its header: an Undo Dataverse drops whose only check
    read lags behind the save it undoes (it reads exactly like a successful Undo, so it is reported saved), and reads
    that match an older state everywhere we wrote (a wait or refusal, at most 60 s).
* Writes in this lane are serialized by the saver; a write turned away unrun (`0x80071151` / `Cannot start another`, 429, a 503 with `Retry-After`, §4) is tried again after 2, 4, 8 and 16 s **from a new read and compare**, never resent as built from the earlier read (it carries every language as read then). Every label write is sent with Http's `once` option, so Http never resends it on 429 either. Records (SetLocLabels), form, sitemap and process PATCHes follow the same rule: from a new read after 2, 4 and 8 s (forms: the whole pass again; Stop during a wait writes nothing more); a records, metadata, sitemap or process batch stopped at a read before its write that failed (records: 429 and 503; metadata: 429, 503 and 5xx; sitemaps and processes: any error) counts as turned away (nothing was written); the classic ribbon's ImportTranslation after 5 s, then 10 s (§4.6).
* A change found already as asked ('unchanged') adds its component to the publish set, as does a write that failed but may have run (lost answer): it may be an earlier write whose answer was lost, never published (forms: only when the unpublished versionnumber differs from the published one; sitemaps: always, as whether `GET sitemaps(id)` is the published version is not verified, finding 13).

### 4.2 records.ts (lane `records`)
Localizable columns verified on this org (IsLocalizable scan of 959 tables): systemform name/description,
savedquery name/description, savedqueryvisualization name/description, appmodule name/description,
workflow name/description, appaction buttonlabeltext/buttontooltiptitle/buttontooltipdescription/
buttonaccessibilitytext/grouptitle, environmentvariabledefinition displayname/description/hint, customapi
(+params) displayname/description, sitemap sitemapname, webresource description, solution/publisher
friendlyname/description. processstage.stagename is **not** localizable (BPF stage names live in the xaml).
* Read: `RetrieveLocLabels(EntityMoniker=@e,AttributeName=@a,IncludeUnpublished=@u)?@e={"@odata.id":"<set>(<id>)"}&@a='name'&@u=true` → `{ Label: { LocalizedLabels } }` (verified). Use `core/batch.ts` to send up to 100 of these GETs per `$batch` request (CRLF line endings, `Content-Type: application/http`, `Content-Transfer-Encoding: binary`; parse each part's JSON). Fallback to individual GETs (parallel) if `$batch` fails.
* Write: `RetrieveLocLabels` fresh → conflict check of the edited languages → one `$batch` `[RetrieveLocLabels, POST SetLocLabels {EntityMoniker: {"@odata.type":"Microsoft.Dynamics.CRM.<entity>", "<pk>": id}, AttributeName, Labels: [the edited languages only; '' removes one]}, RetrieveLocLabels]`, sent `once` and without continue-on-error (`setLabels`; SetLocLabels verified on systemform). The first read shows the label exactly as the write found it, the last as it left it (`checked()`). Each edited language must read back as asked.
  - A written language someone else saved since the fresh read (to another text) gets their text or their removal back, and the change is a `conflict` with their text ("Someone else saved this text at the same moment. Theirs was put back: choose which one to keep."). If ours no longer shows (saved again after it), it is a conflict with what is there; nothing is written. The same text from both is plain saved.
  - A language not sent that the write dropped or filled with one of its texts is written back as it was. One that moved to another text is someone's in that instant: "Saved, but the German text changed too. Reload to check it." (never called saved).
  - The repair is a batch like any write. What its first read shows someone saved again since the write (a third maker) it replaced too, so that text is put back the same way (at most three rounds, only where the repair's text still shows). The newest text stays, and the change is a conflict with it ("Someone else saved this text at the same moment."). A repair that fails says whose text the save replaced ("Someone else saved “X” here at the same moment, and this save replaced it; putting theirs back failed (…)").
  - A first read that fails stops the batch: nothing written (429/503: again from a new read after 2, 4 and 8 s; else "Could not read the current text right before saving, so nothing was saved").
  - A first read that answered unreadably, with the write made: never plain saved ("Saved, but the text right before the save could not be read, so a save someone else made at the same moment can't be ruled out.").
  - What no read can show: a save landing between the first read and SetLocLabels inside the batch. Not measured live: the batch form itself, and a third language (finding 21 was on a two-language org; a dropped one is written back now).
* **From a managed solution** (records.ts `locked`: the record's own `ismanaged`, whatever its `iscustomizable`):
  every label of the record is read-only with `MANAGED`, and the Workbench's lists leave such records out unless
  read-only labels are asked for (`Scope.includeReadOnly`). An unmanaged record stays editable whatever its managed
  properties say (they bind only managed layers). The writer refuses a slot loaded as managed, then reads
  `<set>(<id>)?$select=ismanaged` (Strong) once, only when a write is due, right before the record's first write
  (`fromManaged`): managed, every change of the record fails with `MANAGED`; a read that fails writes nothing ("Could
  not read the current text: …").
* Lists: views `savedqueries?$select=savedqueryid,name,querytype,returnedtypecode,iscustomizable,ismanaged&$filter=returnedtypecode eq '<e>'` (all query types except internal ones: keep 0,1,2,4,64,8192? — show querytype names); charts `savedqueryvisualizations?$filter=primaryentitytypecode eq '<e>'`; forms `systemforms?$select=formid,name,type,objecttypecode,formactivationstate,iscustomizable,ismanaged&$filter=objecttypecode eq '<e>' and (type eq 2 or type eq 6 or type eq 7 or type eq 11 or type eq 12)`; dashboards `type eq 0 or type eq 10` (system); apps `appmodules`; BPFs `workflows?$filter=category eq 4 and type eq 1`; commands `appactions?$select=appactionid,name,uniquename,location,_contextentity_value,contextvalue,_appmoduleid_value,type,ismanaged,iscustomizable,hidden,isdisabled&$filter=…`; env vars `environmentvariabledefinitions`; custom APIs `customapis`.
* Publish: forms/views/charts → `<entity>` of their table; dashboards → `<dashboard>`; apps & commands → `<appmodule>` (if PublishXml rejects it, fall back to the related entities; never PublishAll); workflow name → none needed (verify); env vars/custom APIs → none.

### 4.3 formxml.ts (lane `xml`) — CRITICAL platform behavior (verified live)
* `GET systemforms(id)?$select=formxml` returns the **published** XML with **only the caller's UI
  language** labels. `systemforms(id)/Microsoft.Dynamics.CRM.RetrieveUnpublished()` returns the
  unpublished XML (+ `@odata.etag`) — tab/section labels are again per caller language.
* `PATCH systemforms(id) {formxml}` keeps **only the caller's UI language** for tab/section labels; labels
  in other languages are silently dropped (204 returned!). Switching `usersettings.uilanguageid` to L
  first makes L's labels stick, and does not affect other languages.
* **VERIFIED LIVE — two storage models inside one formxml:**
  - **tab and section labels** (also header/footer section names) live in a per-language store keyed by
    element id (ExportTranslation lists them as `displayname` rows). Reads return only the caller's
    language; inline labels in other languages are dropped on write.
  - **cell (field) labels** are stored **inline for every language**: `RetrieveUnpublished` returns all
    languages regardless of the caller's language, and writing a 1036 cell label while the UI is 1033
    persisted. → field labels need **no language switch** for reading or writing (fast path).
  - nav items (`<Titles><Title LCID Text>`) are not in ExportTranslation → assumed inline like cells;
    the writer must verify after write and report errors if a language was dropped.
* Therefore for **tabs and sections only**: read language L's labels from XML retrieved while the UI
  language is L, and write language L's labels while the UI language is L. Cells and nav items: read all
  languages from one RetrieveUnpublished (any UI language) and write all their languages in one PATCH
  without switching (but in the same document flow: when a form has both tab/section and cell changes,
  write the cell changes in the user's own language pass). Every form XML request goes through LangSession
  (`o.lang.hold(h => h.batch(L, parts))`), also in the user's own language: a batch in another language L is
  `[GET uilanguageid, PATCH uilanguageid=L, probe, …parts, PATCH back]` sent with `Prefer: odata.continue-on-error`
  (LIVE-FINDINGS 49: without it a failing part skips the switch back); one in the user's language is `[probe, …parts]`.
  The probe (systemuser DisplayName's UserLocalizedLabel) proves the answer's language; unproven reads are
  discarded. The repair marker `{lcid: original, to: L, at, until?}` is set before a switch and the language is read
  again (no-store) after the hold. A marker is repaired only while the user is still in `to` (else the switch finished
  and the language was changed since: the marker is dropped); one older than 10 minutes is repaired at the start only
  after a confirm(). A switching batch is never aborted (Stop is looked at before it is sent and after it is
  answered). Before it is handed to Http the marker gets `until` (now + `LOST_MS`, 150 s), and again each time Http
  really sends it (`onSend`: after a wait for a write slot, and for each try after a throttled answer); it loses
  `until` once Dataverse answers. Answered as a whole with an error (4xx, turned away, an unreadable answer), the batch
  has ended and the language is checked as after any batch. With its answer lost (network failure, a 5xx other than
  a 503 with `Retry-After`, §4) it is in doubt (`doubtful`): it may not have started yet, or be running. Until it is
  known to have ended, nothing language-sensitive starts: the session keeps the language lock and the exclusive
  switch window, so no hold, quiet()
  job or switch runs in this or another tab, and the same hold's later batches and `h.window` wait too. It never sets
  the language back, and reads it every ~1.5 s. Its switch seen, then the original twice (its switch back, its last
  part), ends the doubt. Never seen, the doubt ends `LOST_MS` after Http last sent it: Dataverse ends a request it
  hasn't finished within 2 minutes (its request timeout; Microsoft's limit, not measured here), so a batch sent at t
  has run, or never will, by t + 2 min, and 30 s more covers a wait before the server starts that clock. Then the
  language is checked as after any batch (set back if the batch's own switch back failed), unless it reads a third
  language, chosen elsewhere meanwhile, which is kept. A caller can stop waiting: Stop ends its wait with AbortError
  (`restore(signal)` also while another tab's marker says a switch may still run); the batch whose own answer was lost
  throws its own error, so its writer reports it as possibly saved and publishes it, and nothing more is sent; the
  session goes on waiting. Meanwhile a save says "Waiting to be sure an earlier request finished before saving more…"
  (`LangSession.onWait`); outside a save the Workbench banner and a toast say "Waiting to be sure an earlier request
  finished before reading or saving more form labels…". A reload keeps the marker. `recover()` returns at once,
  without waiting for the lock, while its `until` has not passed (a session that may hold the lock meanwhile holds it
  for minutes); the next session's first hold, or a quiet() job through a hold, waits it out the same way before
  anything else (`calm`). So a reload while a switching batch is unanswered (a page load's included) makes the next
  start wait until `until` before form labels load or anything saves. Show Dynamics in refuses meanwhile ("The
  translator is waiting to be sure an earlier request finished. Try again in a minute or two.", §5.3). `run()`'s single
  switch PATCH whose answer was lost is watched the same way (its `until` also counted from Http's last send) and set back as soon as it is seen to land.
  The saver's document and classic ribbon lanes (not under quiet(), as their retries switch the language) wait for a
  switch in doubt before they start, and before each next job while one is in doubt here (left by a writer's own
  `run()` retry). Not covered: a PATCH that only sets the language back (`settle`, `run()`'s switch back,
  `recover()`) or a language chosen for good whose answer was lost is not waited for, and `run()` takes no signal (a
  sitemap or process retry in another language waits out a switch in doubt without Stop).
  One hold per form for all its languages, user's own language first. The saver calls `lang.restore()` in `finally`.
* Loading (`loadFormXml`; needs `o.lang`; the language switch is automatic; without `o.lang` only the user's
  language is read and the other languages are marked "not loaded"). The user's language first: one $batch per 40
  forms carrying
  `systemforms/Microsoft.Dynamics.CRM.RetrieveUnpublishedMultiple()?$select=formid,formxml,iscustomizable,ismanaged,name,type,objecttypecode,versionnumber&$filter=formid eq … or …`,
  then whatever that did not return form by form (`RetrieveUnpublished`, 10 a batch). A form RetrieveUnpublished
  doesn't find (404) is read from its published definition (`GET systemforms(id)`, marked `_pub`): it carries the
  reading language only, cells included, so it is never written back; a form gone both ways is left out. Every label
  of such a form is read-only with `NO_UNPUB` ("Dynamics returns no unpublished definition of this form, and
  translations are only written over that definition, so this form's labels can't be changed here."), after the
  managed and not-customizable reasons: the writer's `RetrieveUnpublished` would not find the form either. Then each other language L, only for the forms whose kept labels need it (tabs and sections;
  `kinds`, the kinds the caller keeps: the Workbench passes its scope's), taking only `label[@languagecode=L]` of
  tabs and sections: a `_pub` form from its published definition read in L (its tabs and sections come in L; its
  cells can't be used, LIVE-FINDINGS 52), a form without unpublished changes the quick way (`quickOther`: its
  published definition, when its `versionnumber` equals the unpublished one's and at most 10 forms are asked, as on
  a page), the others the exact way (RetrieveUnpublishedMultiple in L).
* **Read once more** (`again`): after the first pass, a read in the user's language that failed as a whole or left a
  form out because that form's own read failed, every other language whose read failed (a lock wait, a lost or failed
  batch, a switch not proven) and every form a read did not bring are read once more, each read waiting for the
  language lock afresh: those forms together, then, should that fail as a whole too, one form at a time. One at a time
  stops after three failures in a row (the cause is then not one form): the rest keep that error.
* **What still could not be read** is never shown as empty and never written:
  - A form the user's language could not read at all is left out and reported through `o.progress` ("Loaded with
    problems. The labels of the form “Information” could not be read: " and why; "of N forms" for several); the load
    fails only when no form could be read.
  - A language not read for a form leaves its tabs and sections partial (below), and `ref.unread[L]` says why: the
    batch's error, "Dynamics did not return the form in that language." (`NOT_RETURNED`) or "The form definition
    returned by Dataverse could not be read." (`UNREADABLE`). The reasons name neither the form nor the language: the
    Workbench gathers them for many forms and languages.
  - A `_pub` form's cells and navigation items are known in the user's language only, whatever was read: partial,
    with `ref.unreadable` = `PUB_ONLY`, "This form has no unpublished definition in Dynamics, and its published one
    can't show the form's own field labels in other languages." Reading again can't change that (in another
    language a cell without a label there comes with its column's name), so nothing offers it.
  - `formNote(slots)` gathers the forms and languages whose read failed (`ref.unread` on a partial slot, a language
    read since left out; never `unreadable`), each reason once, for the Workbench's message and **Read again**
    (§5.5). `mergeReads` merges such a read, which asks only for the missing languages, with the slots held: a
    language read before keeps the text read then, and a slot now known in every language is complete again
    (`partial`, `unread` and `unreadable` dropped).
* Elements: tabs `//tabs/tab` (id), sections `tab//sections/section` (id), body cells `tab//rows/row/cell`
  with a `<control>` child (skip spacers), header `/form/header//cell`, footer `/form/footer//cell`,
  tabheader/tabfooter cells, nav items `/form/Navigation/NavBar/*[Id]` with `<Titles><Title LCID Text/>`.
  Slot `ref`: `{ formId, elId, tag, controlId, datafield, area: 'body'|'header'|'footer'|'nav' }`.
  Field slot title = cell label in the user's language, else attribute display name; `sub` = control id.
* Write (per form, per language L, inside the form's hold): one batch `[RetrieveUnpublished, GET systemforms(id)
  (published etag)]` in L → conflict check against `before` (the store's remembered base) → DOM edit: `upsertLabel(…{container:'labels', item:'label', lcidAttr:'languagecode',
  textAttr:'description', lcid:L})` (nav items: `Titles/Title LCID/Text`) → `assertOnlyChanged(skip = exactly the
  edited label/language pairs: that element's label or Title in that language, and a label container of it holding
  nothing else)` → one batch `[RetrieveUnpublished ($select=formxml,versionnumber) (the probe), PATCH systemforms(id)
  with If-Match: <published etag>, RetrieveUnpublished]` in L → on 412 redo once → a probe that is not the form just
  read is someone else's save, which the PATCH replaced: put back by `providers/repair.ts` (§4, "Someone else's save in
  the middle of a whole-document write") → otherwise verify the read-back (only a probe and a read-back proven to be in
  L count). The published etag only catches a publish in between (LIVE-FINDINGS 47): the fresh read right before the
  write is the guard against edits made since the user loaded the label. The probe compares the whole form XML, so a
  column write in the same save that moves the versionnumber is no false alarm; its `versionnumber` tells a probe that
  lags behind the read (§4). LangSession sends every batch with continue-on-error (a switch back must run), so a probe
  that fails does not stop the PATCH. That save is never plain "saved" (§4). A repair in another language runs inside
  the same `h.window` as its pass. Not verified live yet: the whole-form probe on a real form save.
  Another language's pass holds the switch window across its read and its write (`LangHold.window`), so no
  `quiet()` option write runs in between; a write batch turned away unrun starts the pass again from a new read
  after 2, 4 and 8 s.
  Publish `<entity>` (forms) or `<dashboard>` (dashboards, type 0/10).
* Dashboards (type 0/10, objecttypecode `none`) use kinds dtab/dsection/dfield.
* **The form decides for all its labels** (`loadFormXml`): a form or dashboard from a managed solution (its own
  `ismanaged`) makes every tab, section, cell, header and footer field and navigation item of it read-only with
  `MANAGED`, whatever its `iscustomizable`; an unmanaged one marked not customizable gets "This form is marked as not
  customizable (its “Allow customizations” managed property is off), so its labels can't be changed here." A table
  being managed decides nothing here: an unmanaged form of a managed table is editable. The Workbench's list of forms
  (`loadFormsScope`, which selects `iscustomizable,ismanaged`) leaves read-only forms out unless read-only labels are
  asked for. The writer refuses a change loaded from a managed form before any read or language switch, and a pass
  whose read right before the write (RetrieveUnpublished with `formxml,versionnumber,ismanaged`) shows the form
  managed writes nothing: each of its changes fails with `MANAGED`.
* Partial slots (`ref.partial`: tab and section labels not read in every language, and a `_pub` form's cells and
  navigation items): a language that was read but has no label is stored as `''` (known, editable); a language that
  was not read is absent and shown as "Not loaded" (editor, inspector and grid alike), so it can't be edited until it
  is loaded. The writer's `read()` (the current text Undo shows, §5.3) gives such a language the slot's reason
  (`ref.unread[L]`, else `ref.unreadable`, else "The French text could not be read.", naming the language) instead of
  a text.

### 4.4 sitemap.ts (lane `doc`)
* App → sitemap: `appmodulecomponents?$select=objectid&$filter=componenttype eq 62 and _appmoduleidunique_value eq <appmoduleidunique>` or `RetrieveAppComponents`; fallback `sitemaps?$filter=sitemapnameunique eq '<app uniquename>'`.
* Read `sitemaps/Microsoft.Dynamics.CRM.RetrieveUnpublishedMultiple()?$filter=sitemapid eq <id>` (RetrieveUnpublished
  is not supported for sitemaps, finding 13; loaders fall back to the plain GET, writers never) → `sitemapxml`.
  `<Area|Group|SubArea Id><Titles><Title LCID Title/></Titles><Descriptions><Description LCID Description/></Descriptions>`.
  An element with no Titles and a `ResourceId` shows that resource's text:
  - The app designer's placeholder (`ResourceId="SitemapDesigner.*"`, e.g. "New Group" / "Nouveau groupe", no legacy
    `Title` attribute; `ref.placeholder`, LIVE-FINDINGS 99) can be named here. Its Title slot is editable, with the base
    language required first (model.ts `namesFirst`, `baseNameFirst`: "Name it in English too: languages without a name
    of their own show the English one."): the saver, the popup ("Name it in English too") and the writer refuse a title
    in another language alone, which would leave the others on a text nobody chose. The write adds `<Titles>` as the
    item's first child, with nothing else changed. Its description waits for a title: "Name this item first: its
    description can be translated here once it has a title." Not verified live: what a SubArea with `Entity` and such
    a resource shows (the placeholder or its table's plural name); it is a placeholder here.
  - Any other resource is Microsoft's own label and stays read-only: "Microsoft's own text, already shown in every
    installed language. To use your own name, set a title in the app designer." (its description: "… To use your own,
    set a title in the app designer first.").
  - Every item carries `ref.resource` (the ResourceId's last segment) and `ref.unnamed` (no Titles) for the page (§5.4).

  A SubArea with `Entity`, no Titles, no `ResourceId` and no legacy `Title` attribute shows the table
  plural name → readOnly with hint "Shows the table's plural name — translate the table instead", and `ref.plural`
  (translation mode marks the table's plural name there, §5.4). A SubArea with a legacy `Title` attribute and no
  Titles is never `ref.plural`; its reason is the single-language title one.
* **A sitemap from a managed solution** (its `ismanaged`, selected by both reads; sitemaps have no `iscustomizable`
  column): every item is read-only with `MANAGED` (`toSlots`), an app designer's placeholder too, so no item of it is
  ever named here; only Microsoft's own labels keep their reason ("Microsoft's own text…"). The Workbench leaves these
  out unless read-only labels are asked for (`HIDDEN`). The writer refuses a change loaded from a managed sitemap
  before anything is read, and `write()` refuses every change when the read right before the write shows the sitemap
  managed.
* Verify per-language behavior at runtime: research says inline all languages; the writer must verify
  after write and report errors (if languages get dropped like forms, use LangSession like formxml).
* Write: fresh RetrieveUnpublishedMultiple + published etag → `upsertLabel` (Titles first child; Descriptions before first
  Group/SubArea/Privilege child) → `assertOnlyChanged` (skip: exactly the edited item/property/language entries) → one
  `$batch` `[RetrieveUnpublishedMultiple of the sitemap (the probe), PATCH sitemaps(id) {sitemapxml} with If-Match:
  <published etag>, RetrieveUnpublishedMultiple]` sent `once` and without continue-on-error → verify the read-back (the
  sitemap reads select `versionnumber` as well: a probe with a lower one than the read lags behind it, §4) → publish
  `<sitemap>{id}</sitemap>` (and `<appmodule>` if needed). A probe whose sitemapxml is not the read's is someone else's
  save the PATCH replaced (If-Match only guards the published sitemap): put back by `providers/repair.ts` (§4). Turned
  away unrun (429, a 503 with `Retry-After`, the customization lock), or stopped at a probe Dataverse answered with an
  error (nothing was written): the pass again from a new read after 2, 4 and 8 s; a probe still failing then: "The
  latest (unpublished) version of this sitemap could not be read right before saving, so nothing was saved (…)".
  The sitemap joins the publish set after a PATCH that went through or may have (lost answer), and for any change
  found already as asked. An item without any Title entry gets a title in another language only together with a
  non-blank base-language one for the same item (same kind and Id) in the same batch; otherwise that change fails with
  `baseNameFirst` and nothing of it is written. Not verified live yet: the PATCH inside a `$batch`, `versionnumber` in the
  RetrieveUnpublishedMultiple `$select` of sitemaps (loads use it too), and whether `GET sitemaps(id)` returns the
  published sitemapxml. The Publish dialog's check after publishing does not read sitemaps (§5.3).

### 4.5 bpf.ts (lane `doc`) — verified live
* BPFs: `workflows?$select=workflowid,name,uniquename,primaryentity,statecode,ismanaged,iscustomizable&$filter=category eq 4 and type eq 1`.
* A process from a managed solution (`workflow.ismanaged`, whatever its `iscustomizable`: workflows are "top wins", so
  any write would be an unmanaged layer on it) has every stage and step label read-only with `MANAGED`; the Workbench
  leaves such processes out unless read-only labels are asked for. The writer refuses a change loaded from one before
  anything is read, and each pass (`pass`) refuses every change when the definition read right before the write shows
  the process managed. Its name and description are record labels (§4.2), and the process update after a name is saved
  reads `ismanaged` first (§4.7 step 4).
* Labels live in BOTH `xaml` and `clientdata` (JSON) as StepLabel entries keyed by `LabelId` + `LanguageCode`:
  xaml: `<sco:Collection x:TypeArguments="mcwo:StepLabel" x:Key="StepLabels"><mcwo:StepLabel Description="Test1" LabelId="8f91…" LanguageCode="1033" /></sco:Collection>` (prefix may vary; the same label can appear several times — update all);
  clientdata: `stepLabels: { list: [ { labelId, languageCode, description } ] }` on StageStep (labelId = stageId = processstage id) and StepStep (labelId = stepStepId). Stage display names come from StepLabels (e.g. "Test1"), not `processstage.stagename` ("test1").
* All languages are stored inline (verified: adding 1036 StepLabels to xaml+clientdata persisted for both draft and **activated** BPFs, 204, ~9 s per PATCH; no deactivation needed).
* Write: GET `workflows(id)?$select=name,primaryentity,ismanaged,iscustomizable,xaml,clientdata,versionnumber` → conflict check → xaml: **string splice** each `StepLabels` collection: replace the `Description` of the StepLabel with matching LabelId+LanguageCode, or insert a new `<prefix:StepLabel Description="…" LabelId="…" LanguageCode="L" />` (the tag only, no copied indentation; XAML ignores whitespace between items) after the last StepLabel of that collection (escape with `xmlAttr`); a clear would delete that language's tag(s) in every collection (never reached: the writer refuses a blank stage or step translation, and the saver writes its stand-in instead, see below); clientdata: in-place edit of every `stepLabels.list` entry with matching labelId, re-serialised exactly as before (keeps the `\/` escaping) → one `$batch` `[GET workflows(id) (the probe), PATCH workflows(id) {xaml, clientdata when it changed} **without If-Match** (LIVE-FINDINGS 29: the workflow PATCH rejects it), GET workflows(id)]` sent `once` and without continue-on-error. Turned away unrun, or stopped at a probe Dataverse answered with an error: the pass again from a new read after 2, 4 and 8 s; Stop during a wait writes nothing more. → A probe that is not the definition just read is someone else's save, put back by `providers/repair.ts` (§4): their StepLabels as they saved them, ours on top, and a label they changed too becomes a conflict keeping theirs. A name Dynamics only keeps (`ref.stored`) is never written by it. → Otherwise verify the read-back (parse both again). A save Dataverse applies while the PATCH runs (~9 s) can't be seen. Not verified live yet: the workflow PATCH inside a `$batch` (the live suite's bpf steps run it, and `bpf preservation` checks its shape). BPF name/description go through records.ts (workflow is localizable).
* What the page shows can also come from the names Dynamics keeps (LIVE-FINDINGS 83, 85): once a stage or step translation is stored, removing its StepLabel leaves it showing, and a StepLabel in that language replaces it. On a record page (inspector/pageload.ts `process()`), `loadBpfStored` reads them per language with `GetClientMetadata(ClientMetadataQuery=@q)` (`{"MetadataType":"businessprocessflow","EntityLogicalName":<primary table>,"MetadataId":<the page's record>,"GetDefault":false,"AppId":<app>}`, headers `x-ms-metadatareductionlevel: 5` and `ClientHost: Browser`; the answer's metadata is a JSON string with `Labels` `{Id, LabelColumnName: "description", Value}`), each language in a LangSession hold of its own (no switch for the user's own), only the languages some stage or step has no label in. They fill those languages (the definition wins; the base text counts too) and are listed in `ref.stored`: a real translation in the popup and on the page. The page adds the stages and steps to the store once, with those names: the definition's slots, carrying an earlier read's names (`mergeStored`), go to `loadBpfStored`, and what it returns goes into the store (added before that read, a stage whose name only Dynamics keeps was marked missing, amber, for a moment, then blue; verified live 2026-10-22: the stage marks appear once, already blue, about 2 s after the page opens). A language a read misses is listed in `ref.unread` (the load counts as failed; Try again reads both again), and only that read's misses: a read that misses nothing clears an earlier read's `ref.unread`. Saving one writes its StepLabel, measured against the kept name. Emptying one, or any stage or step translation, writes its stand-in, the stage's or step's base-language text, as that language's StepLabel (§4, "Clearing a translation"); the writer refuses a blank one (`cantClearText`). The live suite checks that the save would write it without saving it: a stored stage name can't be taken back. Not on another table's record, without a record, or in the Workbench (no record to ask for); a later load of the definition only (the Workbench's, the page's without a record) keeps the names read before (`mergeStored`), and a process first loaded without them (a new record, now saved; the Workbench) has them read on the next page load of a record of its table.
* Never touch anything else in xaml/clientdata. Sanity check before the PATCH: the xaml outside StepLabel
  tags must be byte-identical (whitespace included), the StepLabel tag count must equal the original plus
  added minus removed, and the spliced documents are re-parsed to confirm every change is in its wanted
  state. No DOMParser on XAML for writing.
* Live suite `bpf preservation` (tools/e2e-suite.js, needs the account "DXT BPF Test"): before and after saving one
  step's French, every stage and step label in every language is read from the definition (xaml and clientdata) and
  from GetClientMetadata (per language, as `loadBpfStored`); the save must be exactly one `$batch` `[GET workflows(id),
  PATCH workflows(id), GET workflows(id)]` sent without continue-on-error; everything but that step's French must be
  unchanged in both places. Then the step's previously shown French is written back (a kept name is replaced, never
  removed), the definition is restored byte for byte, and every shown name must be as before. It only picks a step
  whose shown French differs from its base text.

### 4.6 ribbon.ts (lane `ribbon`)
* Read labels: `ribbondiffs?$select=diffid,entity,rdx,ismanaged&$filter=difftype eq 3 and (entity eq '<e>' or …)` (verified readable; `rdx` = `<LocLabel Id><Titles><Title description languagecode/>…` with all languages). Application ribbon: `entity eq null`. One slot per LocLabel Id (comp `ribbon|<entity or _app>|<Id>`): an unmanaged row wins over managed ones for the texts, and any managed row of the Id makes the label managed (`readDiffs`), also where someone customized it in an unmanaged row: it comes from that solution, so it is read-only with `MANAGED` and never written here.
* Button map (inspector): `RetrieveEntityRibbon(EntityName='<e>',RibbonLocationFilter=Microsoft.Dynamics.CRM.RibbonLocationFilters'All')` → `CompressedEntityXml` (base64 **zip**, single part RibbonXml.xml) → `Map<controlId, {LabelText, ToolTipTitle, ToolTipDescription, Alt}>` tokens (`$LocLabels:Id`, `$Resources:…`, literal). Inspector maps button `data-id` last segment → control → LocLabel id.
* Write (classic, through **ImportTranslation**, LIVE-FINDINGS 72–77; ~20 s per table, the review dialog says so): fresh read of `ribbondiffs` → classify (a label a managed solution defines, as read now or as loaded → refused with `MANAGED`; blank base → refused; a removal → `CANT_CLEAR_TEXT`, an import never removes a title, findings 39/69 (the saver never sends one: it writes the stand-in, the base-language title, §4); control characters → refused; conflict check against the store's `before`) → refuse everything when `allowPublish` is false (ribbondiffs show only the published ribbon, finding 26) → **publish the scope first** (`PublishXml <entity>`, application ribbon `<ribbons><ribbon/></ribbons>`), because an import writes over a pending title of the same language and the check can only see published titles (finding 74) → the scope's **unmanaged** `ribboncustomizations` row (`$filter=<entity eq 'e' | entity eq null> and ismanaged eq false`, exactly one; a translation file names a label by the row of its layer, finding 76) → temp solution `dxt_ribbon_<entity>_<base36 time>` (publisher by LocLabel prefix, else the default publisher) → `AddSolutionComponent` of the table shell (`ComponentType 1`, `DoNotIncludeSubcomponents: true`) or the application ribbon (`ComponentType 50` with that row's id, `DoNotIncludeSubcomponents: false`: true is refused, finding 75) → **for each try** (up to 3): fresh read + classify again, refuse the changes of a label that would have no base-language text (`needBase`: a row with an empty base cell is skipped whole without an error, finding 73), build `CrmTranslations.xml` (`translationXml`: Information sheet with organization id, `Exported on` DateTime, base language, solution name; header-only Display Strings; one Localized Labels row `RibbonCustomization | <row id> | <LocLabel Id> | <base> <other languages>` per edited LocLabel — the base cell holds the edited base text or the one just read, edited languages their text, other languages an empty cell, which keeps the title; text escaped with `xmlAttr`, so line breaks and tabs are character references) zipped with `[Content_Types].xml` → `ImportTranslation {TranslationFile, ImportJobId}` (synchronous, 6–10 s; sent `once`: Http never resends the file, and one turned away unrun, 429 or a 503 with `Retry-After`, is tried again like a deadlock, from a new read after 5 s, then 10 s) → read `importjobs(<job>).data` (`<status>`): Succeeded → go on; Failed or a 4xx answer → nothing was applied: a deadlock (500 `0x80044150`, Sql 1205: another import of the same table) or customization lock is tried again after 5 s, then 10 s, from a new read; anything else is reported; a lost answer with no readable job → publish and verify anyway. → read `ribbondiffs` again right after the import, before publishing: a cell of the file (the base cell, each edited language) whose published title moved since the read the file was built from was published by someone else meanwhile (`movedCells`). If theirs came before the import ran, the import wrote this save's cell over it in the unpublished ribbon → publish the scope → `putBack`: read `ribbondiffs` again. A cell that still shows this save's text gets theirs by a second import (its row with its base text, finding 73) and a publish, which only works once this save's text is the published one (finding 74). A cell already showing theirs needs nothing; a third text is left as it is; a cell of a label that read shows a managed solution defines is never written and never owed ("putting theirs back failed (it now comes from a managed solution, and a write would add an unmanaged layer on top of it)"; a cell an earlier save owed: "… can't be restored here: …", without Try again). Each put-back import is watched like the first: `ribbondiffs` read right before it and right after it (before its publish, retried once after 1 s); a cell it carries, the base cell included, that reads otherwise after it (and not as it sent) was published by someone else while it ran, perhaps before it wrote over it, so the next put-back puts theirs back the same way once this one is published, and its read also checks the last put-back's cells (one still showing this save's text is owed, never imported again). At most three put-back imports (`PUT_BACKS`); a change published while the last one runs is owed ("someone else kept changing it at the same time"). A put-back whose publish fails owes its cells and those published while it ran (its import lies unpublished over them). Their text in an edited language makes the change a `conflict` (server = theirs); the same text from both is saved. A cell that could not be put back is said on the change and owed (`OWED`, per page): the next save of that scope puts it back right after its first publish, even with nothing else to write (Try again), watched the same way. A change of that save found already as asked in a cell it puts back is checked again from the next read, so it is a conflict with their text, never "already up to date". A put-back import whose answer was lost, and whose cell the read after it still shows with this save's text, is owed too. No read sees into the seconds a put-back import runs, so a label one wrote is never plainly saved or up to date: "Saved, but someone else was changing this button's text at the same time — check it: the <languages> text of “<title>” (<LocLabel Id>). It now reads English “…”, French “…”." (plus that another change can't be ruled out when the read right after it failed, and that it may still be running when its answer was lost). A conflict on such a label becomes an error with "… Also, " and the same note when another language of it was published while a put-back ran, that read failed, or a put-back's answer was lost (it may land after every read with the base text it read, so the note then names the base language too); the review shows a conflict without its message. A conflict never hides their text lost beside it either ("… Also, someone else published “B” as the English text of this label at the same moment, and this save put back “A”; putting theirs back failed (…)"). A change stopped (Stop) after a put-back on its label reads "Cancelled before the import: this change was not saved." followed by the same notes (the check-it note, or what was lost there and what is still owed), never "Nothing was changed" alone. Without the read right after the import nothing is plainly saved → verify with `ribbondiffs` (the edited language exactly as written; the other languages as read right after the import, with what was put back) → delete the temp solution (`DELETE solutions(id)`, components stay; retried after 2, 4, 8 and 16 s on 429 / "Cannot start another" / `0x80071151`, 404 counts as deleted; if it still fails, or an import of the save may still be running (one whose answer was lost, even when a later import answered), the results name the leftover `dxt_ribbon_…` solution and say it is safe to delete; stale `dxt_ribbon_` solutions this user created (`_createdby_value eq <ctx.userId>`, unmanaged, checked again on each row) more than an hour ago are deleted on the next run; another maker's never). Never name `Default` in a translation file (it blocks other makers' solution work for minutes, finding 71). Each import leaves an `importjobs` row "Translations" in the import history. If the publish after the import fails: "The French text was imported but not published (…): users see the old text until <table>'s command bar is published. Try again to publish it." Try again publishes first, then finds the text already as asked; a cell the import wrote over someone else's is owed and put back then, and the message says so. Without the read right after the import, that message also says that a change someone else published at the same moment can't be ruled out. What no read can show: unpublished ribbon work saved after this save's first publish and before its import (finding 26), or while a put-back import runs, which that import may write over (a label a put-back wrote is never plainly saved; ImportTranslation has no compare-and-set, so only an exclusive customization window rules it out); and a cell someone else published before the import shows this save's text for the ~10–15 s between this save's publish and the put-back's publish (an import can't do better, finding 74). `OWED` lives only in the page: after a reload the change's message says what to restore.
* Before 2026-10-16 the writer exported the shell solution, spliced the `<LocLabels>` and re-imported it with `ImportSolutionAsync` (52 s–2 min, findings 19, 24, 30, 40): it replaced the scope's unmanaged ribbon layer, so it needed the export to be seconds old, and it could not save application ribbon labels at all (finding 75). The `ribboncustomizations.publishedon` check it used never changes (finding 77).

### 4.7 Saver (core/saver.ts, publish.ts, history.ts)
* `saveAll(app-ish deps, changes, {signal, publish: boolean, onProgress})`:
  0. Stand-ins (`measure()`, §4 "Clearing a translation"): a non-base translation emptied where Dataverse can't remove
     it becomes its stand-in (`withStandIns`), measured by the texts as the run leaves them (`saveText`), before the
     checks and the writers; a metadata description's stays blank and is saved empty (`savesEmpty`, no error, no
     warning of its own: a global choice value keeps its "Global choice: …" warning).
     `SaverApi.prepare(changes, {undo, force, anyway, now})` does exactly this without writing (`written`, `issues`,
     `text`), and `validate(changes, o)` is its issues, so the Publish dialog and the Undo question show what the run
     writes.
  1. Validate: base-language blank → block; over max length → block; whitespace-only/leading-trailing spaces → warn;
     an emptied translation Dataverse can't remove that has no stand-in → block with the reason (`noStandIn`), and one
     whose stand-in only waits for a text to be loaded → held back ('skipped', `Issue.unloaded`); readOnly slots, and
     any slot of a managed solution's component (`isManaged`, whatever its `readOnly` says) → "Read-only: &lt;reason&gt;"
     (`MANAGED` for the latter), skipped and never sent to a writer; the publish set (`publishTargets`) leaves them out
     too. The Publish dialog shows each warning on its row (placeholders that don't match, a translation removed, only
     spaces, a global choice's other columns); a translation worded like the base text gets none, as many labels read
     the same in both languages. The `general` ones (Issue.general: tab/section labels in another language switch the
     UI language, classic command labels take ~20 s a table) once under its subtitle. There is no note about managed
     components: they are never saved. The popup and the editor card show errors only, and what an emptied translation
     becomes (§5.2, §5.4). Then, before any write, the texts the stand-ins are made of are read again (`sources()`): a
     change whose stand-in is made of a text that moved fails with `sourceMoved`, one that couldn't be read with
     `sourceUnread`, and a stand-in that is the text it replaces already is 'unchanged' without a write while the same
     reads show the server still holds that text (another text there: a conflict, §4 "Clearing a translation").
  2. Group by `slot.group`; route by writer lane (`schedule()`), three lanes at once (LIVE-FINDINGS 44): metadata
     groups strictly sequential (PUTs first, then option actions, each under `lang.quiet()` so none runs while
     the user is switched); records groups 4 parallel; xml groups one form at a time (one `lang.hold` per form,
     user's own language first; a form's name/description waits for its XML). All lanes settle, then doc
     groups sequential, then ribbon groups, sequential (each doc or ribbon job first waits while a language switch is in
     doubt, §4.3). `finally { await lang.restore() }`. Never write while
     PublishXml runs (LIVE-FINDINGS 48): the publish starts only after every lane has ended. A job holding a stand-in
     made of a text another job writes (`apart`, §4 "Clearing a translation") is set aside (`after`): a metadata,
     records or xml one runs once those three lanes have ended, a doc or ribbon one after the other jobs of its
     sequence, each through `gate`, which holds back each stand-in whose text wasn't saved (`ready()`) and writes the
     rest of the job.
  3. Unknown/thrown errors → every change of that group gets outcome 'error' with a friendly message.
  4. Publish once, when anything was saved or found already saved ('unchanged': possibly an earlier write
     whose answer was lost; its writer added it to the publish set), the Publish dialog counting and checking
     both: `PublishXml` with everything collected (order: entities, ribbons, dashboards,
     optionsets, sitemaps, appmodules). Retry customization-lock errors (5 s, 10 s, 20 s, 40 s). If an
     `<appmodules>` element is rejected, retry without it. Never PublishAll.
     Then each business process flow whose name was written (`PublishSet.processes`, added by records.ts for a
     `bpf` Name; never for its description or its stage and step labels) is updated once (`publish.ts
     rebuildProcess`, LIVE-FINDINGS 83): the app is served a compiled copy of the process that keeps the old name
     until the process itself is updated, and a PATCH of a localizable column writes the caller's UI language, so
     `PATCH workflows(id) {name}` is sent inside `LangSession.run(base)` (no switch when the user is in the base
     language) with the base-language name read right before it, so no label changes; the PATCH goes in one `$batch`
     [RetrieveLocLabels, PATCH, RetrieveLocLabels], sent once without continue-on-error. A base-language name someone
     else saved after that read shows in the batch's first read, and the PATCH replaced it.
     Theirs is put back the same way, in the same window, only over this update's own name: a name saved after the
     PATCH is newer and stays. That put-back is sent again from a new read (after 2 and 4 s) only while Dataverse turns
     it away or its first read fails on the server's side, then read back. The warning says what happened: "Updating
     the process X replaced its English name “A”, which someone else saved at that moment, with “B”; theirs is back.
     Check it." (or: it now reads a newer name, so it was left as it is / putting it back replaced a third one /
     failed or could not be confirmed, "Check its English name."). A save landing between the batch's first read and
     its PATCH stays unseen, as in every write batch. The base-language names this save's own write replaced (the saver
     passes them from its saved base-language name changes of that process) mark a read behind that write
     (LIVE-FINDINGS 66). Such a read is made again after 1, 2, 4 and 8 s before the window, which switches the user's UI
     language; while the name read still shows one, nothing is sent (the PATCH would put the old name back) and the
     saver says the page may show the old name (below); the same for the read inside the window. A batch read showing
     one is nobody's save, and nothing is put back from it. Not covered: RetrieveLocLabels has no `versionnumber`, so a
     batch read behind someone else's recent base-language name (not this save's) looks like a race, and their older
     name is put back; the warning names both, to check. Outside every quiet() window
     (run() needs the exclusive one, so it can't run from the save lanes), on the Publish dialog's Publishing step
     ("Updating the process …"). The update itself is never sent again; a failure keeps the save and says "Saved; the
     page may show the old process name until the process is updated." (`SaveReport.notice`, no automatic refresh); a
     read after it showing another language changed (a language whose name the read after it shows differs from both
     the read before it and the batch's first read) is a warning. An undo of a process name updates it the same way.
     Only a process whose name a writer saved is updated, so never one from a managed solution, and `rebuildProcess`
     checks again before anything else: it reads `workflows(id)?$select=ismanaged` (Strong), and a process from a
     managed solution ("The process X was not updated. " + `MANAGED`) or one that read doesn't show as unmanaged
     ("The process X was not updated: Dataverse did not say whether it is from a managed solution.") is not updated:
     the save is kept, with the notice above.
  5. Record history: `{ id, at, items: [{key, comp, kind, lcid, title, where?, before, after}], published, undoneAt?, kept? }`
     for the cells this run wrote (below; localStorage `dxt:history:<orgId>:<userId>`, newest first, cap 50 saves /
     ~400 KB / 90 days; an older save leaves the journal, and the storage, at the next read, through `change()`).
     `title` and `where` are the Publish dialog's row header (`SaveRunOptions.describe`), `where` left out when empty.
     A label costs ~190 characters for a column, ~320 for a form cell (~50 of them its place), so ~400 KB holds
     roughly 1,200–2,000 labels. One save may pass the budget alone, up to a 1.5 MB ceiling; a save too large for it,
     or for the browser's quota, with its places is kept without them (~270 a form cell, its rows then show title and
     what), so a bulk import stays undoable. Kept per user: another account signed in to the same browser profile
     doesn't list or undo it in Recent publishes (anyone reading the browser's storage directly still can). It holds
     the exact texts because Undo writes `before` back where `after` still is; it can't be session-only (the publish
     reloads the page and the purge clears sessionStorage). The per-org journal of earlier versions
     (`dxt:history:<orgId>`, no user) is removed without being read, at every read of the journal (history.ts
     `dropShared`): nothing tells whose saves it holds, so they are never given to whoever opens the translator next
     (another account would see their texts and be offered their Undo); those saves can no longer be undone from the
     translator. `dxt:mine:<org>` stays per org on purpose: a read that lags behind another account's write in this
     profile within its minute must still be caught.
     - **Only what this run wrote** (saver.ts `tried`, `ChangeResult.found`; providers/types.ts `SaveOptions.ran`). A
       change found already as asked ('unchanged') whose text differs from the one it was edited on is journaled only
       when a write of that text by this saver may have run and its answer didn't confirm it (an error, or a stop once
       the write began: reported as not confirmed, then Try again). That is the earlier write, published by this run.
       Each writer says which changes it sent a write for that Dataverse didn't refuse (`Writer` rule 7: it adds them
       to `o.ran`, answered or with the answer lost, `mayHaveRun`, and before throwing too); the saver records a
       failed change's text in `tried` only when `ran` has it. A first attempt whose read was refused, whose write was
       refused (4xx) or turned away unrun, or that never sent its write records nothing, and leaves an earlier run's
       entry as it is (that write's answer is still unknown). A result that settles the change (saved, unchanged,
       conflict) clears it. One no write of this saver may have put there (`found`) is someone else's text as far as
       this page knows, also on a Try again that finds it after such a first attempt. It is left out of the journal,
       so Undo of this publish never offers to put back what this run didn't write; a write whose answer was lost and
       that a Try again finds applied is still journaled, so its Undo works. It still counts as already as asked, and
       the Publish dialog says it apart: "Done. Published 2 changes. 1 change was already on the server, so Undo of
       this publish leaves it alone.", or "Done. 1 change was already on the server: nothing was written."
       (ui/review.ts `settle`).
     - **One writer at a time** (history.ts `change()`). The tabs of one user share the journal, and localStorage has
       no locking of its own. Every change of it (`addHistory`, `markPublished`, `markUndone`, the expired saves
       removed after a read) runs under a Web Lock named after its key: it reads the list as stored then, edits it and
       writes it, so a tab never writes back a list it read before another tab's write and drops that tab's save. A
       tab's own changes run in the order made (locks are granted in request order). Without Web Locks, or when the
       browser refuses the lock, the change runs at once. The journal is read again right before it is written, and a
       list that changed since is edited again from the new one, up to three times. These calls return promises,
       which the saver and the Publish dialog await. One key with a lock rather than a key per save: the journal stays
       one read, its budget and order one decision, and the storage needs no listing of its keys (which Dynamics' own
       keys would crowd).
  6. `store.commit(results)`, return a report (counts, durations, published?).
* Undo a save: builds changes from history (before ← after) for slots still in the store (or reloads them), runs the
  same pipeline (conflict check uses `after` as the expected server value; `undoChange`). A translation the save added
  that Dataverse can't remove is written as its stand-in, measured by the texts the undo writes back, else the
  server's (§4, "Clearing a translation"; a metadata description stored empty before the save, `HistoryItem.empty`, is
  saved empty again); the labels chosen with Undo anyway (`SaveRunOptions.anyway`) count as written there. Recent
  publishes asks first with what it will do to each label (§5.3; `SaverApi.current`, then `SaverApi.prepare` as an
  undo, with the texts just read). A label whose component is read-only now, one from a managed solution included, is
  refused by the saver's check: the question shows "Read-only: …" with the reason, and the undo leaves it as it is.
* **Pending-work check before publishing**: `PublishXml <entity>`
  publishes *every* unpublished change on that table by anyone (forms, views, charts, columns, ribbon). Before
  anything is written, `pendingWork(changes)` queries `systemforms/Microsoft.Dynamics.CRM.RetrieveUnpublishedMultiple()?$select=formid,name,objecttypecode&$filter=componentstate eq 1 and (objecttypecode eq 'a' or …)`,
  the same of `savedqueries` (`returnedtypecode`) and `savedqueryvisualizations` (`primaryentitytypecode`), 20 tables a
  request. The components being translated are listed too: work already pending on them (a form a maker rearranged and
  did not publish) is kept by the writers, which write the unpublished XML, and goes live with the translation. A failed
  read rejects; it never stands for "nothing pending". `othersNote` (ui/review.ts) turns the result into one sentence:
  "Publishing Account also publishes 2 other unpublished changes on it.", or, when the check failed or gave no answer
  within 15 s, "Couldn't check Account for other unpublished changes: publishing it also publishes any there are."
  The Publish dialog shows it next to Publish. Publish never outruns the check: a click (or Ctrl+Enter) before it
  answers shows "Checking for other unpublished changes…" and goes on by itself only when there is nothing to say;
  otherwise the sentence is shown and the next click publishes. Recent publishes › Undo shows it in its question (Undo
  enabled once the check has answered). Recent publishes › Publish asks "Publish this save?" with it when there is
  something to say, and otherwise publishes at once. Those two run after the save, when the forms, views and charts it
  edited are unpublished because of it: they leave them out (PendingWork items marked `mine`; Undo only for a save
  never published). Publishing always publishes. Besides that sentence, the dialog states the whole publish scope from
  the moment it opens, on a second line next to Publish that never needs another click (`scopeText`, ui/review.ts).
  Example: "Publishing also publishes anything else not yet published on: Account (table),
  Translator Test App (navigation); the translator can only check a table's forms, views and charts." It names every
  table, app navigation (sitemap), dashboard, app and global choice the publish covers, marked (table), (navigation),
  (dashboard), (app) or (choice), and "the command bar of every table" for the application ribbon. More than four items
  are cut to three and "N more". Without tables it ends "the translator can't check it/those". With classic command
  labels it adds "Account is published first, before its classic command labels are saved.", and for the application
  ribbon "The command bar of every table is published first, before its classic command labels are saved." (ribbon.ts
  publishes the table, or `<ribbons><ribbon/></ribbons>`, before the import); both together: "Account and the command
  bar of every table are published first, before their classic command labels are saved." The Undo question shows it
  too. Recent publishes › Publish shows it in its question when it asks; with nothing found it still publishes at once,
  because the original save's dialog showed it. Not covered: a draft saved between the check and PublishXml (published
  without being announced; Try again and Publish again in the same dialog don't check again), pending
  column/relationship/table metadata and classic ribbon work (no query exists, finding 26), global choices, and drafts
  on a sitemap, app or dashboard (their `componentstate` filter is not verified live). The components they may be on
  are named, with what can't be checked, in the scope sentence. The README says what is checked.
* Measured costs (live, LIVE-FINDINGS 44–50): column label PUT ≈ 1.4–2.5 s warm (first ~6 s); UpdateOptionValue ≈
  0.5–1 s; formxml PATCH ≈ 0.4–1.5 s; a language-switch $batch ≈ 0.25–0.5 s (≈ 1 s with a form write); PublishXml
  of a small table ≈ 4–13 s; BPF workflow PATCH ≈ 9 s; classic ribbon labels of one table ≈ 21–23 s (ImportTranslation ≈ 6–10 s of it); ExportTranslation of one table ≈ 16 s. A field label plus its
  tooltip on the test table: Publish click → page reload 8 s. Loading a 340-cell customer main form in both languages:
  1.6 s (everything on the page 2.4 s).
  (ImportTranslation as a general bulk accelerator: it only applies rows for components of the solution
  named in the file — silently ignoring the rest — and naming `Default` takes minutes and blocks other
  makers (LIVE-FINDINGS 15, 27, 71). An empty cell removes no metadata or ribbon translation, and a form
  tab/section label only from the unpublished form (findings 67, 68; finding 28 was not reproducible). Only
  classic ribbon labels use it, through a temporary solution (§4.6).)

### 4.8 Translation suggestions
Removed in v3 by design: no translation memory, no on-device machine translation.

---

## 5. UI / UX

Design language: **match the unmanaged layers explorer** (Fluent 2): Segoe UI 14/20, brand `#0f6cbd`
(hover `#115ea3`, pressed `#0f548c`, bg `#ebf3fc`, stroke `#b4d6fa`), neutrals fg1 `#242424` fg2 `#424242`
fg3 `#616161` fg4 `#707070`, bg1 `#fff` bg2 `#fafafa` bg3 `#f5f5f5` bg4 `#ebebeb`, strokes s1 `#d1d1d1`
s2 `#e0e0e0` s3 `#f0f0f0`, red `#c50f1f` (bg `#fdf3f4`, stroke `#eeacb2`), green `#0e700e` (bg `#f1faf1`),
amber `#8a3707` (bg `#fff9f5`, stroke `#fdcfb4`). 4px radius controls, 8px panels, shadow
`0 0 2px rgba(0,0,0,.12),0 32px 64px rgba(0,0,0,.24)`. Buttons 32px; `.btn`, `.btn.primary`, `.btn.subtle`,
`.btn.icon`, `.btn.danger`; inputs with bottom border accent; pills (filter chips) 28px round; badges;
segmented control; skeleton shimmer; toasts bottom-right; modal scrim; slide-in sheet; minimize
to a round "pill" at the bottom-right. Respect `prefers-reduced-motion`. Everything inside one shadow root
(`:host{all:initial}`), host `position:fixed; inset:0; z-index:2147483646; pointer-events:none`, only
the window has `pointer-events:auto`. Stop keydown/keyup/keypress propagation at the host so Dynamics
shortcuts don't fire while typing. Icons: `icon(name)` from dom.ts.

Status colors (consistent everywhere): **missing** in target language = amber; **edited (staged, not published)** =
green; **saved** = green check (Workbench); **conflict / error** = red (in the Workbench a conflict is Fluent's
warning orange with a "?", apart from a problem's red "!", §5.5); **read-only** = lock icon, grey; on the page
the same grey dotted mark as built-in text, its popup giving the reason in plain words (from a managed solution, not
customizable, renaming locked or turned off, Microsoft's own sitemap label…; principle 11, §4.1, §4.4), "Read-only" in
lists; **built-in** (Microsoft's text, already in every language) = grey dotted mark on the page, "Built-in" in lists.
A label from a managed solution is always read-only, never built-in, even with text in every language. Microsoft's own
tables and forms (account, contact…) are managed, so on them almost every label is grey. A managed solution's labels
are translated in the environment where that solution is developed; in a development environment the user's own
unmanaged components are translatable, an unmanaged form or column of a managed table included.

### 5.1 Two ways of working (ui/app.ts)
* **Translation mode** (record, list and dashboard pages; the default there): no window. A slim floating
  bar (ui/bar.ts) at the bottom, right of the left navigation: "Translator | English → French | status | Review and
  publish | All labels | Workbench | ⋯ | ✕", draggable by its logo, position remembered (`prefs.bar`, fractions of
  its room). See §5.4. Its room keeps clear of Dynamics' left navigation, so it never covers the area switcher at the
  navigation's foot (`barSpan`, `navWith`, `clearOf`):
  - It is centred in the room right of the navigation (`[data-id="navbar-container"]`, at the left edge, narrower
    than half the window) and left of the All labels sheet, while that room is at least 480 px (`NAV_ROOM`). Only a
    docked sheet counts: a floating one lies over the bar (§5.4), which takes its usual room again (ui/bar.ts
    `scanLayer` watches the sheet's class). While the switcher's list of areas is open (wider than a collapsed
    navigation) the room starts right of that list, so the bar moves right. The navigation is watched (a
    ResizeObserver): collapsing or expanding it with its ☰ button moves the bar without a window resize.
  - In a window too narrow for that, the room starts at the window's left edge, and a bar that would cover the area
    switcher (`#areaSwitcherContainer`, `#areaSwitcherId`) rises above it; so does one dragged over it, once it is let
    go.
  - Dragged by its logo, it moves within that room.
* **Workbench** (any page; the only one on other pages): the window (ui/shell.ts) with the title bar (logo, title, org
  badge, language button, More, dock / maximize / minimize / ✕), always one row. Opening it pauses translation mode
  (marks hidden, no interception) and hides the bar. There is no Back to page button: where translation mode works (a
  record, a list or a dashboard: `translatesOn`) the window's ✕ (`winClose`) goes back to the page, as Alt+1 does, and
  says so: its name and tooltip are "Back to page (Alt+1)", with `aria-keyshortcuts`, the way Undo and Redo name their
  keys. So it never closes the translator from there (the bar's ✕ does); on any other page it is "Close" and closes
  the translator. `shell.hide()` keeps the window and its minimized pill out of the way in translation mode.
  - As the window narrows, container queries (ui/styles.css) collapse the title bar step by step (a text they hide is
    hidden visually only, so screen readers still read it): below 670 px the language names become their codes, below
    600 the title goes, below 520 the org name becomes a dot, below 400 the language button's globe goes, below 360
    only the target language's code stays, below 320 the logo goes. The docked window is 440 px wide at first
    (resizable by its left edge, at least 360 px), so it then shows the codes, the dot and the globe.
* App hooks: `load(scope, {onProgress, signal, onError})` → count; `review(filter?)` → the Publish dialog,
  resolves with the last run's report; `refreshPage()` → cache clear and reload (ui/refresh.ts);
  `showDynamicsIn(lcid)` → the user's language set for good, then the same refresh;
  `edit(comp)` → the popup in translation mode, the cell in the Workbench, else the full editor card in a
  dialog; `langMenu(anchor)`; events on `root.host`: `dxt-prefs`, `dxt-lang` (language temporarily
  switched), `dxt-close`.
* Closing (bar ✕; the window's ✕ where there is no page to go back to): with staged changes it asks "You have N
  unpublished changes." Publish / Discard / Keep editing. `beforeunload` shows the browser's prompt while a save runs
  or changes are staged.
* Keyboard: Ctrl+S Review and publish (in the Workbench with its result line), Ctrl+Z / Ctrl+Y (also Ctrl+Shift+Z),
  Ctrl+F filter rows (Workbench), Alt+1/Alt+2 page / Workbench, Esc closes the topmost layer.
* **Undo and redo** (ui/undo.ts `bindUndo`, on the app layer and, in translation mode, on the page):
  - In a text box of the translator (popup, editor card, cell editor, search and filter boxes, dialogs), Ctrl+Z, Ctrl+Y,
    Ctrl+Shift+Z and the context menu's Undo undo and redo what was typed in that box only. A run of typing or
    deleting at the caret is one step, and so is an IME composition (at most 100 steps a box). The inputs of the popup
    and of the editor card keep their history when they re-render (a `data-us` root, matched by `data-k`). Script
    changes meant as edits are steps: `insertText` for the grid's cleaned paste and Alt+Enter, `resetUndo(from)` for
    typing into a cell. Any other script change (Undo changes, a search cleared with Esc, a reload) is undone first by
    the next Ctrl+Z. The keys go by the letter, and by the key's place (`e.code`) only for a letter of a script without
    Latin letters: BÉPO's Ctrl+à, a dead key or Dvorak's Ctrl+; is not undo; never with Alt (AltGr) or while composing.
  - A box with nothing typed in it yet asks its `whenEmpty`: a popup or editor card input reopened on a staged text goes
    back to the server text (the edit is unstaged) and Ctrl+Y stages it again; the Workbench's cell editor closes and
    undoes or redoes the workbook's last change (§5.5).
  - The browser's own undo never runs in the translator. Chromium keeps one undo stack for the whole page: past a box's
    own steps, or after a popup re-render, its Ctrl+Z goes on to the page's previous edit, Dynamics fields included, and
    moves the focus there. The context menu's Undo, which Chromium sends to the box holding the page's last step, steps the
    focused box instead; its Redo stays greyed (the browser enables it from its own stack, which these keys never feed).
    Known limit: while a translator box with typed steps stays in the page (the hidden Workbench's filter, the open
    sheet's search), Ctrl+Z in a Dynamics field can't reach that field's older steps.
  - Elsewhere in the translator (the popup's buttons, the bar, the All labels sheet, the Workbench grid) and outside
    dialogs, the keys undo and redo the staged edits (Store); never while a save runs. In a dialog, or in a control that
    keeps the keys (`ownsKeys`, below: a select, a read-only box), nothing happens.
  - On the page in translation mode they undo and redo the staged edits whenever there is a step to take, wherever the
    focus is (the body; the Dynamics button Done gave it back to, such as the stage flyout's close button, LIVE-FINDINGS
    93; a link, a tab, a menu item, a checkbox), except in a control that keeps the keys (`ownsKeys`), which is left
    alone with its own undo: an input that holds text (number, date and time too), a textarea, a select, editable
    content, an element whose role (its first token) is textbox, searchbox, combobox, spinbutton or slider, or anything
    in a grid cell whose editor is open (a text input, select, combobox or editable content in the cell: the cell
    itself, a lookup's or a date's button). The focus is followed through open shadow roots. A checkbox, a radio button
    or a range has no undo of its own, and leaving the key there would let Chromium's undo revert the page's last text
    edit wherever it was. Never while a dialog is open or a save runs, and never a key Dynamics already handled.
    The marks, the bar's count and an open popup follow the Store.
  - The Store's steps: a run of typing in one text (the same label and language, each edit within 1.2 s of the last) is
    one step; a run that ends on the text it began from leaves none, so the next Ctrl+Z undoes the step before it.
  - A popup closed with the focus in it (Done, or its secondary action when that left the focus on the body) gives the
    focus back to what had it before (a label reached with F2, a list row, the bar), never to a Dynamics text field
    the user had clicked before the label (a label click doesn't move the focus): there Ctrl+Z would undo the field's
    typing, not the staged edit (ui/callout.ts `giveBack`). An item of the lists the page is switched with, reached with
    F2, has left with its list by then: Done, Enter or Esc gives the focus to the button that opens that list
    (`CalloutHost.refocus`, §5.4).

### 5.2 Editor card (ui/editor.ts) — used by both views
For one component (`comp`): header (kind icon, title, path breadcrumb, logical name, each read-only reason once with a
lock, `MANAGED` for a managed solution's component, "Used by N columns" for global choices), then for each prop
(Display name, Description, …) a block with one row per shown language: language chip (base marked), input (textarea
auto-grow for Description/tooltips, input otherwise, `dir=rtl` for ar/he), char counter when near max, status dot,
revert button when edited, and for non-base languages "Copy from base". Inline validation messages. An emptied
translation says what saving does under its input: "Will be removed when you save." where Dataverse can remove it;
where it can't, its stand-in (§4, "Clearing a translation"; `becomesText`, `Store.standIn`) as a note, "Becomes
“Project site”: Dataverse can't remove a translation here, so French gets the English text." (a field: "…gets the
column's French name."), and the input has no placeholder; without a stand-in, the reason in red (`noStandIn`). An
emptied metadata description says "Saved empty: French users see no tooltip." (`savedEmptyText`, §4 "Saved empty"),
with the placeholder "No French tooltip"; one stored empty is not amber, and one missing says "Shows “…”".
Conflicts show both values with "Keep mine" / "Use theirs". It opens with the caret at the end of the input in the
language the page is shown in (as the popup, §5.4), else the first editable input; a language asked for (Fix) wins.
In translation mode it is only the fallback when a popup can't be built; the popup (§5.4) is the editor there.

### 5.3 Publish dialog (ui/review.ts) and refresh (ui/refresh.ts)
One dialog for the bar's "Review and publish", Ctrl+S and the Workbench's Save and Publish: "Publish N
changes", rows grouped per component text ("title · what · where"; where is the label's place as the user sees it
(`whereOf`): a form label's "Account (Main form) › Summary › Details", a navigation item's "App › Area › Group", a process
step's "Process › Stage", a choice's "Table › Column", a global choice option's choice, the table of a column, view,
chart, form, process, command, relationship or classic button; what a form cell's own label is called is "Form label",
the field popup's word (`WORD.field`), and `(everywhere)` follows Tooltip and Column name, as the field popup says; a
merged entry "Form · N places (tabs)" for the same edit of every copy of a field), one line per changed
language with a word diff and Undo. The rows are one renderer from plain data (`changeGroup`: title, what, where,
language, before, after, tone, last column, notes; each header a heading), shared by the Publish dialog, Recent publishes
and its Undo. Blocking problems (base blank, too long, read-only, an emptied translation without a stand-in, with the
saver's reason) are red on the row and skipped (they stay staged); open conflicts are skipped until Keep mine /
Use theirs. An emptied translation Dataverse can't remove shows the stand-in Publish writes (`planPublish` →
`Plan.written`, from `asWritten`: `SaverApi.prepare` of the changes Publish sends, open conflicts left out, so a
stand-in is never made of a staged text that isn't published with it) as its after text, with a quiet note
(`standInTag`): "English text: Dataverse can't remove a translation" or "The column's French name: Dataverse can't
remove a translation"; one that is the text already: "Already the English text: nothing changes". An emptied
metadata description goes to "(empty)" with the note "Saved empty: French users see no tooltip." (`emptyNote`; its old
side "Shows “…”" or "(no translation)" where the language had no label at all, `ChangeRow.blankBefore`). The result's
rows show it the same way, as Try again would write it. A row whose server text a reload changed since it was edited
(`Store.moved`: each edit keeps the server text it was made on as its base, which is `Change.before`) says "Changed on
the server since you edited it": publishing it stops at a conflict, never overwrites. The saver's warnings are amber lines on their rows,
and its general notes show once under the subtitle (§4.7 step 1). Other unpublished work on the tables is one sentence
next to Publish, which waits for that check, and what the publish covers a second line beside it (`scopeText`, §4.7). Cancel / **Publish** (Ctrl+Enter). Then steps in the
same dialog: Saving N changes (x of N), Publishing <names>, Checking (forms really published), and in
translation mode Refreshing the page. Success in translation mode: "Done. Refreshing the page…" and
`app.refreshPage()`; in the Workbench "Done. Published N changes." with Refresh page / Close. Failures: red
rows with the saver's message, Try again (failed rows only), Publish again (saved, publish failed), Refresh
anyway, Close; never an automatic refresh after a problem. A form the Checking step can't read (a failed read, or no
`versionnumber`) is never taken for published (`unpublishedForms` → `{left, unread}`). The dialog shows "Published, but
not checked" and "Couldn't check whether Main form is published. Publish again to publish it and check again.", offers
Publish again, and journals the save as not published. Recent publishes › Publish does the same, with Try again. The
check covers forms only: other components rely on the saver's read-back and PublishXml's answer. Rows found already on
the server that no write of this translator may have put there (`ChangeResult.found`) are counted apart in the Done
line, as their publish's Undo leaves them alone (§4.7 step 5).
"Recent publishes" (history: this user's publishes in this environment and browser, 90 days): one row per publish (time,
label count and titles, Not published / Undone badges, Publish, Undo; a publish that only named sitemap items has no Undo,
and a line under its row says why, §4). Its time and titles are a disclosure button (in an h4, `aria-expanded`, `aria-controls`) that opens in place, built on first open, what the publish changed in the Publish
dialog's rows (`entryGroups`: one group per label under the title and place the dialog showed, kept in the journal as
`HistoryItem.title` and `where`; the copies of a field as one group with their places; an entry journaled before places
were kept, or kept without them for its size (§4.7 step 5), shows title and what only). **Undo** asks first ("Undo this
publish?", same rows): it reads each label's text on the server now (`SaverApi.current` → each writer's `read()`, the
read its save makes before writing, writing nothing; form tab and section labels of another language through the usual
language switch; a metadata read still behind this page's own last write of the label is read again for up to 15 s, as
the save waits, and never shown as the text from before that write) and shows current text → the text it goes back to
(`undoRows`, measured as the undo measures it: `SaverApi.prepare` as an undo, with the texts just read): plain (it goes
back); for a translation the publish added that Dataverse can't remove, current text → its stand-in with the same quiet
note as in the Publish dialog (`UndoRow.standIn`, §4 "Clearing a translation"); a description stored empty before the
publish, current text → "(empty)" with "Saved empty: French users see no tooltip." (`UndoRow.empty`); "Already as
before" (also where the stand-in is there already; never for a description the publish saved empty where it had no
translation, which goes to its stand-in); "Changed since this publish: not undone unless you choose Undo anyway"
(amber, an Undo anyway checkbox, unticked); "Stays: Dataverse can't remove it, and its English text is empty" (only
for such a translation without a stand-in, with why); "Stays: naming a group can't be undone" (`namings`, §4; never
read); a read-only refusal; "Not loaded here…" (its component isn't loaded) or, for a label whose stand-in is made of
texts that aren't loaded, what to load ("Its column's names aren't loaded here: load its table's columns, then undo
again"); or "Couldn't read its current text (…). The undo checks it again before writing" (also a label gone from its
form, sitemap, process or choice, or a metadata read still behind). The labels changed since come first; one sentence
counts the states ("1 translation this publish added gets the English text in its place: Dataverse can't remove it.",
in the words of `standInsSaid`; "1 label can't be undone until the texts put in its place are loaded."); the
others'-work sentence and the publish scope sit next to the button. Nothing is written before **Undo N changes** (N:
labels to undo, a stand-in's among them, unread ones and those chosen; disabled at 0); when every label is already as
before or stays it reads **Mark as undone**, which writes no label but publishes like any undo (a label found already
as asked may be an earlier write not yet published, §4.7 step 4). Cancel leaves everything. Undo's safety is
unchanged: each label is written only where the server still holds the text the publish wrote, and a label someone
changed since is a conflict, left as it is; one chosen with Undo anyway is measured against the text just read
instead, so a text changed again after that read is still a conflict, never overwritten. The result shows each label's
outcome in the same rows (Undone; Already as before; Changed since this publish, so it was left as it is; Stays:
Dataverse can't remove it, with why; the saver's message), a stand-in written shown as the text written with its quiet
note, Fix on conflicts and failures, a one-line count, Try again, Redo, Refresh page. A held-back label (its stand-in
waits for a text to be loaded) is neither "stays" nor counted for **Mark as undone**, and the publish stays undoable
(§4).
`refreshPage()`: asks when changes are still staged and when the record has unsaved changes or may have
(core/context.ts `recordDirty`, below), tears the app down, shows "Refreshing the page…", restores the user's language
(waiting at most 3 s for it; the switch window is not held through the reload, so a switch another tab starts then, or
one a closed tab left in doubt that may still run after those 3 s, can boot the page in that language until the next
refresh), stores `dxt:verify:<orgId>` (what was published), purges and reloads. The next start checks the page shows
it (app.ts `verifyAfterLoad`) and speaks only when it doesn't: "N changes aren't showing yet" with Refresh again
(refresh.ts `notShowing`); a page that shows every change says nothing, as the page itself shows them. The purge
(`purge()`, finding 82; every step guarded and raced against a timeout, the reload always happens): the service
worker's commands (`postMessage({name})`: PurgeUserContextGcmCacheEntry, PurgeUserSettingsCollectionDataCacheEntry,
PurgeGcmCache, PurgeDataCache, PurgeMainAspxCache; to the controller, else the registration's active worker), every
CacheStorage cache except the code caches (`CDN_Resources`, `clientsdk`, `WebResources`, `sw-feature-status`;
`mainaspx` goes), `clearState` to the `uci-state-persistence` SharedWorker, the localStorage keys `uci-state*`,
`Form:*`, `ActualControls/*` and `UCI_RESOURCE_STRINGS` (never `dxt:*`), the metadata stores of the IndexedDB named by
the origin (usercontext, entitymetadata, attributemetadata, applicationmetadata, metadataversionstamp, navigationdata,
userpersonalization, `temp*`; never offline records, never the database: one that doesn't exist is not created),
sessionStorage. The reload (`reloadFresh()`) loads the same main.aspx URL with
`flags=FCB.PersistReduxStore=false,FCB.PersistReduxStoreV2=false` merged into its flags, so it boots from the server
instead of a persisted state.
**Unsaved changes on the record** (core/context.ts `recordDirty`): yes or no from the form's own
`Xrm.Page.data.getIsDirty()`, else from its entity's (`data.entity.getIsDirty()`, the documented formContext call);
no on a page without a record (no client API, a page context of another page type, no form data or form data without
a record: a list, a dashboard); unknown (null) where there is a record but neither answers yes or no (the call throws,
answers something else, or doesn't exist). The refresh asks on yes ("This record has unsaved changes. Refresh anyway
and lose them?") and on unknown ("This record may have unsaved changes. …"): the reload would lose whatever the record
holds unsaved. The Xrm it asks is `ctx.xrm`, read live through `findXrm`: this window's, else a same-origin frame's; a
frame of another site (an embedded page) can't be looked into and is skipped, never the end of the search.
**Show Dynamics in <language>** (bar ⋯ and Workbench More, every provisioned language but the one on screen: that
is `<html lang>`, not `ctx.user`, which after a change made elsewhere already says the new one, finding 78): refused
while a save runs, the language is switched for a moment, or a switch whose answer was lost may still run (§4.3); the
same questions as the refresh; then
`LangSession.adoptLanguage` (under the language lock and the exclusive switch window) runs core/uilang
`setUiLanguage` (PATCH `uilanguageid` + `helplanguageid`, the locale untouched; read back with `Consistency:
Strong` until it shows) and makes it the session's own language, dropping the repair marker, so nothing switches
the user back; then the refresh. A reload still on the page after 8 s (`STAYED`: "Leave site?" answered Stay)
drops its note.

### 5.4 Translation mode v3 (inspector/*, ui/callout.ts, ui/bar.ts)
The user clicks the text of any highlighted label on the page and translates it in a small popup next to it. Edits are
staged; one "Review and publish" saves, publishes and refreshes. Contracts: `inspector/types.ts`.
* **Marks** (inspector/overlay.ts, own shadow host on <html>): a rounded tinted box that hugs the label's own text
  only (one box per line box, from Range rects of the anchor's text node; never around containers, sections or
  headers). Blue dashed = translated, amber dashed = missing in the target language, green solid, 2 px = changed
  (staged), red = a publish failed for it, grey dotted = can't be translated here: built-in Microsoft text or a
  read-only label (below; a click opens its popup, which says why), none = not loaded (no hover, no pointer, clicks
  reach the page). Hover follows the text only (Clicking a label, below): with the pointer on a label's marks (2 px
  slack, `onText`) or on its drawn pencil, a 2 px border, a pencil badge after its last mark (none on grey marks, and
  none on the label of a selector's own button, where it would lie over the chevron that opens the list and take its
  click: the ring alone says the name can be clicked) and the pointer cursor; beside the text, in the rest of its
  zone, none of these. The pencil is part of the hover: the
  pointer can go from the text onto it and click it. The open popup keeps both. A label found from the list pulses
  (three rings, ~1.8 s, overlay `pulse`; a still ring with reduced motion, no animation in forced colors).
  - Marks lie under the page's popups: the part of a mark, its ring included (4 px), that a Dynamics flyout, dropdown,
    callout, menu, tooltip or side pane covers is cut away (a CSS clip-path); a piece thinner than 4 px either way is
    not drawn. Popups are found by role (overlay.ts `LAYERS`) and, whatever their role, as what Fluent's portals paint
    (`PORTALS`: `#__fluentPortalMountNode`, which holds the header fields flyout (LIVE-FINDINGS 86), `.ms-Layer` and
    `[data-portal-node]`): in each portal, the outermost elements on screen that paint a background or a shadow.
    Wrappers without a box, transparent and hidden ones, and those at least 90% of the window both ways are looked
    through; a painted element that wide or high one way only is looked into first and counts itself when nothing in
    it paints. Breadth first, 8 levels deep, each portal root its share of the visits (at least 16; 128 a frame in
    all), so a large newer portal never hides an older one's flyout; paint, not hit tests.
  - Another tool's panel (another bookmarklet's window; overlay.ts `panels`: a child of <html> or <body> that holds no
    label, is no portal root and is not the translator's) covers the marks under it while it is on top: its outermost
    painted element not as large as the window counts as a whole (a frame or an image counts as painted, shadow roots
    are looked into), only where a hit test at its centre finds it on top of the page. Read every frame: such a panel
    comes and goes as it likes.
  - Labels inside a popup keep their marks; a label in a popup, a portal or the modal is under another popup only
    where a hit test finds that one (a dropdown opened from the header flyout lies over the flyout's labels). With a
    modal open, labels show only in it and in what lies over it; what a portal paints counts only where a hit test at
    its centre finds it over the modal (a flyout left open behind a modal shows nothing).
  - The pencil and the pills are never drawn over a popup that doesn't hold the label (decided in the frame's read
    phase, so an option of a dropdown opened over the header flyout keeps its pencil). A label loses its place (the
    popup docks) only when nothing of it shows. The translator's own popup, list sheet and bar are above every mark
    (z-index 2147483646 over 2147483645).
* **What gets a mark** (the rule): a mark only on text that NAMES something in the app: a field, a column header, a
  tab, a section, a related item, a control's title (sub-grid, quick view, timeline, web resource), a navigation
  entry, a command or button, the view, form, table, app, process, stage or step name, or a choice value. Translatable
  ones get the status colours. Grey only when the text is positively identified as one that can't be translated here:
  (a) a loaded slot that is read-only (from a managed solution, not customizable, renaming locked or turned off,
  Microsoft's own sitemap label; the popup gives the reason in plain words, principle 11, §4.1 and §4.4), or (b)
  Microsoft's language-pack text recognised by a fixed id (Built-in, below). Never by elimination: an unrecognised
  text stays unmarked, never called built-in. Not loaded = no mark, and never a passing grey mark while the real one
  loads. No mark ever on text that names nothing: messages and notifications, statuses ("- Saved", "Active for 48
  hours"), counts and paging ("0 - 0 of 0", "Rows: 0", "Page 1"), placeholders and search boxes ("Enter a note…"),
  empty states ("Get started", "No data available", "We didn't find anything to show here"), record data (title,
  values, owner, avatars, what Recent and Pinned list), the product name, and a control's own affordances ("Select
  all", sort and filter menus). A locked form cell or related menu item without a text in the target language shows
  its column's name or its relationship's text there (LIVE-FINDINGS 42, 80): where that text can be edited (its popup
  offers it), the label looks as that text does, not grey (status.ts `look`). An app designer's placeholder in the
  navigation (§4.4) is amber until it has a name: every language is missing, the base one included.
* **Changed choices** (inspector/pill.ts): a choice column's other choices are not on the page, so a staged (or failed)
  edit of one would be invisible until the dropdown is opened. A form, header, process-step or quick view field whose
  column has pending choices gets a small pill after its shown value ("1 choice changed", green; "N choices not
  published", red), else after its label; the count alone when the words don't fit, never over another mark or
  outside the field; none in grids, open lists, read-only fields or with Alt. It takes no pointer events (the page
  keeps hover and the wheel), but a click on it opens its label's popup, whose "Choices (N) · 1 changed" list then
  opens by itself.
* **Built-in Microsoft text** (finding 65, look `builtin`): language-pack text shown in every installed language,
  so there is nothing to translate. Anchors with comp `builtin|<what>` and no slot (scan.ts `builtin`), each
  recognised by a fixed id:
  - a related menu item `nav<Name>` without a form XML entry, once the form XML is loaded (a form can list and rename
    one; never `navActivities`/`navSPDocuments`: tables' plural names), also as the tab of the view it opened
    (`tablist-nav<Name>`, e.g. `builtin|nav|navConnections`); the record form's Related tab (finding 79; a click only
    opens its popup, like a menu item);
  - Home, Recent and Pinned at the top of the navigation (`sitemap-entity-(Home|Recent|Pinned)_<guid>`, not inside
    another entry; role nav, Open performs their click; what Recent and Pinned list is never marked);
  - commands: a classic `Mscrm.*` button without a `$LocLabels:` id, a classic button whose label is a `$Resources:`
    token, and a button on a command bar (`[data-lp-id^="commandbar-"]`, `[data-id="CommandBar"]`, `#CommandBar`) whose
    plain id (no dot, no `!`) no ribbondiff of its table defines, unless named after its table (next bullet); none of
    these before the table's customized buttons are known. A button Dynamics adds to a command bar without a ribbon id
    (`button[role=menuitem]` without a `<table>|…` data-id, "Show Chart", LIVE-FINDINGS 89; comp
    `builtin|command|<its id, else its data-id>`). Never a flyout's item (those can list records: reports, templates,
    flows) and never a view selector;
  - "Form assist" (`button[data-id="FormFillBar_Show_Button"]`, the id on earlier builds) and "Share"
    (`button#collaborationShareButton_<n>`, every render one label `builtin|command|collaborationShareButton`), role
    command (LIVE-FINDINGS 90); an icon without text gets no mark;
  - the open stage flyout's buttons, by their label's id (`MscrmControls.Containers.ProcessStageControl-Next Stage`,
    `…-Previous Stage`, `…-Set Active`, `…-Close`, `…-Finish`; `builtin|stage|<name>`, LIVE-FINDINGS 92): the button
    is the zone, so a click on its text opens the popup and one beside it does nothing: a click never moves the
    process (Alt+click does).

  Also a read-only slot with text in every language (status.ts `readOnlyLook`, e.g. the plural name of a system table
  whose renaming Microsoft locks, such as category's "Catégories" in the navigation), but never one from a managed
  solution: `MANAGED` is always `ro`, "Read-only" in lists, whatever languages it has. A built-in anchor's click opens
  a popup with the title and one line (describe.ts `BUILTIN_NOTE`), no inputs; a read-only slot's popup has its reason
  with a lock at the top (`CalloutModel.readOnly`) and its texts in disabled inputs. Done, Esc, Enter and a click
  outside close it; Alt+click uses the page. Ours stays translatable: a nav item with a form XML entry, custom
  commands and LocLabels buttons, as long as they are not from a managed solution.
* **Built-in commands named after their table** (scan.ts `command`, `namedBy`; parts.ts `namePart`): UCI builds some
  of Microsoft's command labels around their table's name (`$Resources(EntityDisplayName):`,
  `$Resources(EntityPluralDisplayName):`, `{0}` being that name; read from UCI's code): a sub-grid's New and Add
  Existing, and Export ("New Person", "Add Existing Person", "Export People", LIVE-FINDINGS 89). Such a command is one
  whose label, known from a customization of its table, has that form (then only the name it refers to: display or
  plural), or else a `Mscrm.SubGrid|Form|HomepageGrid.<table>.…` id of those kinds (`…AddNew…`, `…AddExisting…`,
  `…Export…`, `NAMED_CMD`: either name). Its own table's display or plural name as shown in the user's language (that
  language's name, else the base one), found in its text as a whole word in any case (the longest found wins; the Name
  where both read the same), is a part of the button's text (`Anchor.part`; the rest is language-pack text and stays
  unmarked), anchored to `entity|<table>` with role command: the button is the zone (a click on the name opens the
  popup, one beside it in the button does nothing, Alt+click runs the command), and it looks as that name does (blue,
  amber, green), not grey. The table comes from the command id, the button's data-id (`<table>|…`) and its bar's
  `data-lp-id` (`commandbar-<bar>:<table>`): when they name different tables the button is grey, never another table's
  names. Its popup: kind Button, the button's text as the title, one line (describe.ts `TABLE_COMMAND_NOTE`: Microsoft
  builds the text from the table's name, so translate the name; the button and every other place that shows it
  follow), then the table's Name and Plural name, the one shown focused. Where neither name can be translated here (a
  managed solution's table, as most are) the line is `TABLE_COMMAND_WHY` alone, why the button shows the table's
  names, and the lock line says why not. From "All labels" the same component is the table (Name + Plural name). The
  table's names are read on demand (`#names|`) for these commands only: until then such a button has no mark (never a
  passing grey one); it is grey once that read failed, or where its text shows neither name. Any other built-in
  command is grey at once, also where a word of its text is its table's name ("Resolve Case" on cases, "Email a Link"
  on emails, "Show Chart" on a table named Chart), and so is a button Dynamics adds without a ribbon id.
* **Clicking a label** (inspector/overlay.ts `decide`, `pointed`, `onText`, `acts`, `effect`, `nested`, `pickPart`;
  capture phase, primary button only, never wheel, scroll or keys): only the text is the label. A click on a label's
  marks (the line boxes of its text, 2 px slack: `onText`) or on its drawn pencil opens its popup and does nothing else:
  tabs, navigation, commands, stages, column headers and values only open the popup (mode.ts `clickLabel`). A press on
  the text released a few px beside it, still inside the zone of the label it started on (a hand that moved), opens it
  too; released outside that zone, nothing opens. Beside the text, in the label's zone (`zone ?? el`, never `hit`),
  zones further out are looked at for a label whose text is at the point (an outer label's text over an inner zone);
  when none has it:
  - In a zone that acts, the gesture is swallowed and nothing opens, so a near miss never runs a command: a zone whose
    label is a tab, a navigation entry, a command, a process stage, a column header or a list option (`ACTIVE`), a
    zone that holds a form control (a closed choice or Yes/No control), or anything that acts on the event's path
    (`acts`: a link, a button, a select, a summary, an input that is not a text box, a role such as button, link, tab,
    menuitem, option, treeitem, columnheader, checkbox, radio, switch or combobox, or a `<label>` whose control acts:
    a checkbox, a switch, a select).
  - Except where all that acts on the path only opens or closes something, or picks from a list the user opened
    (`effect` 'toggle' or 'pick', `harmless`): there the page gets the click, as without the translator, whatever
    the zone's label is.
    - In the app's navigation (inside `[data-id="navbar-container"]`, `[role="tree"]`, a `sitemap-…` entry or the area
      switcher), what only opens or closes: anything there with `aria-expanded` (a group's header and its chevron,
      Recent, Pinned, the ☰ button that collapses the navigation), never a link, and the area switcher (it opens the
      list of areas). Beside a group's title the group opens or closes. A tree entry around such a toggle is the entry
      it opens; an entry that navigates (a site map item) lies in its group's list, under no toggle, so a near miss on
      it is still swallowed.
    - A button that opens one of the lists the page is switched with (lists.ts `OPENER`: the area switcher, the form
      selector, a view selector that says it opens a popup): beside its text (its chevron, its padding) the list opens.
    - An item of such a list while it is open (`ITEM` in `LIST`: an area, a form, a view): beside its text it is
      picked, which is what the user opened the list for. Only in those three lists: every other menu (a command's)
      still acts, and a near miss there is swallowed.
  - Elsewhere (a field label's container, a section header) the click goes to the page.
  - A text box or a grid column's resize handle in a zone keeps working (`passes`), and the entries a navigation entry
    lists under it (Recent's and Pinned's records, another tree entry) are not that entry's zone (`nested`).
  - A label with no mark this frame (not measured yet, or none of its lines drawn, as when it is partly scrolled out
    of its container) keeps its whole zone, so it stays reachable; only in a zone of one label.

  A whole gesture belongs to a label, to nothing (swallowed) or to the page, decided at the press, so Dynamics never
  sees half of one; a double-click goes with the clicks it follows. Touch events of a gesture taken over are stopped,
  never canceled. Hold **Alt** to use the page as usual, everywhere. The popup's secondary button acts on the page
  (see Popup). F2 on a focused label opens it too (the keyboard has no position: the whole zone counts, in a zone of
  parts the first one); keyboard activation (Enter or Space on a focused tab or button, a click with `detail` 0)
  reaches the page. Clicks never change record data.

  **Right after a navigation** (mode.ts `onLabel`, `sameLabel`; scan.ts `gridTable`). UCI draws the next page's labels
  before the page tracker sees the navigation (`navSoon`, 350 ms after the address changes, else the 1 s tick), and a
  label scanned meanwhile was matched against the previous page's index: on a list, the previous table's column of the
  same name. So a click or F2 on a label reads the page first (`navigate()`, as the tick does). When the page changed,
  translation mode starts over for it (a new index and a new scan), and the popup opens for the label that scan finds
  on the same element, with the same role and the same part of its text; where it finds none, nothing opens. Never a
  popup for the previous page's table. On a page that didn't change it opens as before. And on a list page, a grid
  whose `data-lp-id` names another table than the page's (the next page's grid, drawn before the index follows) maps
  none of its headers or cells to the page's table.
* **Popup** (ui/callout.ts, content from inspector/describe.ts): a kind word and the title; one block per text (Form
  label, Tooltip, Column name, Label, Name, Plural name…) with one plain input per shown language, the base language
  first, then the target. It opens with the caret at the end of its first text's input in the language the page is
  shown in (`<html lang>`, else the user's Dynamics language: core/uilang.ts `shownLanguage`), not the target: on an
  English page the English text, on a French one the French text. Where that input is disabled or not shown (that
  language not loaded), the caret goes to that text's first input that takes typing, else the first input that takes
  typing. The first text is the first block that takes typing: the clicked text's, except in a field's popup, whose
  Form label it is (below). A label or language passed in by what opened the popup (a choice value, Fix:
  `focusKey`, `focusLcid`) wins; a choice list without a column for that language falls back to the target's. A pending
  choice takes the caret only in a popup without a column's name: in a field's or a column header's the Choices list
  still opens by itself, and the caret goes to the first text (a column header's: its name). Tab order is the inputs'
  order. The clicked text's block comes first, except in a field's popup.
  - A **field** (a column's form cell) shows Form label (its form cell) + Tooltip (the column Description, finding
    43) + Column name (the column's DisplayName), always in that order, whichever text was clicked (describe.ts
    `field`; `clickedFirst` keeps it). Each heading is followed by where it applies (describe.ts `FIELD_NOTES`): "this
    form only, shown instead of the column name" (a quick view form's cell: "this quick view (on every form that shows
    it), instead of the column name"), "everywhere", "everywhere: views, search and forms without a form label". A
    form label is the form's own text, often a copy of the column's name that the form designer saved when the field
    was added; it does not follow a later change to the column's name. So the Column name changes views, search and
    the forms without a label of their own, and what a form shows changes with its Form label.
  - It always opens on the Form label, the text the page shows, whether or not the form has a label of its own (while
    it is empty, its placeholder `Shows “<column name>”` says what the page shows instead, below); the Column name
    takes the caret only where the Form label can't be typed in (read-only: a form from a managed solution, with an
    unmanaged column on it). Earlier builds opened on the Form label only where the form had one in the page's
    language (`clickedKeys`), or always on the Column name. The rule, `focusKeys` (focusInitial then takes each key's
    input in the page's language, else its first one that takes typing; a disabled input is never one):

    ```ts
    // focusKeys, in src/ui/callout.ts
    export function focusKeys(store: Pick<Store, 'get'>, blocks: readonly Block[]): string[] {
      for (const b of blocks) {
        const s = store.get(b.key);
        if (s?.kind !== 'field' || s.prop !== 'Label') continue;
        const ck = fallbackKey(s);
        return ck && blocks.some((x) => x.key === ck) ? [s.key, ck] : [];
      }
      return [];
    }
    ```
  - When the column is on the form more than once, "Also change the other copy/N other copies of this field on this
    form" (ticked when every copy has the same text; it never writes a read-only copy, nor one of a managed form:
    callout.ts `writeAlso`, describe.ts `duplicates`); the Publish dialog shows the same edit of every copy as one
    entry, "N places (tabs)", with one Undo, while the title, the bar, the progress and Done count every copy.
  - **Opening without a jump** (callout.ts `settle`, `STEADY`, `WAIT_MAX`; `.co.is-wait` in callout.css). The popup is
    laid out, filled and focused while invisible (opacity 0, no pointer events, no animation), placed again each
    frame, and shows once its place has held for two frames in a row. While the label it opened at is gone (`lost`) it
    waits: an option of Dynamics' open dropdown list leaves with the list, which closes as the popup takes the focus,
    and the host points the popup at the field a moment later (the page's changes are read 90 ms apart,
    inspector/overlay.ts), so it shows once, at the field, never at the option first. After 300 ms it shows wherever
    it is. It then fades in (0.12 s) coming out of its label: down under it, up over it, sideways beside a row of the
    list sheet (`co-in`, `--co-dx`, `--co-dy`); with reduced motion it just appears. Verified live on a development
    environment: the Phase dropdown's *Review* option opens the popup once, under the field.

    ```ts
    // settle, in src/ui/callout.ts
    export function settle(held: number, same: boolean, lost: boolean, waited: number): { held: number; show: boolean } {
      const n = same && !lost ? held + 1 : 0;
      return { held: n, show: n >= STEADY || waited >= WAIT_MAX };
    }
    ```
  - **Keeping its side** (`placeCallout`'s `side`, `STICK`). While it opens, its side is decided afresh each frame;
    once shown, a popup below (or above) its label stays there while it lacks at most 48 px of room there (its body
    scrolls that much), and, while it fits on neither side, until the other side has more than 48 px more room. A
    scroll that moves the label, or a message that grows the popup under an input, no longer flips it to the other
    side and back.

  Choice columns have a closed "Choices (N)" disclosure (open when opened from a choice value; "Shared by N columns"
  for a global choice). A classic button's blocks (Label, Tooltip title, Tooltip text) say where else their LocLabel
  shows (describe.ts `sharedNote`, from the page loader's button map, RetrieveEntityRibbon §4.6): "also on N other
  buttons" (other controls of the table whose label, tooltip or accessibility text names it), "on N buttons" when
  opened from the list, "every table's command bar" for an application ribbon label. One save changes it everywhere.
  Amber input = missing, green = changed, red line only for blocking problems; a read-only text has its inputs
  disabled and its reason on a line with a lock, at the top of the popup when nothing in it can be edited (a managed
  column's field on a managed form: every input locked, `MANAGED` at the top); the placeholder says what users of that
  language see now (`Shows “X”`; for a cell the column's name in that language, else its base-language name, finding
  42: callout.ts `shows`); a metadata description's says "No French tooltip" ("No French description", `noneText`)
  only where its users see none (stored empty, emptied here, or no base text either), and a missing one "Shows “…”"
  with the base text. A translation emptied where Dataverse can't remove it has no placeholder (what the page
  shows now may not be what it becomes: a stage name Dynamics keeps); a muted line under its input with an info icon
  (`becomes`, `.co-m.is-note`) says what saving writes in its place, "Becomes “Start date”: Dataverse can't remove a
  translation here, so French gets the English text." (a field: "…gets the column's French name."; one that is that
  text already: "Already the English text: Dataverse can't remove a translation here, so nothing changes."), announced
  to screen readers as a problem is. The input and the mark are green, as for any change. Without a stand-in,
  `problem()` gives the reason in red (`noStandIn`, §4 "Clearing a translation"). An emptied metadata description has
  no problem: `becomes` says "Saved empty: French users see no tooltip." (only where there was a text to empty). A
  placeholder's popup (an Area, Group or SubArea `ref.placeholder` with no saved title) has the page's own text as its
  title and as the user-language input's placeholder ("Shows “Nouveau groupe”"; never a staged text), the Title block
  in each shown language, and one line
  (describe.ts `unnamedNote`): "This group has no name of its own: Dynamics shows the app designer's placeholder. Name
  it in each language; other languages will show the English name until you translate them." From the list its title
  is "Unnamed group". Footer: a secondary button only where pressing it does something (describe.ts `actionFor`,
  mode.ts `runAction`; none for a popup opened from the list without a label on the page), then Undo changes,
  **Done**:
  - **Open**: a related menu item, or the tab of the view it opened, opens that view through
    `Xrm.Page.ui.navigation.items.get(<nav id>).setFocus()` (mode.ts `focusNav`), which needs no element: the related
    menu closes as soon as the popup is used (LIVE-FINDINGS 87); else a click on the item while it is on the page. Not
    offered on the tab of the view already shown. A left-nav sitemap entry, Home / Recent / Pinned and the Related tab
    open by a click like the user's. An area, form or view of the lists the page is switched with switches to it
    (below, The lists the page is switched with), unless it is the current one. Not offered for any other label in a
    menu or flyout (describe.ts `TRANSIENT`), which closes as soon as the popup is used.
  - **Change area**, **Change form**, **Change view**: the label on the button that opens that list (describe.ts
    `listAction`, in place of its kind's action): the popup closes and the list opens.
  - **Show stage**: a stage that has steps (describe.ts `hasSteps`: a step of the same process whose `ref.stageId` is
    the stage's id; a step whose stage the definition doesn't give counts for every stage): a click on its chip. When
    its flyout is open already (reveal.ts `stageFlyout`) nothing is clicked (that would close it) and the popup just
    closes.
  - **Show tab**: a tab or "More tabs" item that isn't the one shown (`aria-selected`): the page form's tabs through
    the tab API, which needs no element (it works after the flyout has closed); a side pane's tab, or one the API
    can't show, by a click on it or on a copy of it in the same form.

  The button acts on the label the popup points at, else on the one it was offered for (gone with the menu that
  showed it), keeps what was typed (trimmed, as Done) and closes the popup; when nothing could be done the popup stays
  open with a muted line, "Couldn't do that from here. Alt+click it on the page." A popup whose label left with its
  menu or flyout stays where the label was instead of docking (mode.ts `restRect`), and a popup never moves while a
  pointer is pressed in it (callout.ts `pressed`), so the release lands on the button pressed. Enter (Shift+Enter: a
  new line in a tooltip), Esc and a click outside are Done and keep the text, trimmed. No suggestions, warnings,
  scope notes or Edit link for the base text.
* **Bar** (ui/bar.ts): one status at a time: Loading translations…, Couldn't load some labels. (Try again),
  N changes (opens the Publish dialog), else the hint "Click any highlighted text to translate it. Orange =
  no French yet, green = changed, not published yet, grey = can't be translated here. Hold Alt to click normally." The
  language is a menu only with 3+ languages; ⋯ has Recent publishes, Refresh page, Show Dynamics in <each other
  language> (§5.3) and the version. Where it sits (right of Dynamics' left navigation, clear of the area switcher):
  §5.1.
* **All labels on this page** (inspector/pagelist.ts, pagelist.css): a 360 px sheet with search, All / Not translated
  / Changed, groups (Form, Choices, Command bar, Navigation, Process, Table and views) and "Not on screen right now
  (hidden fields, other tabs)" (a collapsed section; its count follows the search; during a search it is open unless
  the user collapses it), then "Changed on other pages" (below). Docked on the right edge by default; dragged by its
  header it floats over the page (below).
  - **Changed** lists every change of the page with the others, among the rows of its place, also one on a tab not
    shown or a hidden field (pagelist.ts `render`, `inline`): there is no "Not on screen right now" section under it,
    and a click on such a row still finds the label (below). All and Not translated keep that collapsed section. Not
    translated lists the rows whose look is missing: a description stored empty on purpose is translated, never in
    it (status.ts `look`, mode.ts `slotLook`, `Store.emptyOnPurpose`).
  - Design: 14 px for bands and labels, 13 px for second lines and the pages of changes made elsewhere, 12 px for
    kinds; no capitals, and no italics or icons in the rows. A group is a grey band across the sheet, pinned at the
    top of the list while its rows scroll by (`.pl-gh`: `position: sticky`, `--bg3`, a line above and below), holding
    one button (`.pl-gb`, 14 px semibold, at least 40 px high) with a chevron, its name in normal case and its count
    as a badge on the right. The collapsed section's summary is a white band of the same height that opens and closes
    it.
  - **Collapsing a group** (`group`, `toggle`): the band is a button (`.pl-gb`, `aria-expanded`) that collapses and
    expands its group with a click, Enter or Space; collapsed, the next band follows right under it. What the user
    collapses is kept until the translator closes (`SHUT`, per app: every sheet opened again shows it so). A search
    opens every group to show what it finds; a group collapsed during that search stays collapsed until the search is
    cleared, and then the choice made outside searches is back. The groups inside "Not on screen right now" are
    collapsed apart from the page's group of the same name (`HID_KEY`). The bands are keyboard stops with the rows
    (roving tabindex, arrow keys); Down from the search box goes to the first row, not to a band.
  - Search: every word typed, with case, accents, apostrophes and ligatures aside (core/search.ts `fold`, shared with
    the Workbench's Filter rows and Filter entities: "tele" finds Téléphone and Télécopie, "l'action" finds "Symbole
    de l’action"; also NFKD forms, ı ł ø đ ħ, a final ς, soft hyphens and zero-width characters). It looks in every
    language of the label (staged and as on the server), its names, its breadcrumb, its place and what its row shows.
  - No place captions: inside a group, the rows of one place stay together in page order (`cluster`, `runOf`), with
    no heading over them. The place (`whereOf`: a form's "Tab › Section", a quick view's cells starting with the quick
    view, Header, Footer, Related, a choice's column, a step's stage, a navigation item's group, a column's, a view's
    or a chart's table) is in the row's tooltip (its breadcrumb), in its `aria-description` and in what the search
    matches. A process stage heads its steps and a navigation group its items (`runOf`: their run is their own name),
    the way a section heads its fields.
  - Rows: two lines. The first is the base-language text (14 px) with a small grey tag on the right (`.pl-k`, one line,
    at most 45% of the row, then an ellipsis; `rowTag`): a choice value's column or global choice, which tells "Allow"
    of one column from "Allow" of the next, else the row's kind where its group doesn't say it (Tab, Section, Table,
    Column, View, Stage, Step, Related for a related menu item…; none where it is empty). The second (13 px) is the
    target-language text, or its state after a coloured dot (`.pl-t::before`, the colour of the page's marks): amber
    dot and grey "Not translated"; green dot and green text when changed; red dot and red text
    when a publish failed ("Changed" / "Couldn't be published" when there is no target text); grey dot and grey
    "Read-only" (a managed solution's label among them) or "Built-in" (Microsoft's own locked texts). A translated row
    has no dot. With one language a row is one line, except to say it is changed or failed. Long texts wrap to two
    lines, then an ellipsis. The text lines carry their language (`lang`, `dir`). Its tooltip has both texts in full,
    the kind, the breadcrumb and technical name, and what the colour means; a grey row's says why it can't be
    translated here (the read-only reason), as does its `aria-description`, which also says its place.
  - **Docked or floating** (pagelist.ts `placeSheet`, `floatBox`, `floatPlace`; `Prefs.list`): dragged by its header
    (`.pl-hd`, not its buttons; from a 4 px move on, so a click or a double-click never floats it), the sheet floats
    over the page (`.is-float`), so what it covered (a field at the right of a form) can be clicked. Floating, it is
    360 px wide and up to 640 px high (the window's height less 32 px), kept 8 px inside the window, also when the
    window gets smaller; it sits above the translation bar (z-index 12 over 11), which then takes its usual room again
    (§5.1), and below the popup. The pin button in its header, **Dock to the right** (pressed while docked; pressing it
    then floats the sheet at its last place, the keyboard's way), or a double-click on the header docks it again.
    Docked or floating, and the floating place (fractions of the room around it, like `prefs.bar`), are kept in the
    user's preferences (`savePrefs`; `readPrefs` keeps `list`), so they survive a reload.
  - **A popup opened from a row** (mode.ts `rectFor`, `rowAnchor`; ui/callout.ts `placeCallout`): it points at the
    label while the label shows and isn't under the sheet's box, docked or floating; else at the row, beside the sheet
    (`CalloutHost.beside`): to its left where there is room, else to its right (`is-right`), its beak on the row; only
    where neither side has room is it placed below or above the row, as next to a label.
  - Finding the label (inspector/reveal.ts, mode.ts `openComp`): a row finds its label on the page. One the page
    renders is scrolled into view. One it doesn't is shown by opening what hides it, when that changes nothing but the
    view: its form tab (`tabs.get(name).setFocus()`, also from an associated view; a composite column's sub-field: the
    tab of its composite control's cell), the header's flyout (its expand button), its process stage's flyout (the
    stage chip's button, only while that flyout is closed). Never a menu (More tabs, the related menu, the command
    overflow: they close as soon as the popup takes the focus), never another tab for a tab's own row, never anything
    on the record. Dynamics draws a tab's fields only as they come into view (LIVE-FINDINGS 96: an empty
    `div[data-id="<control>"]` in its section until then): a field or section the form shows but hasn't drawn, on the
    tab shown or on the tab just opened, has its place brought into view (reveal.ts `render`, `bodyPlace`,
    `placeholder`: the placeholder in its section, its container once drawn, else the section; never a side pane's or
    a grid's), and once drawn it is put back in the middle (drawing it drew the fields around it). The mark then pulses
    and the popup opens next to it, or beside the sheet at the row while the sheet covers it (above). A label the
    form hides (getVisible false on its tab, section or control), one in a closed menu, and one that doesn't render
    within 2.5 s
    (`REVEAL_WAIT`) open next to the row. Closing the sheet cancels a find still waiting, also one gone to another page
    (`PageMode.cancelFind`). The Publish dialog's Fix finds labels the same way, on another page too (app.edit ->
    PageMode.open). A change made on this page in translation mode whose label doesn't show is first looked for where
    it was made (Back to the place, below).
  - **Changed on other pages** (mode.ts `awayItems`, status.ts `awayTitle`): every staged change, or one whose publish
    failed, whose label isn't on this page (not in the index's universe, never anchored here) is listed after the
    page's labels in a group of its own (collapsible like the others), its rows under one sub-heading per page naming
    the page they were made on (`.pl-pg`: a page icon and the name, 13 px semibold, a line between pages; "Contact ·
    Information", "Accounts · Active Accounts", "Sales Hub · App navigation"; a form whose name the page tracker
    doesn't know by the name in its slot's breadcrumb; "Workbench" for a change that wasn't made on a page; "Another
    page" for a page without a name). It is the only part of the list with headings under its band. A change made on
    this page whose label isn't shown joins the page's labels instead. Its rows look like the page's changed rows; All
    and Changed count them, Not translated never; the search looks in the page's name too; over 300 rows: Show all; no
    such group when there are none. Only a change made on a page
    in translation mode has somewhere to go (reveal.ts `targetOf`): when it is staged, mode.ts records PageLoader.page
    (`stagedAt`: for a label of that page, or a text its open popup edits with it, meaning the popup's texts, their
    copies on the form and its choices, `modelKeys`; a text staged while a popup is open that the popup doesn't edit,
    such as an older step redone with Ctrl+Y, goes by its own label; this session only, forgotten once published,
    undone or dropped by a reload that brought the same text; a change first made elsewhere records the page it is
    next changed on by a single edit) and the place on it (reveal.ts `Spot`, `spotOf`): the form tab shown when its
    popup opened (`selectedTab`), or the related view shown instead (an associated grid opened from the Related menu,
    whose tab is `tablist-<nav id>`, LIVE-FINDINGS 88: a name the page form has no tab of that starts with "nav" or is
    a nav item of the form XML), and the header's flyout or the process stage's flyout its label was in (`flyoutOf`; a
    label in a side pane records none). It goes back to exactly that page: that form of that record (a new record's
    form when it was made on one), that list with that view, that dashboard. A change made anywhere else (the
    Workbench, an import, the app's editor for a label that isn't on the page, before translation mode started) goes
    nowhere, whatever its slot names (no last record of its table, no new record's form, no quick view host, no
    dashboard or view from its slot): it is listed under "Workbench", and a click opens it in the app's editor (or
    next to its row when its label belongs to this page).
  - **Going there** (reveal.ts `routeTo`, `goTo`, `tripStep`, `goAgain`; mode.ts `goFind`): never for a label of this
    page (the same form on this record, or reachable on it), except a change made on another page whose label this
    page doesn't show (mode.ts `elsewhere`: a column renamed through an associated view's header, looked for from a
    form of its table that only lists the column): it goes back to where it was made, and it is listed under "Changed
    on other pages" with that page's name, not among this page's labels. Another form of this record: its form selector item's
    `navigate()` (the record stays; a form the selector doesn't list for this user: no navigation, the popup opens next
    to the row), else `Xrm.Navigation.openForm` on this record; another record or table: `openForm({ entityName,
    entityId, formId })` (made on a new record's form: `openForm({ entityName, formId })`, a new record's form: nothing
    is saved unless the user saves); a list: `navigateTo({ pageType: 'entitylist', entityName, viewId, viewType })`; a
    dashboard: `navigateTo({ pageType: 'dashboard', dashboardId })`. Always the page's Xrm, read live (LIVE-FINDINGS
    95), never a side pane's; Dynamics asks about unsaved changes as it always does, and nothing gets around that. The
    find then looks at the page every 200 ms, following it at once. On the page it left (an unsaved-changes prompt) or
    on the way, it waits. Once the target page shows (its label anchored, else 0.5 s after the page's loads are in and
    its form has rendered), it brings back the place the change was made at (below), then finds the label as on any
    page (`openComp`, above). When Dynamics opened another form of the record instead, it finds there once that form
    has been ready for 3 s. A second click on the row while it goes does nothing, unless it is still on the page it
    left after 1 s with no Dynamics dialog open (`goAgain`): then it goes again. Another row, a label clicked on the
    page, closing the sheet, the Workbench, one of the translator's dialogs, another page than the target, a refused
    navigation and 20 s without arriving (`TRIP_WAIT`) cancel it: nothing opens. The sheet keeps a row's element across
    pages, so the row moves into the page's group and the popup opens next to it when its label doesn't show.
  - **Back to the place** (reveal.ts `backTo`, `backStep`; mode.ts `goBack`, `spotHere`): after going there, and on this
    page when its label doesn't show (a column header changed in an associated view while another tab is shown), also
    on another record shown with the same form (the tabs, related views and flyouts belong to the form; still never a
    navigation for a label of this page), the place the change was made at is opened again before the find: its form
    tab (`tabs.get(name).setFocus()`) or its related view (`Xrm.Page.ui.navigation.items.get(<nav id>).setFocus()`,
    LIVE-FINDINGS 87), then, once the tab bar shows it selected, the flyout its label was in (the header's expand
    button, the stage chip's button). Each part is opened once (a second click would close a flyout); one that can't be
    opened, or isn't shown 2.5 s after it was opened (`BACK_PART`), is left out. It looks at the page every 100 ms and
    finds the label (`openComp`, above: it pulses and its popup opens next to it) once the label shows there, once the
    place has shown with the page's loads in for 1.5 s (`BACK_SETTLE`: an associated grid draws, then loads its view's
    query, before its headers are marked), or after 8 s (`BACK_WAIT`); a label that never shows opens next to its row
    and moves next to the label if it shows later. Whatever cancels a find cancels it, and so does one of the
    translator's dialogs. Only the view changes: Dynamics' own tab and navigation APIs and the expand buttons, never
    anything on the record. Coming back from another page, the place is opened even when the label already shows on
    arrival (a sub-grid on the default tab), so the user lands on the same tab or view; on the page itself nothing
    moves while the label shows. Not verified live yet: that opening an associated view through the navigation API
    leaves the page's signature (`location.href`, `getPageContext().input`, the form selector's item) unchanged (if
    not, the find would be cancelled as "another page"), and the flyout restore.
  - The user's own language shows staged text in place (preview.ts); an emptied translation Dataverse can't remove
    shows its stand-in (`Store.standIn`), what saving writes, and a field label without a text in that language whose
    column has no name there either shows the column's base-language name.
* **Mapping safety** (inspector/scan.ts): every anchor resolves to one slot key. Form fields resolve to the
  exact cell copy through the form API (finding 41); a column stands in only when the loaded form has no
  cell for it. Grid headers and choice values on lists and sub-grids (Power Apps grid
  `[role=columnheader][col-id]`, `[role=gridcell][col-id]`); closed choice controls
  (`.fieldControl-option-set-select`, `.fieldControl-toggle-container`). Text columns, lookups and other
  record data are never anchored.
  - A grid's table from its `data-lp-id` (parts.ts `lpGrid`) is part 4, else part 2. An **associated grid** (the view
    a related menu item opens on the record form, LIVE-FINDINGS 88:
    `data-lp-id="…PowerAppsOneGrid|entity_control|<page table>|<view id>|<related table>|<relationship>"`)
    shows the related table (part 4): taken only when part 2 is the page's table and the grid's own
    view's query (`#view|`, `PageLoader.viewTables`) reads it; until then nothing in it is mapped. A **side pane's
    grid** takes the table its view's query reads, the one its `data-lp-id` names only without a view id or once that
    read failed. The scanner keeps a grid's table per grid element only while its `data-lp-id` stays the same: a
    re-render can reuse the element for another related view.
  - The **classic read-only grid** (`MscrmControls.Grid.GridControl`, Wijmo; the Connections associated view,
    LIVE-FINDINGS 91) shows its headers as `div.wj-cell.wj-header#<grid>-<column>` in `.wj-colheaders`, the column in
    their data-id (no col-id, no role); the `[role=columnheader].wj-cell` twins are an invisible copy (opacity 0) that
    names no column and is never anchored. The column is taken only when the cell's data-id, its id and its single header
    button (`Grid<grid id>_headerButton<column>`) name the same one; never the selection column (`btnheaderselectcolumn`,
    no header button). Its
    table is found exactly as for a Power Apps grid (`lpGrid` accepts `…GridControl`, whose `data-lp-id` has the same
    parts; view selectors and linked headers work the same), and the same mapping follows (`attribute|<table>.<column>`
    DisplayName, `<alias>.<column>` through the view's query and `linkedHeader`), but only where the header's text is
    what that column shows in the user's language (its name there, else the base one); of a linked header only the
    parts that are. Its cells' choice values are not mapped (Wijmo cells have no column key; LATER).
  - A composite column's sub-field (`<composite control>_compositionLinkControl_<column>`: an address's street and
    city, a full name's first and last name) maps to `attribute|<table>.<column>` DisplayName (it is no form cell, and
    Dynamics labels it with that column's name on every form; LIVE-FINDINGS 90): only when its label shows one of that
    column's texts and, where a form API knows the control, binds it to that column. A control's title in its own
    action bar (`action_bar_header_title<control id>`, the timeline's "Timeline") maps to the only cell of its form
    with that control id that shows no column (the form API doesn't know the timeline), where its text is one of the
    cell's labels or the cell has no label in the user's language.
  - A subarea that shows its table's plural name (`ref.plural`, §4.4) maps to `entity|<table>|DisplayCollectionName`
    only where the entry's text is one of that name's texts (any language), read on demand: no mark while it loads.
    Once that read failed, or where the entry shows any other text, the entry stays on its own read-only subarea slot
    (grey), never the table's. "All labels" lists it as the table once the table's names are loaded, else as that
    subarea.
  - A group heading the page names by its resource instead of its Id (`<span data-id="sitemap-sitemapAreaGroup-NewGroup">`
    for a group the app designer never named, LIVE-FINDINGS 99; the element id is a GUID that is no sitemap Id) maps to
    the item of that resource without titles (scan.ts `unnamedItem`, `PageIndex.unnamed`). It is taken only after the Id
    and the text maps found nothing, and only when all of these hold:
    - exactly one group of the app's sitemap has that resource and no Titles;
    - every other group with that resource has a title in the user's language;
    - the heading's single text is no title of any sitemap item (`navTexts`).
    Otherwise it gets no mark (two groups never named both read "NewGroup"). The same fallback applies to a navigation
    entry `sitemap-entity-<resource>` (not observed live). Areas are found by their text only, so a placeholder area has
    no mark and is named from All labels or the Workbench.
  - A data-id name that is one item's Id and another item's resource (`PageIndex.resources`, scan.ts `another`) maps to
    the Id's item only where the entry shows one of its texts (a plural-name subarea: its table's, once read); where
    that item has no title of its own, what it shows is unknown and the entry gets no mark. Otherwise the entry goes on
    to the text and resource rules above.
* **Other forms on the page** (findings 56, 58): every element is first given its form (scan.ts `formAt`).
  Quick create and dialogs are left alone. A **side pane** (`[data-id^="pane-container-"]`) shows a form of its
  own: its fields, tabs, sections, header fields, sub-grid titles and table name map to that form, named by the
  field containers' element ids (`id-<form id>-<n>-<control>-…`), placed by the DOM (section and tab in the pane,
  as after a cold boot); `Xrm.Page` is never asked (it is the page's form, and returned the page's controls for a
  pane of another table). A **quick view** field (`data-id="<quick view>.<control>-…"`) maps to the quick view
  form named by its container id, accepted only when the host form's quick view control lists that form
  (`ref.quickForms`, from `<QuickFormIds>`); on the page form its controls are placed through
  `Xrm.Page.ui.quickForms.get(<quick view>)`. A page field container naming another form is never mapped. Those
  forms load on demand (pageload.ts: `#form|` side pane, every language; `#quick|` quick view, cells only; their
  tables with columns and choices), quietly: a form that can't be read stays unmarked. Side panes count as a
  covering layer for the overlay (the part of a page mark under a pane is cut away); what covers a label is decided
  on its text's boxes, not its zone.
* **Business process flow** (finding 64): a stage chip maps by the stage id in its element id
  (`…processHeaderStage_<stage id>`), never by the name it shows (UCI keeps a process's names cached); a step in the
  stage flyout maps by the step id in its container (`fieldSectionItem_<n>_<step id>-FieldSectionItemContainer`).
  The process's name above the stages (`…ProcessBreadCrumb-processHeaderNameLabel`, no id of its own) maps to the
  `bpf|<id>` Name of the record's active process (pageload's `bpfId`; its own load `r:bpf:<id>` in the Process
  group, next to the stages' `b:<id>`, so a failed read shows on the bar and Try again reads it), whatever name it
  shows, and only while the form API names that process (`getActiveProcess()`); it is saved with SetLocLabels on
  `workflow.name` (records.ts) and needs no publish (workflows have no PublishXml element). An open stage flyout
  (`…processHeaderStageFlyout_<stage id>` inside `…processHeaderStageFlyoutContainer_<stage id>`, LIVE-FINDINGS 92)
  shows its stage's name in `label#MscrmControls.Containers.ProcessStageControl-flyoutStageName`: it maps to the stage
  the flyout's id names (`st:<stage id>`, whatever cached name it shows, like the chip), role label, so its popup has
  no Show stage (the flyout is open); not in a side pane, in quick create or while the index is stale. Its buttons are
  built-in text (above); its status ("(Active for 50 hours)") and its close button (no text) get no mark.
* **Related menu** (finding 63): an item (`form-tab-relatedEntity-<nav id>`) the form XML lists maps to its
  `navitem` (titles of its own). Any other item comes from the page table's relationships (pageload.ts `#related|`
  loads them, and the plural names of the tables they list, when such an item renders): `nav_<schema name>` →
  the relationship's menu label (`ref.menu === 'label'`) or the listed table's plural name (`'plural'`);
  `navActivities` → the activities relationship; an N:N relationship's Entity1 menu shows on Entity2's form and the
  other way round, and one to the same table gives two crossed items (`nav_<schema>1` = side 2). The item's text
  must be the mapped slot's. Built-in items without a form XML entry (Background Processes) show language-pack
  text: grey built-in marks. The view an item opens shows as a tab of its own (`li[role=tab]#tablist-<nav id>`;
  `[role=menuitem][data-id="tablist-<nav id>"]` in "More tabs", LIVE-FINDINGS 88). It maps exactly like the item
  (scan.ts `relatedItem`: form XML entry, menu label, plural name or built-in), only once the page form's tabs are
  known to have none of that name (a nav id starts with "nav", or the form XML lists it as a nav item), and never in
  a side pane. Its role is nav: a click opens the popup, and Open shows that view (navigation API by its nav id).
* **View names** (LIVE-FINDINGS 88): a list page's own view selector shows the page's view (pageInfo; a personal view
  has none). Any other view selector (an associated grid's, a sub-grid's, a side pane list's) names its view by its
  element ids (`ViewSelector_<view id>`, `ViewSelector_<n>_<view id>_<guid>_text`, its own or its two nearest
  ancestors') and by the grid it heads (the nearest ancestor holding exactly one grid `data-lp-id`); the two must agree
  (scan.ts `selectorView`). An item of a list of views: of a list page's list (`ViewSelector_<view id>-flyout`) by its
  `data-value` (below, The lists the page is switched with), of any other by the ids inside the list only. What holds
  a list of views (its flyout) is never a selector's label: its first text that reads like a view's name could be any
  item's. The text must be that view's name in some language. The view record loads on demand (`#viewname|`; what the
  read doesn't find is never asked for again). A personal view (userquery) is the user's own data, not a
  customization: no mark.
* **The lists the page is switched with** (inspector/lists.ts; scan.ts `opens` and the item rule, overlay.ts `effect`,
  describe.ts `listAction`, mode.ts `listActs`): the app's areas, the record's forms and a grid's views. Live markup
  (current UCI, 2026-10-20):
  - the area switcher `button#areaSwitcherId` at the foot of the navigation; its list a portal under body,
    `[data-lp-id="sitemap-area-switcher-flyout"]`, items
    `li[role=menuitemradio][data-id="areaswitcherflyout-<area id>"]`;
  - the form selector `button[data-id="form-selector"]` next to the table name in the form header; its list a Fluent
    v9 portal, `[data-id="form-selector-flyout"]`, items `div[role=menuitemradio][data-value="<form id>"]`;
  - a list page's view selector `button[data-id="ViewSelector_<view id>"]` above the list; its list a Fluent v8
    portal, `[data-id="ViewSelector_<current view id>-flyout"]`, items
    `button[role=menuitemradio][data-value="<view id>"]`, then Microsoft's "Manage and share views" (a menuitem, no
    view).

  The current item is `aria-checked="true"`; the aria-labels are localised and never read. A list's button only opens
  it, and picking from the list is what the user opened it for, so beside a label's text both reach the page
  (Clicking a label, above).
  - **A selector's own label** (scan.ts `opens`, lists.ts `selectorSwitch`): the area the switcher shows (by its
    text), the form's name, the view's name. Its zone is the button, and `Anchor.sw` names its list. Beside the text
    (its chevron, its padding) the list opens; the hover ring shows on the text, without a pencil (Marks, above). Its
    popup's secondary button is Change area / Change form / Change view (`openList`): once the popup has closed and
    the focus is back, a click like the user's on the button, never while the list is open (that click would close
    it). The form selector of a dialog or a side pane shows another form: no mark.
  - **Items, marked**: while a list is open, every item is marked like any other label (role nav, the item its zone),
    so the open list shows what can be translated: in its status colour, grey when read-only (from a managed
    solution). An area by the id its data-id names, else by its text; a form or a view by the id its `data-value`
    names, and only where its text is that form's or view's name in some language. Names not read yet load on demand
    (`#formname|`, `#viewname|`). A personal view (no savedquery behind it: no slot, asked for once) and "Manage and
    share views" are never marked.
  - **Picking**: a click beside an item's text picks it (the page gets the click). A click on its text opens its popup,
    whose **Open** (none on the current item) switches to it once the popup has closed (`switchTo`). By then the
    list has closed and its items are gone, so what switching needs is captured with the label (`Anchor.sw`,
    `itemSwitch`: the list, the id, the button that had the list open, selectors that find that button and the item
    again). A form switches through the page's form API (`Xrm.Page.ui.formSelector.items`, by its id, `navigate()`;
    Dynamics asks about unsaved changes itself), and only from the list the page form's own selector opened: a
    dialog's or a side pane's items keep their marks, without Open. An area or a view opens its list again with its
    button and clicks the item as soon as it shows (looked for every 100 ms, `PICK_WAIT` 3 s at most); else a warning
    toast, "Couldn't change the view: the list of views didn't show it. Pick it from that list on the page." (the
    area's alike; a form whose `navigate()` throws: "Couldn't change the form. Pick it from the list of forms on the
    page."). Where nothing can be started (no such form in the form API, no button), the popup stays open with its
    muted line. The timers do nothing once translation mode has stopped.
  - **Keyboard**: an item reached with F2 leaves with its list as its popup takes the focus; Done, Enter or Esc give
    the focus to the button that opens its list (`focusOpener`), and the keyboard goes on from there.
  - Verified live on a development environment (2026-10-20): all three lists open, are marked, and switch by Open and
    by a click beside an item's text; Change … opens each list.
* **Tabs that don't fit** (finding 65): the "More tabs" flyout lists them as
  `[role=menuitem][data-id="tablist-<name>"]`; they map like the tab bar's tabs. A click on the text of a tab or an
  overflow item only opens its popup, and one beside the text in it does nothing; Show tab switches to it.
* **Several labels in one text** (`Anchor.part`, findings 54, 55, 57): a **multi-select** shows its values as one text
  ("Rouge, Bleu", on forms in `#<ctl>_viewmodecontainer`, in grids in the cell): each value is a part of that text
  node with its own mark and option. On forms the hidden chips (`li[data-value]`) give each value's option exactly
  (`valueParts`); in grids the text is split where every piece is an option label and only one split exists
  (`splitValues`, ", " or "; "). A **linked-table column** (`col-id="<alias>.<column>"`) shows "<column> (<lookup>)":
  the related column's name and the lookup's name are two parts (`linkedHeader`); the alias is resolved through the
  grid's query: a page sub-grid's `getFetchXml()`, else the view the grid names in its `data-lp-id`
  (`…PowerAppsOneGrid|<control>|<table>|<view id>`), whose fetch XML is read once (`#view|`). Its choice values map to
  the related table's options. A built-in command named after its table has its table's name as a part (above). A
  click in a zone of parts opens the part whose text is under the pointer (`pickPart`); between the parts or past them
  nothing opens (it would be a guess), and the click goes to the page or, where the zone acts, is swallowed (Clicking
  a label, above). The popup sits next to the part; preview never rewrites a shared text.
* What it loads (pageload.ts), at start and in every language (no prompt): record page → table (columns,
  choices, relationships), current form (XML labels; tab and section labels through the automatic language
  switch) first, then sub-grid tables (columns + choices) and commands on the bar (modern + classic), active
  BPF, app, sitemap. List page → table with columns **and choices**, current view, commands, app, sitemap.
  Dashboard → dashboard, app, sitemap. On demand, as the scanner asks (`Scanner.want`, `PageLoader.request`): grid
  tables (`#table|`), side pane and quick view forms (`#form|`, `#quick|`), a grid view's query (`#view|`: its
  linked tables and the table it reads, which an associated grid and a side pane's grid need before their headers
  map), the names of views in view selectors and lists of views (`#viewname|`: one read for the views asked together,
  group Table and views; a failure shows on the bar, Try again reads it again), the names of the forms the form
  selector's list shows (`#formname|`, the same way), the page table's relationships (`#related|`), and
  the names of tables that navigation entries show by their plural name and that Microsoft's New, Add Existing and
  Export commands show (`#names|`: one read of the table alone for the tables asked together, after any running read
  of that table, groups Navigation and Command bar; a failed read is on the bar, "Could not load the names of tables
  on this page." with Try again, and a table not in the org gives up quietly). A form whose labels a language could
  not be read for (after the loader's own second try, §4.3) keeps what was read and counts as failed: the bar says
  "Couldn't load some labels." (its tooltip: "Could not load the form labels in every language."), and its Try again
  reads the form again. Labels no read can complete (`ref.unreadable`: a form without an unpublished definition, its
  cells known in the user's language only) never count as failed.

### 5.5 Workbench (workbench/*): the Easy Translator workbook
Built to look and work like the XrmToolBox Easy Translator workbook (contracts
`workbench/types.ts`).
* Header "Translation workbook": **Extract translations**, **Excel** menu (workbook / this sheet / CSV,
  Import workbook or CSV…), **Save and Publish** (the Publish dialog of §5.3, then a result line). A message bar above
  the screens toggles **Export options** (Setup) / **View spreadsheet**.
* **Setup screen** (scope.ts): Entities options (Load source All entities / From a solution, Solution, Load Entities /
  Check all / Clear all, Filter entities (the same search as Filter rows, below), Display name and Logical name table,
  N selected); Global Options (Global OptionSets loads every global choice outside solution mode, `Scope.allGlobals`;
  SiteMap, Dashboards…); Languages (Export all / Export only X, Rows filter); Entity related options; Label options
  (Both / Only Names / Only Descriptions; "Include read-only labels (from managed solutions or not customizable)",
  `Scope.includeReadOnly`). Without that option the loaders leave out read-only labels, every one from a managed
  solution among them, so the sheets hold what can be translated; an extraction that brings nothing says why
  (workbench.ts `nothingExtracted`: "No labels to translate were extracted. Read-only labels (from managed solutions
  or not customizable) are left out unless “Include read-only labels” is selected. …"). The table list shows a managed
  table that can't be customized only with that option; a customizable managed table stays listed: its own labels are
  read-only, but it can hold unmanaged columns, forms and views. Errors use the old texts.
  - **Extract waits for the entity list** (scope.ts `scopeOf`, `listKey`; `WbState.tablesFor`). The checked entities
    belong to the load source whose list they were checked in (`'all'`, or `'solution|<id>'`), kept with them. Just
    after the load source or the solution changed, they are not known to be the new one's tables, so nothing that uses
    them is extracted until its list is in: extracting them under a solution would load tables outside it. While that
    list loads, Extract says so as information, not as an error ("Wait for the tables of Sales to load, then check the
    entities to extract."; with entities kept from the other source, "…, then extract translations: the entities
    checked before may not be in this solution."), and the line goes once the list is in (workbench.ts `waitLine`).
    After that read failed: "Couldn't read the tables of Sales. Select Try again under the entity list, then check the
    entities to extract." A newly picked solution lists its tables unchecked; a switched load source keeps the checks
    it lists.
* **Workbook**: one sheet per type with the old key columns (ids first, small monospace; Forms Fields has a Control Id
  column so every copy of a duplicated field is its own row; Global OptionSets has Used By; the Attributes Type reads
  "Description (tooltip)" for tooltips), then one column per language. 52 px rows, click to edit, Excel paste / fill /
  undo, changed cells green, ✓ on cells saved and verified, red problems, orange conflicts with a "Use server value /
  Keep mine" chooser (Look, below). Top bar: Filter rows (all sheets; every word typed, with case, accents,
  apostrophes and ligatures aside: core/search.ts), Rows, Tools (bulk tools: Copy base language into empty cells, Find
  and replace, Trim spaces; each previews what will change and applies it as one undo step; Change applies exactly the
  plan the preview shows, at once when nothing was typed since, never searching again: text typed within the preview's
  150 ms debounce is planned at the click, and if that changes any cell or new text, the preview updates and the next
  click applies it; a click while a background search runs, before "Searching…" shows, waits for its answer and
  applies it only when it is the plan shown, unless text is typed meanwhile, which drops the click as a changed
  option does), undo/redo, the **↑ N pending changes ↓** navigator. Sheet tabs at the
  bottom, "Attributes (84)", with a dot when the sheet has pending edits.
* **Find and replace never freezes the page** (workbench/regex.ts `searcher`, `FIND_LIMIT`, `canSearchAside`,
  `heavyRegex`; tools.ts `riskyRegex`, `FIND_BUDGET`, `SEARCHING_AFTER`). Nothing can stop one regular expression
  search on the page once it started: JavaScript tries every way a repeat can split a text before it gives up on a
  label (`^(a+)+$` on a label of 30 letters takes about a minute, and `^a*a*a*a*a*a*a*a*a*a*$` takes several seconds
  on 28 letters, far past the limits). So a regular expression searches in a Web Worker started from a Blob URL (one
  per dialog, at its first search), with a hard limit of 1.5 s counted from when the worker runs: past it the worker
  is terminated, "This search took too long, so it was stopped and nothing will change. Write the regular expression
  more simply, with fewer repeats in a row that can match the same text (such as .*.*).", and nothing changes (a
  search that throws there: "This search could not run, so nothing will change. Write the regular expression more
  simply."). The page stays usable meanwhile. While an answer takes over 200 ms the dialog says "Searching…" instead
  of the preview (the list hidden, Change greyed with `aria-disabled`, so it keeps the focus, and does nothing); a
  quicker answer replaces the preview at once. A newer search stops the one running (its worker is terminated: a
  worker can't take another search before its search ends); closing the dialog stops it and revokes the Blob URL; an
  answer for a replaced plan is dropped (`gen`). Blob workers are allowed on Dynamics' pages (checked live), so this
  is the search that runs there. Where the page blocks workers (the constructor throws: `run` gives null at once; or
  the worker fails as it loads or never runs within the limit: 'unavailable'; either way none is tried again on that
  page), a regular expression searches on the page, and a strict check refuses first any pattern that could take long
  (`heavyRegex`): two repeats that can match the same characters where one can end anywhere (`a*a*`, `.*x.*`,
  `(.*)\1`, `.*\d+x`: "This regular expression has two repeats that can match the same text, like a*a* or .*x.*, which
  can freeze the page on some labels: this page does not let the search run in the background. Keep one of them, or
  put a character they can't match between them, as in \w+ \w+."), or optional parts, bounded counts and choices that
  combine more than 32 ways (`WAYS`; counts above 16, `BIG`, count as unbounded: "… has too many optional parts or
  choices that can match the same text, like a?a?a?aaa, … Write it with fewer of them."). It keeps plain text,
  classes, anchors, a choice of words, and repeats that a character they can't match ends (`\w+ \w+`) or that end the
  expression (`^Nom .*$`). Whole word wraps the pattern in a group between look-arounds, so the pattern is first
  compiled on its own: one valid only inside that group (`a)(?:a*a*$`) is "That regular expression is not valid.",
  never checked in part. In both cases a regular expression is still refused before it runs when it repeats (more than
  once: anything but `?` or `{0,1}`) a group that holds a repeat or an optional part of its own, at any depth
  (`(a+)+`, `(\w*\s)*`, `(ab?)+`, `(x{1,3}){2}`), or a group that holds a choice in a group inside it (`(x(a|b))+`) or
  is a choice whose alternatives don't each start with their own plain or escaped character (`(a|ab)+`, `(\w|_)*`,
  `(Mr|Mrs)+`); `(foo|bar)+`, `( |\t)+`, fixed counts (`a{2}`, `(ab){3}`) and everything outside a repeated group keep
  working. The preview says why: "This regular expression repeats a group that holds a repeat or an optional part of
  its own, like (a+)+ or (ab?)+, which can freeze the page on some labels. Write it without repeating the group, for
  example a+ instead of (a+)+." (a choice: "… repeats a choice whose alternatives can match the same text, like
  (a|ab)+ …"). A search on the page (plain text, or a regular expression where no worker runs) that still takes longer
  than 400 ms in all stops between labels and plans nothing: "This search took too long, so it stopped after N labels
  and nothing will change." with what to do (a simpler expression, or filtering the rows first).
* **Fill down and the clipboard** (grid.ts `fillDown`, `each`, `snap`, `viaApi`). Ctrl+D copies the first row's texts
  to the rows below it (one row selected: the row above's to it). A source cell whose language was not loaded (Not
  loaded, below) is skipped for its column, never copied as empty: its blank stands for a text nobody has seen, and
  copied it would empty a translation, which saving removes or replaces with its stand-in. The toast says so
  ("Skipped 1 cell whose source cell is not loaded (its text is unknown, not empty)."). A paste of this grid's own
  copy skips its cells that were not loaded the same way (`unk`, noted when it was copied). Where the browser swallows
  the clipboard events of a non-editable element, Ctrl+C, X and V fall back to the asynchronous Clipboard API, whose
  answer comes later (a permission prompt can take a while). The fallback acts on the cells selected when the keys
  were pressed (`snap`: the range, its rows' keys, its columns' ids, the sheet), and changes them only while they are
  still the selection: same sheet, rows and columns in the same places, no move of the cursor since (`gen`), no cell
  editor open. Otherwise nothing is pasted ("Nothing was pasted: the selection changed while the browser was reading
  the clipboard. Select the cells again, then paste."), a copy or cut whose rows changed copies nothing, and a cut
  copied but whose selection moved clears nothing ("Copied, but nothing was cleared: …").
* **Look** (grid.css, workbench.css, in the app's colour tokens of ui/styles.css): the old workbook's meaning (green
  changed, red problem) as a light tint with a 2 px line on the cell's left edge, the text in its usual colour.
  - A changed cell, not saved yet: `--green-bg` with a `--green` line. A cell whose save failed, or a blank Dataverse
    refuses: the same in red, with a red "!" at its right. A conflict (changed on the server by someone else since it
    was loaded): the same in Fluent's warning orange (`#bc4b09` on `--amber-bg`), with a "?" (a choice to make). A
    cell saved and read back: a green ✓. The row number has the same line: green when the row is edited, red (on a
    red tint) when it has a problem. In forced colours the lines become 3 px left borders.
  - Read-only and "Not loaded" cells are a neutral grey (`--bg3`, text `--fg3`); a missing translation's dash has the
    page's missing colour (`#c48a00`). The target language's column, its header included, looks like every other: no
    brand colour anywhere in it.
  - The pending-change navigator (the **N pending changes** button and the arrows beside it) selects the cell it
    reveals and rings it with the selection's 2 px brand outline, which fades over about a second (`is-fl`,
    `FLASH_MS`; shown for that second without fading under reduced motion). While the focus is elsewhere (the filter
    box, the navigator's buttons) the active cell keeps an `--fg3` outline, visible on any tint.
  - Every scrollbar of the Workbench always shows, so the grid's bottom one is there without hovering (Edge's overlay
    scrollbars appear only under the pointer): a 12 px bar on a light track, its thumb a mid grey, darker under the
    pointer. `scrollbar-color` is set back to `auto` on the Workbench, as a value inherited from the page would make
    Edge ignore the styled bars; Firefox gets a thin bar. The sheet tabs show theirs when they don't fit.
  - The help popover's colour key (workbench.ts `LEGEND`) shows the same looks.
* **Not loaded** (grid.ts `unreadTip`, `rereadable`; workbench.ts `unreadLine`, `reread`): a form label in a language
  its load could not read (§4.3) shows "Not loaded", never as empty, and can't be edited or written.
  - Its tooltip says why: "Not loaded: this form could not be read in French, even when tried again.", the reason
    (`ref.unread`), then "Select Extract translations again to read it, or Read again where the message bar offers
    it."; for a form without an unpublished definition "Not loaded in French." and `PUB_ONLY`; else `UNREAD` ("Not
    loaded: form tab and section labels in other languages are read by switching your Dynamics language for a moment.
    Select Extract translations again to read them.").
  - Opening such a cell (Enter, a click on the selected cell) shows that reason in a notice, with a **Read again**
    button where that read would bring the cell (its form's read failed in that language; never for `unreadable`
    labels, nor for a language the load was not asked to read), its last sentence then "Select Read again to try once
    more, or Extract translations again."
  - After Extract translations or an import, the message bar says how many forms could not be read in which
    languages, then the first reason in a sentence of its own: "The French and German labels of 2 forms could not be
    read, even when tried again.", the reason (with "(and 1 other reason: see the cells' tooltips)" when there are
    more), then "Their cells show “Not loaded” until they are read.", with **Read again**. It reads only those forms
    in only those languages (`formNote`), merges what it brings with what was read before (`mergeReads`; pending edits
    stay) and says what is left the same way, else "Read 2 forms again: they are now loaded in every language." Not
    while a save runs ("Wait for the save to finish, then read the form labels again."); Stop ends it ("Stopped.
    Nothing new was read.").
* **Cell editor** (grid.ts): it looks as its cell will once the text is committed (`edLook`, mirroring `commit()` and
  `langCell`): green from the first character that makes its text differ from the server text, with the cell's
  "Changed, not saved yet. Was “…”." tooltip; red where the commit or Dataverse would refuse it (a required base text
  left blank, a blank that can't be saved), and red with its error while a cell whose save failed keeps its text;
  flagged past the maximum length. The text reaches the store, and with it the pending counter, the row's bar and the
  tab dot, when it is committed with Enter, Tab, a click elsewhere or Save; Esc drops it. The editor keeps the text it
  opened on and that text's server base (`Store.before`). A reload can replace the slot while the editor is open
  (store.add, then the Workbench's setRows commits it). The typed text is then still staged against that base, so the
  row says "Changed on the server since you edited it" and publishing it is a conflict, never an overwrite. An editor
  left untouched stages nothing. While typing in a cell,
  Ctrl+Z / Ctrl+Y undo and redo that cell's text (typing into a selected cell replaced its text: the first Ctrl+Z
  brings it back, selected; Alt+Enter and a cleaned paste are steps of their own); in an editor with nothing typed
  yet (a click opens one) they close it and undo or redo the workbook's last change. Outside the editor, on the grid
  and the toolbar, they undo and redo the workbook's changes (the Store, §5.1).
* Every pending edit stays reachable (sheets include slots with pending edits; languages with edits are always
  columns). Import stages edits only; nothing is written until Save and Publish. An import's scope loads read-only
  labels too (io/workbook.ts `parse`: `includeReadOnly: true`), so a row of a read-only label, a managed solution's
  included, is skipped with "Read-only: <reason>" (`apply`), never as "No matching component in this environment"; the
  Workbench still shows such labels only where the extraction asked for read-only labels.
* Reading an imported file (io/xlsx.ts, core/zip.ts, io/csv.ts): an .xlsx is opened from its ZIP directory, and only the
  parts the workbook uses are unpacked (rels, workbook, shared strings, sheets; never pictures or other parts). Each
  part is unpacked to exactly the size its directory declares and must match its CRC-32 (accidental damage only: a
  CRC proves nothing about a file altered on purpose). One import may unpack at most 512 MB. A damaged file ("The file
  is damaged (… is not intact)"), a file with two parts of one name, or an oversized file is refused before anything is
  staged. Sheets are read as sparse arrays: a cell far down or far right allocates nothing before it. A cell is read at
  the whole address its reference gives (`r="E3"`), which must be a valid A1 reference inside the sheet (column up to
  XFD, row 1–1,048,576) and, when it names a row, the row it sits in; a row's own number must be valid. Otherwise the
  workbook is damaged (below). Rows and cells without a reference follow the previous one, as Excel writes them; a
  reference giving only the column takes its row's number. Errors name a sheet by its tab ("the Attributes sheet", cut
  after 31 characters), the part's path only when the tab has no name. Parsing runs on the main thread, and
  Stop does not cover it. CSV: this tool's export heads its Key column `Key (Dynamics Translator CSV)` (`CSV_KEY`,
  io/workbook.ts), which marks the file as its own. It puts an apostrophe before text that starts
  with = + - @, tab or CR (toCsv, after any apostrophes the text starts with), and import removes exactly one there only
  in a file with that header (also Excel's copy of it, saved as CSV with any delimiter or as a workbook). In any other
  CSV (an Easy Translator sheet saved as CSV, another tool's keyed CSV, or an export of this tool from before the
  header) a leading apostrophe is text. In a keyed CSV without the header, a cell whose only difference from the label
  is such a leading apostrophe is not staged; it is listed under skipped rows ("Not changed: the only difference is an
  apostrophe in front, which older CSV exports of the translator added before =, +, - and @. Type it in the translator
  if the text needs it"), so an older export never adds apostrophes to translations. The same holds for a keyed sheet
  of a workbook that has no "Translator" sheet and no `CSV_KEY` header (such an older export saved by Excel as .xlsx); a
  keyed sheet of our own workbook ("Other") is read literally.
* **An import stages only what the file says clearly** (io/xlsx.ts `readSheet`, io/csv.ts `parseCsv`, io/workbook.ts
  `parse`, `apply`). What a file can't say for sure is refused or reported, never guessed:
  - A workbook holding a row or a cell address twice is damaged: Excel writes each once, and a second one would
    silently replace the first ("The workbook is damaged (the Attributes sheet holds row 2 twice)."; "… holds cell B3
    twice").
  - So is one whose cell or row address can't be right (io/xlsx.ts `readSheet`): a cell naming another row would put
    its text on the label of the row it sits in. "The workbook is damaged (the Attributes sheet has cell E3 in row
    2)."; "… has a cell outside the sheet, at B1048577"; "… has a row outside the sheet, at row 1048577"; "… has a
    cell at "3E", which is not a cell address"; "… has a row at "1.5", which is not a row number" (what the file holds
    there cut after 20 characters).
  - A CSV quoted field that never closes, or with text other than spaces and tabs after its closing quote, is a
    damaged file (cut short, or a quote typed or deleted by hand): read on, it would take the rows after it into one
    field. It is refused, naming the line ("The CSV file is damaged (the quoted text that starts on line 2 has no
    closing quote). Check the quotes there, then import again."; "… line 4 has more text after the closing quote of a
    quoted field …").
  - A sheet with two columns for one language is refused: which one holds the translation is not known, and either
    could silently win ("Sheet "Other" has two columns for language 1036 (F and G). Keep one of them, then import
    again."; a CSV: "The file has two columns …").
  - A cell holding an Excel error (`t="e"`: #N/A, #DIV/0!, #VALUE!, a formula that failed; `Sheet.errors`) is not a
    translation: never staged, listed with the skipped rows ("Not imported: column 1036 holds the Excel error #DIV/0!,
    not a translation. Correct the cell, then import again"); the row's other languages still import. Literal text
    that reads like one, and a working formula's result, import as before.
  - Rows giving one label a text in the same language are found before anything is staged: the same text imports
    once (its first row); different texts import none of them, whichever row comes last, and each such row is listed
    with where the others are ("Not imported: the file has different texts for this label in column 1036 (here and on
    row 4). Keep one, then import again"; on another sheet "row 5 of Attributes").
  - An id is matched exactly first; ignoring case, it must match one loaded label only (io/workbook.ts `indexStore`
    `find`, `Ambiguous`): classic ribbon ids can differ only in case, and of several the one taken would be whichever
    loaded last. Otherwise the row stages nothing and is listed in Skipped rows, in the row's own terms (`ambiguous`:
    on a sheet the column whose text matches, with each label's text there; in a keyed file, or when no one column
    tells them apart, the id and the keys): "Not imported: the LocLabel Id matches more than one label when case is
    ignored (new.Button.Label and new.button.label), and none exactly. Write it exactly as the one it is for, then
    import again".
  - The Skipped rows dialog lists both kinds of row, those that matched no label and the languages of a matched row
    that were not imported: "3 rows of translations.xlsx were not imported, or not in full:" (workbench.ts
    `skippedIntro`), each with why.
* Emptying a translation (grid.ts `blankEdit`, `langCell`, `edLook`, the saver's rule): a removable one shows the old
  text struck through and "Will be removed when you save." Where Dataverse can't remove it (`canClear` false), the
  cell is green like any change and shows its stand-in (§4, "Clearing a translation") in muted italics (`.is-si`,
  `data-to`), with a tooltip saying why (`standInTip`): "Becomes “Project site” when you save: Dataverse can't remove a
  translation here, so French gets the English text. Was “…”." (one that is that text already: "Already the English
  text: …, so nothing changes."). The open cell editor says the same. Only a cell without a stand-in (an empty base
  text, its column's names not loaded) stays red, with the in-cell hint "Can’t be removed — type the text" and the
  saver's reason as its tooltip (`blockedWhy`, `noStandIn`). Only spaces where there is no translation yet, on a kind
  that can't be cleared, is red too (the saver's `onlySpaces` text). A paste or fill of several cells that empties
  such translations says so in its toast ("2 emptied translations get the English text in their place when you save:
  Dataverse can't remove them."), and Tools' preview shows "(becomes “…”)" for each and counts them, measured by the
  texts as the tool's own edits leave them. An emptied metadata description is `blankEdit` 'empty' (also only spaces
  where there is none): green, a muted "(empty)" (`.is-em`, `EMPTY`) and the tooltip "Saved empty when you save:
  French users then see no tooltip. Was “…”." (`emptyTip`); several at once say "2 emptied descriptions will be saved
  empty when you save: users of those languages see none there.", Tools' preview "(saved empty)" and "2 descriptions
  will be saved empty when you save: …". A cell loaded stored empty shows "(empty)" with "Saved empty: French users
  see no tooltip." (one just saved, with the check mark and "Saved and verified on the server."), counts as translated
  (`missing`), and "French is blank", "French matches English or is blank" and Copy base language leave it alone
  (sheets.ts `rowsTest`; Copy base language through grid.ts `missing`). An empty cell in an imported workbook or CSV
  is still no change. Cells in a language that was not loaded (partial form label slots, Not loaded above) can't be
  edited.

### 5.6 Copy
Plain, friendly, specific. Errors say what happened and what to do ("Dataverse is busy publishing
another change. Your edits are still pending — try Save again in a minute.").

---

## 6. Conventions
* TypeScript strict; ES2022; no `any` leaks across module boundaries except Dataverse JSON.
* Comments sparse, explaining *why*. Match the style of the `[done]` files.
* Errors: throw `DvError`/`Error` with user-facing messages; catch at UI boundaries and toast.
* All long operations accept an `AbortSignal`.
* Every view shares one shadow root with `ui/styles.css`, whose shared widgets use short bare classes
  (`.sel` select box, `.ed` editor card, …). State classes a view toggles use an `is-` prefix
  (`is-sel`, `is-ed`, …); `npm test` fails if a toggled class is also a bare global class.
* `__DEV__` gated `console` noise only.
* Each module must compile with `npx tsc --noEmit -p .` (run it before finishing).
