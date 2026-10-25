'use strict';
// 仅在隔离夹具中检查点击歧义和诊断，不采集正式界面内容。
const { app, BrowserWindow } = require('electron');
const assert = require('node:assert/strict');
const os = require('node:os');
const path = require('node:path');
const { createUiDriver } = require('./ui-driver.cjs');
app.setPath('userData', path.join(os.tmpdir(), `pickgloss-driver-${process.pid}`));
let win;
app.whenReady().then(async () => {
  const timer = setTimeout(() => { win?.destroy(); app.exit(1); }, 20000);
  try {
    win = new BrowserWindow({ show: false, webPreferences: { offscreen: true, sandbox: true, backgroundThrottling: false } });
    await win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent('<section data-settings-section="general"><button>保存设置</button></section><section data-settings-section="service"><button>保存设置</button></section><button hidden>保存设置</button><button disabled>禁用按钮</button><input value="夹具密钥不得泄露"><p class="selected-word">夹具正文不得泄露</p>'));
    const evaluate = code => win.webContents.executeJavaScript(code);
    const driver = createUiDriver(evaluate, { timeoutMs: 100, intervalMs: 10 });
    await assert.rejects(driver.click('不存在'), /actionable":0/);
    await assert.rejects(driver.click('保存设置'), /匹配不唯一.*matched":3.*visible":2.*actionable":2/);
    await assert.rejects(driver.click('禁用按钮'), /未找到可操作控件/);
    await evaluate('window.__clicks=[];document.querySelectorAll("button").forEach((b,i)=>b.onclick=()=>__clicks.push(i))');
    await driver.click('保存设置', { scope: '[data-settings-section="service"]' });
    assert.deepEqual(await evaluate('window.__clicks'), [1]);
    await evaluate('document.querySelector("[data-settings-section=general]").hidden=true');
    await driver.click('保存设置');
    assert.deepEqual(await evaluate('window.__clicks'), [1, 1]);
    await evaluate('document.querySelector("button:not([hidden])").insertAdjacentHTML("afterend","<button>保存设置</button>")');
    await assert.rejects(driver.waitFor('false', '待验证状态'), error => {
      assert.match(error.message, /阶段=点击目标控件.*期望=待验证状态.*等待超时/);
      assert.doesNotMatch(error.message, /夹具密钥|夹具正文/); return true;
    });
    await evaluate('document.body.insertAdjacentHTML("beforeend","<p role=alert>保存失败：夹具密钥不得泄露；夹具正文不得泄露</p>")');
    driver.phase('保存服务设置');
    await assert.rejects(driver.waitFor('false', '返回解释页'), error => {
      assert.match(error.message, /阶段=保存服务设置.*界面拒绝了操作.*设置写入失败/);
      assert.doesNotMatch(error.message, /夹具密钥|夹具正文/); return true;
    });
    const diagnosis = await driver.diagnose('界面断言通过', '断言失败');
    assert.match(diagnosis.message, /阶段=保存服务设置.*原因=断言失败/);
    assert.doesNotMatch(diagnosis.message, /夹具密钥|夹具正文/);
    console.log('点击与诊断夹具通过：零匹配、多匹配、跨分区、隐藏、禁用、超时及脱敏保存失败。');
    clearTimeout(timer); win.destroy(); app.exit(0);
  } catch (error) { console.error(error.message); clearTimeout(timer); win?.destroy(); app.exit(1); }
});
