'use strict';

const MAX_HEIGHT_RATIO = 1.35;
const MIN_LINE_ADVANCE_RATIO = 0.6;
const MAX_LINE_OVERLAP_RATIO = 0.35;
const MAX_GAP_RATIO = 0.9;
const LEFT_ALIGNMENT_RATIO = 0.65;
const MIN_HORIZONTAL_OVERLAP_RATIO = 0.25;

function validLine(line, bounds) {
  if (!line || typeof line.text !== 'string' || !line.text.trim()) return false;
  const { x, y, width, height } = line;
  return [x, y, width, height, bounds?.width, bounds?.height].every(Number.isFinite)
    && bounds.width > 0 && bounds.height > 0
    && x >= 0 && y >= 0 && width > 0 && height > 0
    && x + width <= bounds.width + 1 && y + height <= bounds.height + 1;
}

function canJoin(previous, current, first, bounds) {
  if (!validLine(previous, bounds) || !validLine(current, bounds) || !validLine(first, bounds)) return false;

  const smallerHeight = Math.min(previous.height, current.height);
  const largerHeight = Math.max(previous.height, current.height);
  if (smallerHeight / largerHeight < 1 / MAX_HEIGHT_RATIO) return false;

  const topAdvance = current.y - previous.y;
  const gap = current.y - (previous.y + previous.height);
  if (topAdvance < smallerHeight * MIN_LINE_ADVANCE_RATIO
      || gap < -smallerHeight * MAX_LINE_OVERLAP_RATIO
      || gap > Math.max(largerHeight * MAX_GAP_RATIO, 2)) return false;

  const aligned = Math.abs(first.x - current.x) <= largerHeight * LEFT_ALIGNMENT_RATIO
    || Math.abs(previous.x - current.x) <= largerHeight * LEFT_ALIGNMENT_RATIO;
  const overlap = Math.min(previous.x + previous.width, current.x + current.width)
    - Math.max(previous.x, current.x);
  const overlaps = overlap > 0 && overlap >= Math.min(previous.width, current.width) * MIN_HORIZONTAL_OVERLAP_RATIO;
  return aligned || overlaps;
}

function mergeBounds(paragraph, line) {
  const left = Math.min(paragraph.x, line.x);
  const top = Math.min(paragraph.y, line.y);
  const right = Math.max(paragraph.x + paragraph.width, line.x + line.width);
  const bottom = Math.max(paragraph.y + paragraph.height, line.y + line.height);
  paragraph.x = left;
  paragraph.y = top;
  paragraph.width = right - left;
  paragraph.height = bottom - top;
  paragraph.text += `\n${line.text}`;
}

// 只合并已通过质量筛选的本地 WinRT OCR 原始行；单次扫描保持 O(n)。
function groupOcrLines(lines, bounds) {
  if (!Array.isArray(lines) || lines.length < 2) return Array.isArray(lines) ? lines.map(line => ({ ...line })) : [];
  const grouped = [];
  let previous = null;
  let first = null;

  for (const line of lines) {
    if (previous && first && canJoin(previous, line, first, bounds)) {
      mergeBounds(grouped[grouped.length - 1], line);
    } else {
      grouped.push({ ...line });
      first = line;
    }
    previous = line;
  }
  return grouped;
}

function groupOcrCandidate(candidate, bounds) {
  if (!candidate || !Array.isArray(candidate.blocks) || !candidate.quality?.reliable) return candidate;
  return { ...candidate, blocks: groupOcrLines(candidate.blocks, bounds) };
}

module.exports = { groupOcrLines, groupOcrCandidate };
