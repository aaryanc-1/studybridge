// Where the learner is with each assignment
export function workState(a, attempts) {
  const mine = attempts.filter((t) => t.assignment_id === a.id).sort((x, y) => y.number - x.number);
  const last = mine[0];
  const used = mine.length;
  if (!last) return { key: 'todo', label: 'To do', tone: '', last, used };
  if (last.status === 'in_progress') return { key: 'doing', label: 'In progress', tone: 'accent', last, used };
  if (last.status === 'returned') return { key: 'redo', label: 'Redo requested', tone: 'warn', last, used };
  if (last.status === 'submitted' || (last.status === 'marked' && !last.released)) return { key: 'waiting', label: 'Submitted · being marked', tone: '', last, used };
  return { key: 'marked', label: last.score != null ? `Marked · ${Number(last.score)}/${Number(last.max_score)}` : 'Marked', tone: 'good', last, used, canRetry: used < a.max_attempts };
}

export const needsAction = (s) => s.key === 'todo' || s.key === 'doing' || s.key === 'redo';
