# Changes

## 1.0.0 (October 2026)

The first public release. Compared with the last private build, it includes the fixes from a security and privacy
review made before publishing.

**What is in it**

* **Translation on the page.** Every label of a record, list or dashboard that can be translated gets a mark on its
  own text: orange when it has no translation yet, blue when it has one, green when it is changed and not published,
  grey and dotted for Microsoft's own text and labels that can't be changed. A click on a label's text opens a popup
  next to it with the text in each language, the tooltip, the choices of a choice column and the other copies of a
  field. Only the text is the label: beside it, a click goes to the page (a field label's container, a section
  header), or does nothing where the page would act (a button, a tab, a link, a menu item), so a near miss never runs
  a command. What only opens or closes part of the navigation (a group, *Recent*, *Pinned*, the ☰ button) still works
  beside a label's text, and so do the lists of areas, forms and views (below). Alt+click uses the page as usual.
  Fields, tabs, sections, headers and footers, quick views, side panes, column headers and choice values in views and
  subgrids (also columns of related tables), business process flow names, stages and steps, modern and classic
  command bar buttons, the app's navigation and the form's Related menu all work the same way. A process's stages and
  steps get their marks once, with the names Dynamics keeps for them, so a stage translated only there is blue from
  the start, never orange for a moment.
* **A field's popup** shows its *Form label* (*this form only, shown instead of the column name*), its *Tooltip*
  (*everywhere*) and its *Column name* (*everywhere: views, search and forms without a form label*), always in that
  order, and opens with the caret in the *Form label*, the text the form shows, in the page's language; the *Column
  name* gets it only where the form label can't be changed (such as on a form from a managed solution). A form label
  is the form's own text, often a copy of the column's name saved when the field was added, and it doesn't follow a
  change to the column's name: to change what a form shows, edit its *Form label*. An empty form label says what the
  form shows in its place: *Shows “…”* with the column's name in that language, else its base-language name. A
  translation you empty says instead what saving writes in its place (below).
* **A popup opens where it stays.** It shows once its place has settled, then fades in from its label: opened from an
  option of a Dynamics dropdown list, which closes as the popup opens, it appears once, at the field. Above or
  below its label, it keeps its side while it nearly fits, so a scroll or a message under an input doesn't make it
  jump.
* **Switching area, form and view in translation mode.** The area switcher at the foot of the navigation, the form
  selector in the form header and a list's view selector keep working: a click beside the selector's text opens its
  list, and a click beside an item's text switches to it. While a list is open, its items are marked like any other
  label, so it shows which areas, forms and views can be translated (a personal view and *Manage and share views*
  are never marked). A selector's popup has **Change area**, **Change form** or **Change view**, which opens its
  list; an item's popup has **Open**, which switches to it, and Dynamics asks about unsaved changes as usual. The
  translation-mode bar sits right of the navigation, so it never covers the area switcher.
* **Managed components are read-only.** The translator never creates an unmanaged layer: a label whose component comes
  from a managed solution (a table, column, choice, relationship, form or dashboard, view, chart, app, the app's
  navigation, a process, a command, an environment variable, a custom API) is read-only whatever its managed
  properties allow: it is grey, its popup says why, and it is never staged, imported, saved or undone. Translate it in
  the environment where its solution is developed. Microsoft's own tables and forms (account, contact…) are managed,
  so on them almost every label is read-only; your own unmanaged components can be translated, also an unmanaged form
  or column of a managed table. The Workbench lists such labels only with *Include read-only labels*.
* **Marks stay under what covers the page**: Dynamics' own flyouts, menus and side panes, and another tool's panel,
  such as another bookmarklet's window.
* **All labels** lists every label of the page in groups (Form, Choices, Command bar, Navigation, Process, Table and
  views), with a search, the labels not translated yet, every change of the page (also one on a tab not shown) and the
  changes made on other pages, under the page each was made on; a click takes you back to exactly where you made a
  change. A click on a group's band (or Enter or Space) collapses or expands it, for as long as the translator is
  open; a search opens the collapsed groups to show what it finds. The rows of one place stay together without a
  caption over them: a row's place is in its tooltip and found by the search, and a choice value is tagged with its
  column.
