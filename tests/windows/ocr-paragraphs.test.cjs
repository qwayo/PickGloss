'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const { groupOcrLines } = require('../../src/windows/ocr-paragraphs.cjs');
const { recognizeWindows } = require('../../src/windows/ocr.cjs');

const bounds = { width: 400, height: 200 };

function makeImage(width, height) {
  const image = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jC1kAAAAASUVORK5CYII=', 'base64');
  image.writeUInt32BE(width, 16);
  image.writeUInt32BE(height, 20);
  return `data:image/png;base64,${image.toString('base64')}`;
}

function spawnWith(result) {
  return () => {
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.stdin = new PassThrough();
    child.kill = () => {};
    setImmediate(() => {
      child.stdout.end(JSON.stringify(result));
      child.emit('close', 0);
    });
    return child;
  };
}

test('相近换行以原文换行合并，并以合并外接框支持覆盖译文', () => {
  const lines = [
    { text: '第一行较长', x: 20, y: 10, width: 160, height: 20 },
    { text: '第二行续写', x: 22, y: 35, width: 110, height: 20 },
  ];
  assert.deepEqual(groupOcrLines(lines, bounds), [{
    text: '第一行较长\n第二行续写', x: 20, y: 10, width: 160, height: 45,
  }]);
  assert.equal(lines.length, 2, '不应改写 WinRT 原始行');
});

test('明显大空白及字号差异保留为不同段落', () => {
  const largeGap = [
    { text: '上段', x: 20, y: 10, width: 60, height: 20 },
    { text: '下段', x: 20, y: 70, width: 60, height: 20 },
  ];
  assert.equal(groupOcrLines(largeGap, bounds).length, 2);

  const differentSize = [
    { text: '正文', x: 20, y: 10, width: 70, height: 20 },
    { text: '大号标题', x: 20, y: 35, width: 100, height: 38 },
  ];
  assert.equal(groupOcrLines(differentSize, bounds).length, 2);
});

test('同一行的不同列不串成同一段', () => {
  const columns = [
    { text: '左列第一行', x: 20, y: 20, width: 130, height: 20 },
    { text: '右列第一行', x: 240, y: 20, width: 130, height: 20 },
    { text: '左列第二行', x: 20, y: 46, width: 130, height: 20 },
    { text: '右列第二行', x: 240, y: 46, width: 130, height: 20 },
  ];
  assert.deepEqual(groupOcrLines(columns, bounds).map(line => line.text), columns.map(line => line.text));

  const staggeredColumns = [
    { text: '左列下行', x: 20, y: 20, width: 120, height: 20 },
    { text: '右列错位行', x: 240, y: 45, width: 120, height: 20 },
  ];
  assert.deepEqual(groupOcrLines(staggeredColumns, bounds).map(line => line.text), staggeredColumns.map(line => line.text));
});

test('无效原行几何不会被聚合成看似有效的外接框', () => {
  const invalid = { text: '负高度框', x: 40, y: 30, width: 60, height: -8 };
  const following = { text: '后续行', x: 40, y: 35, width: 50, height: 20 };
  const grouped = groupOcrLines([invalid, following], bounds);
  assert.equal(grouped.length, 2);
  assert.deepEqual(grouped[0], invalid);
  assert.deepEqual(grouped[1], following);
});

test('WinRT 候选先按原始行判质量；低质量不合并且候选角度保留', async () => {
  const candidate = {
    language: 'zh-Hans', angle: 6.5,
    blocks: ['0', '」', '3', '《', '僅', 'hin'].map((text, index) => ({
      text, x: 20, y: 10 + index * 11, width: 30, height: 10,
    })),
  };
  const selected = await recognizeWindows({
    imageData: makeImage(bounds.width, bounds.height), sourceLanguage: 'auto', spawnImpl: spawnWith({ ok: true, candidates: [candidate] }),
  });

  assert.deepEqual(selected.quality, { reliable: false, reason: 'quality' });
  assert.equal(selected.blocks.length, candidate.blocks.length, '不能让段落聚合改变低质量后备判定');
  assert.equal(selected.angle, 6.5);
});

test('可靠 WinRT 行合并后仍保留 TextAngle 供 core 校正', async () => {
  const selected = await recognizeWindows({
    imageData: makeImage(bounds.width, bounds.height), sourceLanguage: 'auto',
    spawnImpl: spawnWith({ ok: true, candidates: [{
      language: 'en-US', angle: 6.5,
      blocks: [
        { text: 'First wrapped line', x: 20, y: 10, width: 170, height: 20 },
        { text: 'Second wrapped line', x: 21, y: 35, width: 180, height: 20 },
      ],
    }] }),
  });

  assert.deepEqual(selected.quality, { reliable: true });
  assert.equal(selected.blocks.length, 1);
  assert.equal(selected.blocks[0].text, 'First wrapped line\nSecond wrapped line');
  assert.equal(selected.angle, 6.5);
});
