'use strict';

// 使用隔离状态检查设置与粘贴页的排版，不读取真实设置、不访问网络。
const { app, BrowserWindow, ipcMain } = require('electron');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { setTimeout: delay } = require('node:timers/promises');
const { applySettingsFixture } = require('./settings-fixture.cjs');

const root = path.resolve(__dirname, '..');
const outputIndex = process.argv.indexOf('--output-dir');
const artifacts = outputIndex >= 0
  ? path.resolve(process.argv[outputIndex + 1])
  : path.join(root, 'output/verification/2026-10-27-settings-visual');
app.setPath('userData', path.join(os.tmpdir(), `pickgloss-settings-visual-data-${process.pid}`));

const current = {
  view: 'settings', settingsSection: 'general', history: [], status: {},
  settingsFilePath: '虚构设置路径',
  settings: {
    text: { providerId: 'custom', baseUrl: 'https://text.mock.invalid/v1', model: '虚构文字模型', hasKey: false },
    vision: { providerId: 'custom', baseUrl: '', model: '', hasKey: false },
    translation: { providerId: 'custom', baseUrl: '', model: '', hasKey: false },
    search: { providerId: 'exa', baseUrl: 'https://search.mock.invalid', hasKey: false },
    serviceProfiles: { text: {}, vision: {}, translation: {}, search: {} },
    prefs: { showOrb: true, selectionEnabled: true, pinSound: true, autoExplainCapture: false, launchAtLogin: false },
  },
  serviceCatalog: {
    models: [{ id: 'custom', name: '自定义', baseUrl: '', model: '' }],
    search: [{ id: 'exa', name: 'Exa', baseUrl: 'https://search.mock.invalid' }],
  },
};

let win;
async function pushState() {
  const seen = new Promise(resolve => ipcMain.once('test:state-seen', resolve));
  win.webContents.send('test:state', current);
  await seen;
}

ipcMain.handle('test:invoke', async (_, action, payload = {}) => {
  if (action === 'bootstrap') return { ok: true, value: current };
  if (action === 'save-settings') {
    await delay(350);
    current.settings = applySettingsFixture(current.settings, payload);
    await pushState();
    return { ok: true, value: current.settings };
  }
  if (action === 'open-settings') {
    current.view = 'settings';
    current.settingsSection = payload.section === 'general' ? 'general' : 'service';
    await pushState();
    return { ok: true };
  }
  if (action === 'navigate') {
    current.view = payload.view;
    await pushState();
    return { ok: true };
  }
  return { ok: true };
});

async function waitFor(expression, label) {
  for (let i = 0; i < 150; i++) {
    if (await win.webContents.executeJavaScript(expression)) return;
    await delay(20);
  }
  throw new Error(`等待超时：${label}`);
}

