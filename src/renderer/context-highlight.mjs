// 仅拆分纯文本；保留原文中的空白和大小写，不解析选区中的 HTML 或正则语法。
export function contextParts(context, selected) {
  const source = String(context || ''), needle = String(selected || '').trim();
  if (!needle) return [{ text: source, selected: false }];
  const pattern = needle.split(/\s+/u).map(part => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('\\s+');
  const matches = source.matchAll(new RegExp(pattern, 'gu'));
  const parts = []; let offset = 0;
  for (const match of matches) {
    if (match.index > offset) parts.push({ text: source.slice(offset, match.index), selected: false });
    parts.push({ text: match[0], selected: true }); offset = match.index + match[0].length;
  }
  if (offset < source.length || !parts.length) parts.push({ text: source.slice(offset), selected: false });
  return parts;
}
