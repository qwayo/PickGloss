// 解析器只负责 Markdown 语法；显示层按允许的标签创建 DOM，不执行回答中的 HTML。
(function () {
  const parser = new window.markdownit({ html: false, linkify: false, typographer: false });
  const rendered = new WeakMap();
  const tags = new Set(['p', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'ul', 'ol', 'li', 'blockquote', 'strong', 'em', 's', 'table', 'thead', 'tbody', 'tr', 'th', 'td']);
  function safeLink(value) {
    try { const url = new URL(value); return ['http:', 'https:'].includes(url.protocol) ? url.href : ''; }
    catch { return ''; }
  }
  function render(container, source, openLink) {
    if (rendered.get(container) === source) return;
    const doc = container.ownerDocument;
    function tokensToDOM(tokens, parent) {
      const stack = [parent];
      for (const token of tokens) {
        const current = stack.at(-1);
        if (token.nesting === -1) { if (stack.length > 1) stack.pop(); continue; }
        if (token.type === 'inline') { tokensToDOM(token.children || [], current); continue; }
        if (token.type === 'text' || token.type === 'html_inline' || token.type === 'html_block') { current.append(doc.createTextNode(token.content)); continue; }
        if (token.type === 'softbreak' || token.type === 'hardbreak') { current.append(doc.createElement('br')); continue; }
        if (token.type === 'code_inline' || token.type === 'fence' || token.type === 'code_block') {
          const code = doc.createElement('code'); code.textContent = token.content;
          if (token.type === 'code_inline') current.append(code);
          else { const pre = doc.createElement('pre'); pre.append(code); current.append(pre); }
          continue;
        }
        if (token.type === 'hr') { current.append(doc.createElement('hr')); continue; }
        if (token.type === 'image' || token.type === 'link_open') {
          const href = safeLink(token.attrGet(token.type === 'image' ? 'src' : 'href'));
          const link = doc.createElement(href ? 'a' : 'span');
          if (href) {
            link.href = href;
            link.addEventListener('click', event => { event.preventDefault(); openLink?.(href); });
          }
          if (token.attrGet('title')) link.title = token.attrGet('title');
          // 远程图片不随回答自动加载；保留说明及用户主动打开的入口。
          if (token.type === 'image') link.textContent = `图片：${token.content || '查看图片'}`;
          current.append(link);
          if (token.nesting === 1) stack.push(link);
          continue;
        }
        if (token.nesting === 1) {
          const node = doc.createElement(tags.has(token.tag) ? token.tag : 'span');
          if (token.tag === 'ol' && /^\d+$/.test(token.attrGet('start') || '')) node.setAttribute('start', token.attrGet('start'));
          if (['td', 'th'].includes(token.tag)) {
            const alignment = /^text-align:(left|center|right)$/.exec(token.attrGet('style') || '');
            if (alignment) node.style.textAlign = alignment[1];
          }
          current.append(node); stack.push(node);
        } else if (token.content) current.append(doc.createTextNode(token.content));
      }
    }
    const fragment = doc.createDocumentFragment();
    tokensToDOM(parser.parse(source, {}), fragment);
    container.replaceChildren(fragment);
    rendered.set(container, source);
  }
  window.pickglossMarkdown = Object.freeze({ render });
})();
