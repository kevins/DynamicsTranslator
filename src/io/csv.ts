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
 * A quoted field that never closes, or has more text after its closing quote (other than spaces), is a damaged file
 * (cut short, or a quote typed or deleted by hand): read on, it would take the rows after it into one field, so it is
 * refused, naming the line.
 */
export function parseCsv(text: string, guarded = true): string[][] {
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  // The delimiter is whichever candidate occurs most often in the header line (outside quotes).
  const nl = text.search(/[\r\n]/);
  const head = (nl < 0 ? text : text.slice(0, nl)).replace(/"[^"]*"/g, '');
  const d = [',', ';', '\t'].reduce((a, b) => (head.split(b).length > head.split(a).length ? b : a));
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
