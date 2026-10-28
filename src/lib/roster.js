// A school's class list, pasted straight from Excel or Google Sheets or read from a .csv file: one row per learner with
// their email, name, year and classes. A header row says which column is which; without one: email, name, year, classes.
// Years: "Year 10" (and plain numbers in a Year column) are UK years, a grade lower (Year 10 = Grade 9); "Grade 9", and
// plain numbers in a Grade or Form column, are grades.
export function parseTable(text) {
  const lines = String(text || '').replace(/\r\n?/g, '\n').split('\n').filter((l) => l.trim());
  if (!lines.length) return [];
  const sep = lines.some((l) => l.includes('\t')) ? '\t' : lines[0].split(';').length > lines[0].split(',').length ? ';' : ',';
  const cells = (line) => {
    if (sep === '\t') return line.split('\t').map((x) => x.trim());
    const out = [];
    let cur = '';
    let quoted = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (ch === '"' && quoted && line[i + 1] === '"') (cur += '"'), i++;
      else if (ch === '"') quoted = !quoted;
      else if (ch === sep && !quoted) out.push(cur.trim()), (cur = '');
      else cur += ch;
    }
    out.push(cur.trim());
    return out;
  };
  let table = lines.map(cells);
  let col = { email: 0, name: 1, year: 2, classes: 3 };
  let yearsAreUk = true; // no header: the third column is the year
  const head = table[0].map((h) => h.toLowerCase());
  if (head.some((h) => /e-?mail/.test(h))) {
    const find = (re, not = -1) => head.findIndex((h, i) => i !== not && re.test(h));
    const year = find(/\b(year|grade|form)\b/);
    col = { email: find(/e-?mail/), name: find(/name/), year, classes: find(/\b(class(es)?|subjects?|groups?|sets?)\b/, year) };
    yearsAreUk = year >= 0 && /\byear\b/.test(head[year]) && !/\b(grade|form)\b/.test(head[year]);
    table = table.slice(1);
  }
  const grade = (v) => {
    const m = String(v || '').match(/\d{1,2}/);
    if (!m) return null;
    const n = Number(m[0]);
    const uk = /grade|form/i.test(v) ? false : /year/i.test(v) || yearsAreUk;
    return uk ? Math.max(1, n - 1) : n;
  };
  return table
    .map((r) => ({
      email: (r[col.email] || '').trim(),
      name: col.name >= 0 ? (r[col.name] || '').trim() : '',
      grade: col.year >= 0 ? grade(r[col.year]) : null,
      classes: col.classes >= 0 ? String(r[col.classes] || '').split(sep === '\t' ? /[;,|]/ : /[;|]/).map((x) => x.trim()).filter(Boolean) : [],
    }))
    .filter((r) => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(r.email));
}
