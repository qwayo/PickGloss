'use strict';

function selectAnswerTitleInk(columnCounts) {
  const clusters = [], splitEmptyColumns = 12;
  let lastInkColumn = -Infinity;
  for (let x = 0; x < columnCounts.length; x++) {
    const count = columnCounts[x];
    if (!count) continue;
    if (!clusters.length || x - lastInkColumn - 1 >= splitEmptyColumns) clusters.push({ minX: x, maxX: x, count: 0 });
    const cluster = clusters.at(-1);
    cluster.maxX = x; cluster.count += count; lastInkColumn = x;
  }
  // 固定虚构材料的阅读标题位于回答栏（x >= 240），小窗标题位于左侧。
  // 收窄时优先跟踪仍可见的回答笔画，不能因为它被裁短就换成左栏「选定内容」标签。
  const answerClusters = clusters.filter(value => value.minX >= 240);
  const candidates = answerClusters.length ? answerClusters : clusters;
  const selected = candidates.reduce((best, value) => !best || value.count > best.count ? value : best, null);
  return { minX: selected?.minX ?? null, maxX: selected?.maxX ?? null, count: selected?.count ?? 0,
    clusters, splitEmptyColumns, method: '固定虚构回答栏优先的标题墨迹簇',
    wholeBand: { minX: clusters[0]?.minX ?? null, maxX: clusters.at(-1)?.maxX ?? null, count: clusters.reduce((sum, value) => sum + value.count, 0) } };
}

// 离屏 paint 的送达可能落后于 DOM 采样。只豁免实际呈现了目标排版的终态帧对，
// 不能按时间最近就误选仍在展示旧排版的帧，否则会把正常提交误报为文字跳动。
function findLayoutCommitPaint(frames, { commitAt, motionEnd, targetWidth, fromReading, toReading }) {
  let nearest = null;
  for (let index = 1; index < frames.length; index++) {
    const previous = frames[index - 1], current = frames[index];
    if (previous.pixelReading !== fromReading || current.pixelReading !== toReading ||
      current.size.width !== targetWidth || current.at < motionEnd) continue;
    const distance = commitAt < previous.at ? previous.at - commitAt : commitAt > current.at ? commitAt - current.at : 0;
    if (!nearest || distance < nearest.distance) nearest = { index, distance, previous, current };
  }
  return nearest;
}

module.exports = { findLayoutCommitPaint, selectAnswerTitleInk };
