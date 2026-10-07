// Markdown with maths: $x^2$ inline and $$...$$ on its own line.
import { marked } from 'marked';
import DOMPurify from 'dompurify';
import { convertLatexToMarkup } from 'mathlive';

marked.setOptions({ gfm: true, breaks: true });

export function latexToHtml(latex, display = false) {
  try {
    return DOMPurify.sanitize(convertLatexToMarkup(latex, { defaultMode: display ? 'math' : 'inline-math' }));
  } catch {
    return escapeHtml(latex);
  }
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

export { plainMaths } from './plain.js';

export function renderMarkdown(src) {
  if (!src) return '';
  const math = [];
  // Pull maths out first so markdown doesn't mangle it
  let s = String(src).replace(/\$\$([\s\S]+?)\$\$/g, (_, m) => {
    math.push(`<div class="math-block">${latexToHtml(m.trim(), true)}</div>`);
    return `@@MATH${math.length - 1}@@`;
  });
  s = s.replace(/\\\(([\s\S]+?)\\\)/g, (_, m) => {
    math.push(latexToHtml(m.trim()));
    return `@@MATH${math.length - 1}@@`;
  });
  s = s.replace(/(^|[^\\$])\$([^\s$](?:[^$\n]*?[^\s$])?)\$(?!\d)/g, (_, pre, m) => {
    math.push(latexToHtml(m));
    return `${pre}@@MATH${math.length - 1}@@`;
  });
  let html = marked.parse(s);
  html = DOMPurify.sanitize(html, { ADD_ATTR: ['target'], ALLOWED_URI_REGEXP: /^(?:(?:https?|mailto|tel|sb):|[^a-z]|[a-z+.-]+(?:[^a-z+.\-:]|$))/i });
  html = html.replace(/@@MATH(\d+)@@/g, (_, i) => math[Number(i)]);
  return html;
}
