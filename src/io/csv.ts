// CSV per RFC 4180: comma separated, CRLF rows, fields with a quote, delimiter or line break quoted.
// Reading accepts a BOM, any line ending and comma, semicolon (European Excel) or tab delimiters.

// Excel runs a field starting with = + - @ (or tab/CR) as a formula, so such values get a leading
// apostrophe on export (after any apostrophes they start with); unguard removes exactly one again, so
// "=Total", "'=Total" or "-- None --" round-trip unchanged and never execute. Only a file that says it is ours is
// unguarded (io/workbook.ts CSV_KEY): in any other an apostrophe is text.
const RISKY = /^'*[=+\-@\t\r]/;
export const unguard = (s: string): string => (/^'+[=+\-@\t\r]/.test(s) ? s.slice(1) : s);

export function toCsv(rows: Array<Array<string | number | null>>): string {
  return rows
    .map((r) =>
      r
        .map((v) => {
          let s = v === null || v === undefined ? '' : String(v);
          if (typeof v === 'string' && RISKY.test(s)) s = "'" + s;
          return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
        })
        .join(','),
    )
    .join('\r\n') + '\r\n';
}

/**
 * `guarded`: the file comes from toCsv, whose apostrophes are removed (false: every apostrophe is text).
 * `readable`: whether the caller reads a header row of these fields (io/workbook.ts), which then names the delimiter.
 * A quoted field that never closes, or has more text after its closing quote (other than spaces), is a damaged file
 * (cut short, or a quote typed or deleted by hand): read on, it would take the rows after it into one field, so it is
 * refused, naming the line.
 */
export function parseCsv(text: string, guarded = true, readable?: (head: string[]) => boolean): string[][] {
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  // The header row under each candidate, read as the whole file is (a quoted field may hold line breaks and the other
  // candidates); none under one that finds it damaged.
  const ds = [',', ';', '\t'];
  const heads = ds.map((d) => {
    try {
      return rowsOf(text, d, guarded, true)[0] ?? [];
    } catch {
      return null;
    }
  });
  // The delimiter is the one under which the caller reads the header row. A row read under two (only one made to be
  // read both ways is) could stage, either way, labels the other way doesn't: which one the file uses is not known, so
  // it is refused. Read under none, the one that splits it into the most fields (the earlier on a tie).
  const ok = readable ? ds.filter((_, i) => !!heads[i] && readable(heads[i]!)) : [];
  if (ok.length > 1) {
    const ways = ok.map((d) => `as columns split at ${d === ',' ? 'commas' : d === ';' ? 'semicolons' : 'tabs'}`);
    throw new Error(`Which separator this CSV file uses is not clear: its header row can be read ${ways.slice(0, -1).join(', ')} and ${ways[ways.length - 1]}. Keep only the separator it uses in that row, then import again.`);
  }
  const ws = heads.map((h) => h?.length ?? 0);
  return rowsOf(text, ok[0] ?? ds[ws.indexOf(Math.max(...ws))], guarded, false);
}

/** The rows of `text` split by delimiter `d` (parseCsv), only its first one when `one`. */
function rowsOf(text: string, d: string, guarded: boolean, one: boolean): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let f = '';
  let q = false;
  // Lines of the file (a quoted field may hold line breaks): the current one, the one the quoted field starts on, and
  // whether the field's closing quote has been read.
  let line = 1;
  let from = 0;
  let shut = false;
  const damaged = (what: string) => new Error(`The CSV file is damaged (${what}). Check the quotes there, then import again.`);
  const end = () => {
    row.push(guarded ? unguard(f) : f);
    f = '';
    shut = false;
  };
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c !== '"') {
        f += c;
        if (c === '\n' || (c === '\r' && text[i + 1] !== '\n')) line++;
      } else if (text[i + 1] === '"') f += text[i++];
      else {
        q = false;
        shut = true;
      }
    } else if (c === d) end();
    else if (c === '\n' || c === '\r') {
      end();
      rows.push(row);
      if (one) return rows;
      row = [];
      line++;
      if (c === '\r' && text[i + 1] === '\n') i++;
    } else if (shut && c !== ' ' && c !== '\t')
      throw damaged(from === line ? `line ${line} has more text after the closing quote of a quoted field` : `the quoted text that starts on line ${from} ends on line ${line} with more text after its closing quote`);
    else if (c === '"' && !f) {
      q = true;
      from = line;
    } else f += c;
  }
  if (q) throw damaged(`the quoted text that starts on line ${from} has no closing quote`);
  if (f || row.length) {
    end();
    rows.push(row);
  }
  return rows;
}
