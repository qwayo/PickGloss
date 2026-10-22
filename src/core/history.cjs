'use strict';

const { MODES } = require('./validation.cjs');

function sessionTitle(session) {
  if (session.title?.trim()) return session.title.trim();
  const material = session.kind === 'image' ? session.note : session.text;
  return (material || '').trim().replace(/\s+/g, ' ').slice(0, 200) || (session.kind === 'image' ? '截图讲解' : '文字解释');
}

function shortText(value, limit) {
  if (typeof value !== 'string') return '';
  // 保留字面文本，不解析 HTML；截断不能留下半个 Unicode 代理对。
  return value.replace(/\s+/g, ' ').trim().slice(0, limit).replace(/[\uD800-\uDBFF]$/, '');
}

function previewText(value) {
  if (typeof value !== 'string') return '';
  // 派生展示只清洗有限前缀，避免超长未闭合 Markdown 导致正则反复回溯。
  // 完整回答与下方 searchText 索引不受这个展示预算影响。
  return shortText(value.slice(0, 2048)
    .replace(/^\s*(?:`{3,}|~{3,})[^\n]*$/gm, '')
    .replace(/!?\[([^\]\n]*)\]\([^\n)]*\)/g, '$1')
    .replace(/!?\[([^\]\n]+)\]\[[^\]\n]*\]/g, '$1')
    .replace(/^\s*\[[^\]\n]+\]:\s+.*$/gm, '')
    .replace(/^(?:\s{0,3}(?:#{1,6}|>|[-+*]|\d+[.)])\s+)+/gm, '')
    .replace(/(`{1,2}|\*\*|__|~~)([\s\S]*?)\1/g, '$2')
    .replace(/\*([^*\n]+)\*|_([^_\n]+)_/g, (_match, stars, underscores) => stars ?? underscores)
    .replace(/\\([\\`*{}\[\]()#+\-.!_>])/g, '$1'), 200);
}

function sessionPreview(session) {
  const messages = session.threads?.[session.activeMode]?.messages || [];
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index];
    if (message.role !== 'assistant') continue;
    const preview = previewText(message.content);
    if (preview) return preview;
  }
  return [session.context, session.note, session.text].map(previewText).find(Boolean) || '';
}

function historyEntry(session) {
  const title = sessionTitle(session);
  return {
    id: session.id, kind: session.kind, title, text: session.text, note: session.note, saved: session.saved,
    createdAt: session.createdAt, updatedAt: session.updatedAt, lastActivityAt: session.lastActivityAt,
    activeMode: session.activeMode,
    preview: sessionPreview(session), sourceLabel: shortText(session.source?.app, 80) || '未知来源',
    modesWithMessages: MODES.filter(mode => session.threads[mode].messages.length > 0),
    // 索引只留在主进程；不包含未发送草稿，也不把全部问答反复传给窗口。
    searchText: [title, session.text, session.context, session.note,
      ...MODES.flatMap(mode => session.threads[mode].messages.map(message => message.content))].join('\n').toLocaleLowerCase(),
  };
}

function queryHistory(entries, { query = '', savedOnly = false } = {}) {
  const needle = query.trim().toLocaleLowerCase();
  return entries.filter(entry => (!savedOnly || entry.saved) && (!needle || entry.searchText.includes(needle)))
    .sort((a, b) => Date.parse(b.lastActivityAt) - Date.parse(a.lastActivityAt) ||
      Date.parse(b.createdAt) - Date.parse(a.createdAt) || a.id.localeCompare(b.id))
    .map(({ searchText, ...entry }) => entry);
}

module.exports = { sessionTitle, historyEntry, queryHistory };
