'use strict';

// 规则集中在纯函数中，CI 与本地合并前入口共用；重命名的旧、新路径都参与匹配。
function selectChecks(files, { all = false, uiAll = false, forcePackage = false } = {}) {
  const paths = [...new Set(files.map(file => file.replaceAll('\\', '/')))];
  const rules = [
    ['ui', '界面或检查基础设施改动', /^(src\/(renderer|windows|core)\/|src\/(main|preload)\.cjs$|scripts\/|tests\/(renderer|windows)\/|\.github\/workflows\/check\.yml$)/],
    ['settings', '设置、持久化、外观或共享界面改动', /^(src\/(main|preload)\.cjs$|src\/renderer\/(?!translation[.])|src\/core\/(store|settings|appearance|shortcuts|services|models|provider|validation)[^/]*\.cjs$|src\/windows\/(desktop|window-appearance|startup)\.cjs$|scripts\/(check-.*(settings|appearance|recovery)|settings-fixture|change-check-plan|check-changes|check-ui\.cjs|checked-runner|ui-driver)|tests\/.*(settings|appearance|shortcuts|change-check))/],
    ['history', '历史、存储或共享界面改动', /^(src\/(main|preload)\.cjs$|src\/core\/(history|store|validation)[^/]*\.cjs$|src\/renderer\/(?!translation[.]|settings-autosave[.]|shortcuts[.])|scripts\/(check-history|change-check-plan|check-changes|check-ui\.cjs|checked-runner|ui-driver)|tests\/.*(history|change-check))/],
    ['translation', '截图翻译、采集、OCR 或共享界面改动', /^(src\/(main|preload)\.cjs$|src\/core\/(translation|store|provider|services|models|search|request-flow|validation)|src\/windows\/(desktop|ocr|screen-capture|translation)|src\/renderer\/(?!appearance[.]|settings[.]|settings-autosave[.]|shortcuts[.])|scripts\/(check-screenshot-translation|change-check-plan|check-changes|check-ui\.cjs|checked-runner|ui-driver)|tests\/.*(translation|ocr|screen-capture|change-check))/],
    ['package', '依赖、版本、原生构建或便携包契约改动', /^(package(-lock)?\.json$|scripts\/(package[^/]*|verify-package|check-portable[^/]*|check-package-smoke|build-native)\.cjs$|src\/windows\/[^/]+\.cs$|src\/native\/|native\/|tests\/.*(package|portable))/],
  ];
  return rules.flatMap(([id, reason, pattern]) => {
    const matched = paths.filter(file => pattern.test(file));
    return all || (uiAll && id !== 'package') || matched.length || (id === 'package' && forcePackage)
      ? [{ id, reason: all || (uiAll && id !== 'package') ? '显式完整检查' : id === 'package' && forcePackage ? '显式要求冻结便携包验证' : reason, paths: matched }]
      : [];
  });
}
module.exports = { selectChecks };