* **The All labels sheet can float.** Dragged by its header, it floats over the page, so what it covered (a field at
  the right of a form) can be clicked, and the translation bar takes its usual room again. **Dock to the right** in
  its header, or a double-click on the header, docks it again; docked or floating, and where it floats, are kept in
  your preferences. A popup opened from a row points at its label, or opens beside the sheet when the sheet covers it.
* **Emptying a translation works everywhere.** A translation in a language other than the base one can be emptied in
  the popup, the editor card, the Workbench and by Undo. Where Dataverse can remove it (the names and descriptions of
  views, charts, forms, dashboards, apps and processes, modern command labels, related menu items, the app's
  navigation) it is removed. Where it can't (table, column, choice and relationship names; form and dashboard tab,
  section and field labels; classic button labels; a process stage or step translation Dynamics keeps), the save
  writes the text that language shows without a translation of its own, so the page looks the same:
  a field label gets its column's name in that language, else the column's base-language name; anything else gets
  its own base-language text. The popup and the editor card say it under the emptied input (*Becomes “Start date”:
  Dataverse can't remove a translation here, so French gets the English text.*), the Publish dialog shows the text
  written with a note, and the Workbench shows it in the cell, muted, with a tooltip saying why. Before writing such a
  text, the save reads the texts it comes from again: one that changed on the server since it was loaded fails that
  change, and nothing of it is written. Where there is no such text (an empty base text, or a field label whose
  column's names aren't loaded), nothing is written and the change says why, or what to load. An empty cell in an
  imported workbook or CSV still changes nothing.
* **An emptied tooltip or description is saved empty.** The description of a table, a column (the field's tooltip), a
  choice value, a Yes/No value, a status or status reason, a global choice or one of its values, emptied in a
  language other than the base one, is saved empty, whatever its English text: Dataverse stores an empty text for that
  language alone, and French users then see no tooltip or description there. The popup and the editor card say
  *Saved empty: French users see no tooltip.* under the emptied input, the Publish dialog and Recent publishes show
  the row as *… → (empty)* with that note, and the Workbench shows a muted *(empty)* in the cell. A description saved
  empty counts as translated (its input says *No French tooltip*, All labels doesn't list it as *Not translated*, the
  Workbench's *French is blank* leaves it out); one never translated stays orange and says *Shows “…”* with the
  English text its users see. Undo puts the earlier text back: the English text where the publish gave a description
  its first French text (an empty text where its English text is empty too), an empty text again where it was saved
  empty before. Someone saving a description empty after you loaded it is a conflict for a text you typed there, and
  an empty text Dataverse didn't keep is reported, never called saved. Names, form labels and classic button labels
  keep the rule above, and the descriptions of views, charts and processes are still removed.
* **Review and publish** shows every change before anything is written, saves, and publishes only the components that
  changed. In translation mode it then refreshes the page, and when you start the translator again within the hour it
  checks that the page shows the new text (it speaks up only when the page doesn't show it yet, with **Refresh
  again**). In the Workbench it offers **Refresh page** instead. A translation worded like the base text is not
  flagged: many labels read the same in both languages.
* **Recent publishes** keeps 90 days of your publishes in this browser, each with exactly what it changed, and Undo
  with a preview of what the Undo will do. A translation the publish added where Dataverse can't remove one gets the
  text that language shows without it, as the Undo question says (*1 translation this publish added gets the English
  text in its place: Dataverse can't remove it.*), so the page looks as it did before the publish. Only one with no
  such text stays as it is (a tooltip or description is saved empty then). A text a publish found already on the
  server is not counted as its change, and its Undo leaves that text alone, also after **Try again**: only the
  translator's own earlier write of that text, sent and not refused, whose answer was lost or didn't confirm it,
  counts as the publish's, never an attempt that was refused, turned away or stopped before its write. Another account
  signed in to the same browser profile doesn't see your publishes, and the history an earlier build kept for the
  whole environment is removed without being read.
* **The Workbench**: a spreadsheet of every label of the tables and options you choose, in the layout of XrmToolBox's
  Easy Translator workbook, with Excel and CSV export and import, paste and fill, and the same Review and publish.
  When the translator was started on a record, a list or a dashboard, its window's ✕ (*Back to page (Alt+1)*) goes
  back to the page; started on any other page, it closes the translator. *Fill down* (Ctrl+D), and pasting the
  Workbench's own copy, never copy a cell whose text isn't loaded as if it were empty; a paste or cut the browser
  answers late changes only the cells still selected; **Extract translations** waits for a newly chosen solution's
  tables; **Find and replace** never freezes the page: a regular expression searches in the background and is stopped
  after 1.5 seconds with nothing changed (the dialog says *Searching…* when it takes more than 0.2 seconds, and text
  typed after a click on **Change** while it searches is previewed first, never dropped by that click), one that
  could take minutes on a label is refused before it runs, and where the page blocks the background search, so is any
  that could keep the page busy.
* **Imports stage only what the file says clearly.** A cell holding an Excel error (#N/A, #DIV/0!…) is listed with the
  skipped rows, never imported as a translation. Two rows giving one label the same text import it once; different
  texts import neither, and each row says where the other is. An id that matches several labels only when case is
  ignored (classic command bar ids can differ only in case) imports none of them, saying why. A file with two columns
  for one language, a workbook holding a row or a cell twice, or a cell whose address names another row, lies outside
  the sheet or is no address, and a CSV file with a quote that never closes are refused, saying where (a sheet by its
  tab's name).
* **Form labels that couldn't be read are never shown as empty.** Every language whose read of the form labels
  failed, and every form a read left out, is read once more (one form at a time when a batch fails again). What still
  can't be read shows *Not loaded* in the Workbench and is never written: the cell's tooltip says why, and after
  **Extract translations** or an import the message bar says how many forms and which languages could not be read,
  with a **Read again** link that reads only those forms and languages (a *Not loaded* cell offers it too when you
  press Enter on it, where reading again can help). A form that can't be read at all is left out and reported instead
  of failing the others. A form that has no unpublished definition in Dynamics gets its tab and section labels in
  every language; its field labels stay known in your language only, and the Workbench's cells say why.
* **Refresh page** and *Show Dynamics in* in the ⋯ menu: the first clears the copies of labels that Dynamics keeps
  in the browser and loads the page again, so it shows what is published now (it asks first when the record has
  unsaved changes, or when Dynamics can't tell whether it has); the second changes your Dynamics language for good,
  then refreshes the page in it.
* **No suggestions.** The translator never proposes a translation: what you type is what is published.

**Security and privacy review**

* Table names and ids that come from an imported workbook or CSV, from the page's address or from browser storage are
  checked before they reach a Web API request: a table name must be a logical name and an id a GUID. A row naming
  anything else is skipped with its reason. A `$batch` part whose address or headers contain a control character is
  never sent, and a table read that Dataverse answers with another table's name is refused.
* The "switch your language back" request that the translator sends when the page goes away is sent only when the
  page really goes away (`pagehide`), not when the browser asks "Leave site?" and you choose to stay.
* A process stage or step name that starts with `{` is written with XAML's `{}` escape, so the process stays valid.
* The language repair marker in browser storage is checked: a marker that names a language the environment doesn't
  have, or a wait longer than any switch could need, is ignored.
* **Refresh page** requests again only the cached label requests of the page's own site.
* The development server answers only local requests from `*.dynamics.com` pages, and only GET, HEAD and OPTIONS.
* Customer and environment names were removed from the test data, the comments and the findings log.
