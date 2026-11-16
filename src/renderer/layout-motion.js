// 重排前淡出，重排后淡入；只处理现有内容节点，窗口底面和置顶描边始终保留。
export function createLayoutContentTransition(root, { previous, delay = 0, reduced = false } = {}) {
  const host = root.ownerDocument.documentElement;
  const nodes = () => [...(root.querySelector('.panel')?.children || [])]
    .filter(node => !node.classList.contains('native-pin-frame'));
  // 反向切换从当前透明度接续，取消旧动画和建立新动画在同一帧完成。
  const starting = nodes().map(node => [node, getComputedStyle(node).opacity]);
  previous?.cancel();
  let animations = [], done = false, resolveHidden, resolveFinished;
  const hidden = new Promise(resolve => { resolveHidden = resolve; });
  const finished = new Promise(resolve => { resolveFinished = resolve; });
  const clear = () => {
    for (const animation of animations) animation.cancel();
    animations = [];
  };
  const finish = () => {
    if (done) return;
    done = true;
    clear();
    host.classList.remove('layout-content-hidden');
    resolveHidden(); resolveFinished();
  };
  const hideImmediately = () => {
    if (done) return;
    host.classList.add('layout-content-hidden');
    clear(); resolveHidden();
  };
  const animate = (entries, opacity, duration, startDelay = 0) => {
    animations = entries.map(([node, from]) => node.animate([{ opacity: from }, { opacity }], {
      duration, delay: startDelay, easing: 'cubic-bezier(.4,0,.2,1)', fill: 'both',
    }));
    return Promise.all(animations.map(animation => animation.finished.catch(() => {})));
  };
  const reveal = (skipMotion = false) => {
    if (done) return finished;
    if (skipMotion) { finish(); return finished; }
    clear();
    const entries = nodes().map(node => [node, getComputedStyle(node).opacity]);
    host.classList.remove('layout-content-hidden');
    void animate(entries, 1, 160).then(finish);
    return finished;
  };
  if (reduced) finish();
  else {
    // CSS 保持隐藏直到新排版就绪，期间正文刷新或 DOM 重建也不会闪现。
    host.classList.add('layout-content-hidden');
    void animate(starting, 0, 100, delay).then(resolveHidden);
  }
  return { hidden, finished, reveal, hideImmediately, finish, cancel: finish };
}
