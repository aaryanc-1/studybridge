// A school's class list, pasted straight from Excel or Google Sheets or read from a .csv file: one row per learner with
// their email, name, year and classes. A header row says which column is which; without one: email, name, year, classes.
// Years: "Year 10" (and plain numbers in a Year column) are UK years, a grade lower (Year 10 = Grade 9); "Grade 9", and
// plain numbers in a Grade or Form column, are grades.
export function parseTable(text) {
  const { table: rows, sep } = splitTable(text);
  if (!rows.length) return [];
  let table = rows;
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

// Rows and cells from a pasted spreadsheet or a .csv (tabs, commas or semicolons; quoted cells may hold the separator)
function splitTable(text) {
  const lines = String(text || '').replace(/\r\n?/g, '\n').split('\n').filter((l) => l.trim());
  if (!lines.length) return { table: [], sep: ',' };
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
  return { table: lines.map(cells), sep };
}

// "Monday", "mon", "Mo", "1" → 1 (Monday) … 7 (Sunday)
export function weekdayOf(v) {
  const s = String(v || '').trim().toLowerCase();
  if (/^[1-7]$/.test(s)) return Number(s);
  const i = ['mo', 'tu', 'we', 'th', 'fr', 'sa', 'su'].indexOf(s.slice(0, 2));
  return i >= 0 ? i + 1 : null;
}

// A school's timetable, one lesson per row: class, day, period, room, teacher. A header row says which column is
// which; without one they're in that order. The period is its name ("Period 1", "P1") or its start time ("09:00").
export function parseTimetable(text) {
  let { table } = splitTable(text);
  let col = { class: 0, day: 1, period: 2, room: 3, teacher: 4 };
  const head = (table[0] || []).map((h) => h.toLowerCase());
  if (head.some((h) => /\b(class|day|period)\b/.test(h))) {
    const find = (re) => head.findIndex((h) => re.test(h));
    col = { class: find(/\b(class|group|set)\b/), day: find(/\bday\b/), period: find(/\b(period|lesson|time|slot)\b/), room: find(/\broom\b/), teacher: find(/\b(teacher|staff)\b/) };
    table = table.slice(1);
  }
  const at = (r, i) => (i >= 0 ? String(r[i] || '').trim() : '');
  return table
    .map((r) => ({ class: at(r, col.class), weekday: weekdayOf(at(r, col.day)), day: at(r, col.day), period: at(r, col.period), room: at(r, col.room), teacher: at(r, col.teacher) }))
    .filter((r) => r.class && (r.day || r.period));
}
