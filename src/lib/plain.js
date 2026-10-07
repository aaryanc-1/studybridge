// Maths and formatting as plain text (for WhatsApp, email, notifications): $x^2-25$ → x² − 25, **bold** → bold
const SUP = { 0: '⁰', 1: '¹', 2: '²', 3: '³', 4: '⁴', 5: '⁵', 6: '⁶', 7: '⁷', 8: '⁸', 9: '⁹', n: 'ⁿ', '-': '⁻', '+': '⁺' };
export function plainMaths(src) {
  if (!src) return '';
  const tex = (m) =>
    m
      .replace(/\\(left|right)/g, '')
      .replace(/\\frac\{([^{}]*)\}\{([^{}]*)\}/g, '($1)/($2)')
      .replace(/\\sqrt\{([^{}]*)\}/g, '√($1)')
      .replace(/\^\{([0-9n+-]+)\}/g, (_, p) => [...p].map((c) => SUP[c] || c).join(''))
      .replace(/\^([0-9n])/g, (_, c) => SUP[c])
      .replace(/\\times/g, '×')
      .replace(/\\div/g, '÷')
      .replace(/\\pm/g, '±')
      .replace(/\\le(q)?/g, '≤')
      .replace(/\\ge(q)?/g, '≥')
      .replace(/\\ne(q)?/g, '≠')
      .replace(/\\pi/g, 'π')
      .replace(/\\cdot/g, '·')
      .replace(/\\Rightarrow/g, '⇒')
      .replace(/\\[a-zA-Z]+/g, '')
      .replace(/[{}]/g, '')
      .replace(/\s*-\s*/g, ' − ')
      .replace(/^ − /, '−');
  return String(src)
    .replace(/\$\$([\s\S]+?)\$\$/g, (_, m) => tex(m.trim()))
    .replace(/\$([^$\n]+?)\$/g, (_, m) => tex(m))
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/(^|\s)\*([^*\n]+)\*(?=\s|$)/g, '$1$2');
}
