# Security policy

## Supported versions

Only the latest release is supported. Take it from this repository's [Releases](../../releases) page. A release holds
`translator.bookmarklet.txt` (the favourite's address), `translator.min.js` (the minified code, also for the developer
console), `translator.debug.js` (the readable build of the same code) and `SHA256SUMS.txt`. Compare the SHA-256 of the
files you downloaded with the lines in that release's `SHA256SUMS.txt`.

## Reporting a vulnerability

Please use GitHub's private vulnerability reporting (**Security › Report a vulnerability** on this repository) rather
than a public issue. Describe what you did, what you expected and what happened.

Leave out your environment's address, record data and the output of **Copy details** unless they are needed, and
remove anything you don't want to share. **Copy details** contains your environment's URL and internal ids.

## How the translator is built to be safe

* **It runs as you, and only in your environment.** The translator runs inside the Dynamics 365 page you start it on
  and talks only to that environment's Dataverse Web API, with your own session and your own privileges. It has no
  server, no credentials of its own, no telemetry and no third-party requests. See the README's
  [Privacy](README.md#privacy) section.
* **What it stores** is in that site's `localStorage`, under keys that start with `dxt:` (the publish journal for Undo,
  your preferences and Workbench setup, a marker while your language is switched for a moment, and two short-lived
  markers: the translator's own label writes of the last minute, and what was just published, for the check after the
  refresh). Nothing stored is sent anywhere but back to the same environment, in the translator's own requests (an
  Undo writes the journal's texts back). The publish journal holds the texts each publish replaced and wrote, so it is kept per environment and per user (`dxt:history:<org>:<user>`):
  another account signed in to the same browser profile doesn't see it in the translator and can't undo from it. A
  journal an earlier version kept for the whole environment (`dxt:history:<org>`, with no user) is removed without
  being read, so its saves are never shown to whoever opens the translator next; they can't be undone from the
  translator any more. Anyone who opens the browser's storage itself (the developer tools) can still read it. The two
  short-lived markers hold label texts too, and are kept per environment, shared by the accounts that use the browser
  profile with it: they count for a minute and for an hour, and leave the storage at the next such write and the next
  start of translation mode. The README's [Privacy](README.md#privacy) table lists every key.
* **Untrusted text never shapes a request.** Text from imported files, from the page's address and from browser storage
  is checked before it reaches a request: table names must be logical names (`[a-z0-9_]`), ids must be GUIDs, and a
  `$batch` part whose URL or headers contain a control character is never sent. Labels are written as data (JSON
  values, or escaped XML) and never as markup.
* **An import stages only what the file says clearly**, and staging writes nothing: the Publish dialog still lists
  every change. A damaged file is refused before anything is staged: a workbook whose parts are not intact, that
  holds two parts of one name, a row or a cell twice, a cell whose address names another row than its own, or an
  address outside Excel's grid or that is no address, or that would unpack to more than 512 MB; a CSV file with a
  quote that never closes, or with text after a closing quote. So is a sheet with two columns for one language. A cell
  holding an Excel error (#N/A, #DIV/0!…) is never taken for a translation, two rows that give one label different
  texts in a language stage neither, and an id that matches several labels only when case is ignored stages none of
  them; all are listed with the skipped rows.
* **It writes only what you reviewed.** Nothing is saved until you choose Publish in the Publish dialog, which lists
  every change. Where Dataverse can't remove a translation, an emptied one is written as its stand-in, the text that
  language shows without a translation of its own (the base-language text, or a field's column name); this happens
  only when you empty such a translation or undo a publish that added one. The Publish dialog and the Undo question
  show that text before anything is written, and the texts it is made of are read again right before the write: one
  that changed meanwhile stops that change. An emptied tooltip or other description of a table, column or choice is
  the one translation written empty, on purpose, and only in that language: the Publish dialog shows it as *(empty)*
  with *Saved empty: French users see no tooltip.* Every label is read again right before it is written, and a label
  someone else changed meanwhile comes back as a conflict instead of being overwritten (except a save landing in the
  instant between that read and the write: see [Known limits](#known-limits)). Undo puts back only what its publish
  changed: a text a publish found already on the server is not journaled as its change, unless an earlier write of
  that text by the translator, sent and not refused by Dataverse, may have put it there. Form, sitemap and process
  definition edits are checked to change nothing but the labels being translated; a classic command bar label is saved
  through a translation file that holds only the edited labels, and the other languages are checked after the import.
  See the README's [Safety](README.md#safety) section.
* **Managed components are never written.** A translation of a component that comes from a managed solution would be
  an unmanaged customization layered on top of it, so the translator never makes one: such a label is read-only
  wherever it shows, whatever its managed properties allow, and is never staged, imported, saved, published or undone.
  This does not rest on the page alone: the save refuses a managed component's label, and each writer reads the
  component's own managed flag again right before its write and writes nothing when that read says managed. The update
  of a process that follows a change of its name reads the process's flag first, and is sent only when it says
  unmanaged.
* **Your language is put back.** A temporary switch of your Dynamics UI language travels in one request with its switch
  back, and is checked and repaired afterwards. Run the translator in one browser at a time: its language lock covers
  the tabs of one browser, not two browsers (or two computers) signed in as the same user.
* **Reproducible builds.** `npm ci && npm run build` recreates the files in `dist/` byte for byte from the sources, so
  a release can be checked against its tagged commit.

## Known limits

* Any script that already runs on the Dynamics site (web resources, PCF controls, browser extensions allowed on it)
  holds the same session as the translator and can read its `dxt:` keys. The translator cannot defend against such a
  script and does not try to.
* A bookmarklet is only as trustworthy as the place you got it from. Install it from this repository's releases and
  check the checksum.
* Dataverse offers no way to read, compare and write these labels in one step. A save another maker makes in the
  instant between the translator's last check and its write can still be overwritten, by every kind of write
  (business process flow definitions included). A status label's write must send the state's default status reason
  (Dataverse resets it otherwise), so a default someone else changes in that instant is set back to the one read just
  before. Avoid customizing the same component in two places at once while translating.
