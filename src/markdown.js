const COL_TITLES = { well: 'Went well', improve: 'Improve', actions: 'Actions' };

// Note text is untrusted. Escape inline markdown, and flatten newlines so a
// note can't open its own heading, list item or fenced block.
export function escapeMd(s) {
  return s.replace(/\s*\n\s*/g, ' ').replace(/[\\`*_{}\[\]<>#|~!]/g, '\\$&');
}

export function exportMarkdown({ board, notes }) {
  const lines = [`# ${escapeMd(board.name)}`, '', `_Exported ${new Date().toISOString().slice(0, 10)}_`, ''];
  for (const col of Object.keys(COL_TITLES)) {
    lines.push(`## ${COL_TITLES[col]}`, '');
    const inCol = notes.filter((n) => n.col === col && n.text.trim() !== '');
    if (inCol.length === 0) lines.push('_(none)_');
    for (const n of inCol) {
      const box = col === 'actions' ? '[ ] ' : '';
      const votes = n.votes > 0 ? ` _(${n.votes} vote${n.votes === 1 ? '' : 's'})_` : '';
      const by = !board.anonymous && n.authorName ? ` — ${escapeMd(n.authorName)}` : '';
      lines.push(`- ${box}${escapeMd(n.text)}${votes}${by}`);
    }
    lines.push('');
  }
  return lines.join('\n');
}
