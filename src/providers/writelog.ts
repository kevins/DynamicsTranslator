// The last metadata writes of this page, for support: the Publish dialog's "Copy details" on a failed row copies those of
// its component as plain text (ui/review.ts). What each write sent and what Dataverse answered (status, request id), what
// the read right after it and the solution layers (layers.ts) showed, and the save's outcome. In memory only, the last MAX.

export interface WriteItem {
  /** The change: `key#lcid`. */
  id: string;
  /** Its property and language, as the details name them ("DisplayName, French (1036)"). */
  what: string;
  /** The text the read before the write showed there, the text written, the text the read right after it showed. */
  before: string;
  wrote: string;
  read?: string;
  /** Each layer check of it (layers.ts), in order. */
  layers: string[];
  /** What the save reported for it in the end. */
  outcome?: string;
}
export interface WriteCall {
  /** Method and URL. */
  req: string;
  /** "HTTP 204", or the failure. */
  status: string;
  /** The answer's x-ms-service-request-id ('' when none). */
  requestId: string;
}
export interface WriteAttempt {
  at: number;
  /** The save group (slot.group) and its title. */
  group: string;
  title: string;
  /** The requests of this write (two when Dataverse refused part of the first, see saveOption). */
  calls: WriteCall[];
  items: WriteItem[];
}

const MAX = 30;
const LOG: WriteAttempt[] = [];

/** Keeps a write of this page (the oldest beyond MAX goes); returns it, to be filled in as the save goes on. */
export function logWrite(a: WriteAttempt): WriteAttempt {
  LOG.push(a);
  if (LOG.length > MAX) LOG.splice(0, LOG.length - MAX);
  return a;
}

/** This page's kept writes of a save group, oldest first. */
export const writesOf = (group: string): WriteAttempt[] => LOG.filter((a) => a.group === group);

/** A text as written in the details: exact (quotes, apostrophes, spaces), and visibly empty. */
const show = (t: string | undefined): string => (t === undefined ? '(not read)' : JSON.stringify(t));

/** The plain-text details of this page's kept writes of `group`, after the lines of `head` ('' when there are none). */
export function writeDetails(group: string, head: string[] = []): string {
  const list = writesOf(group);
  if (!list.length) return '';
  const out = ['Dynamics Translator: metadata write details', ...head, `Writes of this component kept by this page: ${list.length} (times in UTC)`];
  list.forEach((a, i) => {
    out.push('', `${i + 1}. ${new Date(a.at).toISOString()}  ${a.title}`);
    for (const c of a.calls) out.push(`   ${c.req} -> ${c.status}${c.requestId ? `, x-ms-service-request-id ${c.requestId}` : ''}`);
    if (!a.calls.length) out.push('   (no request sent)');
    for (const it of a.items) {
      out.push(`   ${it.what}: before ${show(it.before)}, wrote ${show(it.wrote)}, read back ${show(it.read)}`);
      for (const l of it.layers) out.push(`     layers ${l}`);
      out.push(`     outcome: ${it.outcome ?? '(not finished)'}`);
    }
  });
  return out.join('\n');
}