async function snapshot(name) {
  await win.webContents.executeJavaScript('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
  await fs.mkdir(artifacts, { recursive: true });
  await fs.writeFile(path.join(artifacts, name), (await win.webContents.capturePage()).toPNG());
}

app.whenReady().then(async () => {
  const watchdog = setTimeout(() => { console.error('视觉检查超时'); app.exit(1); }, 30000);
  try {
    win = new BrowserWindow({ show: false, width: 300, height: 520, useContentSize: true, offscreen: true,
      webPreferences: { preload: path.join(root, 'tests/renderer/streaming.preload.cjs'), contextIsolation: true, sandbox: true, backgroundThrottling: false } });
    win.webContents.session.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*'] }, (_, callback) => callback({ cancel: true }));
    await win.loadFile(path.join(root, 'src/renderer/index.html'));
    await waitFor(`Boolean(document.querySelector('[data-settings-section="general"]'))`, '常规设置');
    win.webContents.debugger.attach('1.3');
    await delay(240);

    const navigation = await win.webContents.executeJavaScript(`(() => {
      const nav=document.querySelector('.settings-navigation'), body=document.querySelector('.settings-body');
      const buttons=[...nav.querySelectorAll('button')];
      return {display:getComputedStyle(buttons[0]).display,align:getComputedStyle(buttons[0]).alignItems,
        iconCount:buttons.filter(button=>button.querySelector(':scope > .icon')).length,
        iconAndLabel:buttons.every(button=>{const icon=button.querySelector(':scope > .icon')?.getBoundingClientRect(),box=button.getBoundingClientRect(),range=document.createRange();if(!icon||!button.lastChild)return false;range.selectNode(button.lastChild);const label=range.getBoundingClientRect();return icon.right<=label.left+1&&Math.abs(icon.top+icon.height/2-(box.top+box.height/2))<1&&label.right<=box.right+1}),
        overflow:buttons.some(button=>button.scrollWidth>button.clientWidth+1) || nav.scrollWidth>body.clientWidth+1,
        selected:buttons[0].getAttribute('aria-selected')};
    })()`);
    assert.equal(navigation.display, 'flex', '设置分类以图标和文字组成一组');
    assert.equal(navigation.align, 'center', '设置分类图标垂直居中');
    assert.equal(navigation.iconCount, 4, '四个设置分类均带图标');
    assert.equal(navigation.iconAndLabel, true, '窄窗设置分类图标位于文字左侧并与文字垂直居中');
    assert.equal(navigation.overflow, false, '300 像素小窗的设置分类不溢出');
    await snapshot('常规设置.png');

    const firstItem = await win.webContents.executeJavaScript(`(() => {
      const item=document.querySelector('[name="showOrb"]').closest('.setting-item');
      const next=item.nextElementSibling, rect=item.getBoundingClientRect();
      return {height:rect.height,nextTop:next.getBoundingClientRect().top,checked:document.querySelector('[name="showOrb"]').checked};
    })()`);
    await win.webContents.executeJavaScript(`document.querySelector('[name="showOrb"]').click()`);
    await waitFor(`document.querySelector('[name="showOrb"]').closest('.setting-item').querySelector('.setting-save-state').textContent.trim().length>0`, '保存中的状态');
    const savingItem = await win.webContents.executeJavaScript(`(() => {
      const item=document.querySelector('[name="showOrb"]').closest('.setting-item'), next=item.nextElementSibling, rect=item.getBoundingClientRect();
      const status=item.querySelector('.setting-save-state');
      return {height:rect.height,nextTop:next.getBoundingClientRect().top,statusPosition:getComputedStyle(status).position,
        statusWidth:status.getBoundingClientRect().width};
    })()`);
    assert.equal(savingItem.statusPosition, 'absolute', '临时保存状态脱离文档流');
    assert.ok(savingItem.statusWidth <= 1, '临时保存状态仍由无障碍播报，但不占视觉空间');
    assert.equal(savingItem.height, firstItem.height, '保存中不改变开关行高度');
    assert.equal(savingItem.nextTop, firstItem.nextTop, '保存中不推移下一项');
    await waitFor(`document.querySelector('[name="showOrb"]').checked===false && document.querySelector('[name="showOrb"]').closest('.setting-item').querySelector('.setting-save-state').textContent.trim()===''`, '设置保存完成');

    await win.webContents.executeJavaScript(`document.querySelectorAll('.settings-navigation button')[1].click()`);
    await waitFor(`document.querySelector('[data-settings-section="service"]')?.hidden===false`, 'AI 服务分类');
    await delay(240);
    await win.webContents.executeJavaScript(`document.documentElement.classList.add('reduced-motion')`);
    await win.webContents.executeJavaScript(`document.getAnimations().filter(animation=>animation.effect?.getTiming().iterations!==Infinity).forEach(animation=>animation.finish())`);
    await win.webContents.debugger.sendCommand('DOM.enable');
    await win.webContents.debugger.sendCommand('CSS.enable');
    const { root: documentNode } = await win.webContents.debugger.sendCommand('DOM.getDocument', { depth: -1 });
    const tabButtons = await win.webContents.executeJavaScript(`Array.from(document.querySelectorAll('.mode-tabs[aria-label="服务类型"] button')).map(node=>({
      display:getComputedStyle(node).display, radius:getComputedStyle(node).borderRadius,
      icon:node.querySelector(':scope > .icon')?.getBoundingClientRect().width||0,
      indicator:node.parentElement.querySelector('.mode-indicator')?.getBoundingClientRect().height||0,
    }))`);
    assert.equal(tabButtons.length, 4, 'AI 服务分类包含四个标签');
    assert.ok(tabButtons.every(tab=>tab.display==='flex' && tab.radius==='8px'), 'AI 服务标签使用紧凑的圆角排列');
    assert.ok(tabButtons.every(tab=>Math.abs(tab.indicator-2)<.1), 'AI 服务当前选中态保留 2 像素下划线');
    for (let index = 0; index < tabButtons.length; index++) {
      const { nodeId } = await win.webContents.debugger.sendCommand('DOM.querySelector', {
        nodeId: documentNode.nodeId,
        selector: `.mode-tabs[aria-label="服务类型"] button:nth-child(${index + 1})`,
      });
      assert.ok(nodeId, '找到 AI 服务标签用于隔离悬停样式检查');
      await win.webContents.debugger.sendCommand('CSS.forcePseudoState', { nodeId, forcedPseudoClasses: ['hover'] });
      await delay(25);
      const hover = await win.webContents.executeJavaScript(`(() => {const node=[...document.querySelectorAll('.mode-tabs[aria-label="服务类型"] button')].find(item=>item.matches(':hover'));const rules=[...document.styleSheets].flatMap(sheet=>[...sheet.cssRules]).map(rule=>rule.cssText).filter(text=>text.includes('服务类型')&&text.includes('hover'));return node?{background:getComputedStyle(node).backgroundColor,radius:getComputedStyle(node,'::before').borderRadius,opacity:Number(getComputedStyle(node,'::before').opacity),matches:node.matches('.settings-body .mode-tabs[aria-label="服务类型"] button:hover'),rules}:null;})()`);
      assert.ok(hover, `AI 服务标签可命中悬停：${JSON.stringify({ index, tabs: tabButtons, hover })}`);
      assert.equal(hover.background, 'rgba(0, 0, 0, 0)', '悬停不铺矩形背景');
      assert.equal(hover.radius, '7px');
      assert.ok(hover.opacity > 0.5, `悬停显示轻圆角底色：${JSON.stringify({ index, hover })}`);
      if (index === 0) await snapshot('AI服务标签-悬停.png');
      await win.webContents.debugger.sendCommand('CSS.forcePseudoState', { nodeId, forcedPseudoClasses: [] });
    }

    await win.webContents.executeJavaScript(`window.pickgloss.invoke('navigate',{view:'paste'})`);
    await waitFor(`Boolean(document.querySelector('.recognition-body .form-actions button'))`, '粘贴文字操作');
    const buttons = await win.webContents.executeJavaScript(`Array.from(document.querySelectorAll('.recognition-body .form-actions button')).map(node=>{
      const box=node.getBoundingClientRect(), icon=node.querySelector(':scope > .icon')?.getBoundingClientRect();
      return {height:box.height,display:getComputedStyle(node).display,center:icon?Math.abs((icon.top+icon.height/2)-(box.top+box.height/2)):null};
    })`);
    assert.equal(buttons.length, 3, '粘贴页保留截图和文字入口');
    assert.ok(buttons.every(button=>button.height<=29 && button.display==='flex'), `粘贴页按钮维持紧凑高度：${JSON.stringify(buttons)}`);
    assert.ok(buttons.slice(0, 2).every(button=>button.center!==null && button.center<1), '截图图标在按钮内垂直居中');
    await snapshot('粘贴页按钮.png');

    console.log(`设置视觉检查通过（300×520）；截图保存在 ${artifacts}`);
    app.exit(0);
  } catch (error) {
    console.error(error.stack || error);
    app.exit(1);
  } finally {
    clearTimeout(watchdog);
  }
});
