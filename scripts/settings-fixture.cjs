'use strict';
// 隔离界面夹具只保存公开元数据；输入的虚构密钥也不回送到渲染器。
function applySettingsFixture(settings, changes) {
  const next = { ...settings, prefs: { ...settings.prefs, ...changes.prefs }, serviceProfiles: { ...settings.serviceProfiles } };
  if (changes.prefs?.screenshotTranslation) next.prefs.screenshotTranslation = { ...settings.prefs?.screenshotTranslation, ...changes.prefs.screenshotTranslation };
  function profile(previous = {}, input = {}) {
    const result = { ...previous, hasKey: input.clearKey === true ? false : !!input.apiKey || previous.hasKey === true };
    for (const key of ['baseUrl', 'model', 'protocol']) if (input[key] !== undefined) result[key] = input[key];
    delete result.apiKey; delete result.clearKey; return result;
  }
  for (const kind of ['text', 'vision', 'translation', 'search']) {
    const profiles = next.serviceProfiles[kind] = { ...next.serviceProfiles[kind] };
    for (const [id, input] of Object.entries(changes.serviceProfiles?.[kind] || {})) profiles[id] = profile(profiles[id], input);
    const input = changes[kind];
    if (input) {
      const id = input.providerId || settings[kind]?.providerId || 'custom';
      profiles[id] = profile(profiles[id] || settings[kind], input);
      next[kind] = { providerId: id, ...profiles[id] };
    }
  }
  return next;
}
module.exports = { applySettingsFixture };
