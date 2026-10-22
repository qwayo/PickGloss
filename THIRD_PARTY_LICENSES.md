# 第三方许可与素材来源

更新：2026-10-22。

本文件汇总 PickGloss 源码、便携包和发布素材中的第三方组件与自制素材来源。它不替代各组件自带的完整许可证文本；便携包会同时保留实际运行时依赖的许可证原文件。

## 运行时依赖

便携包内实际包含并运行的第三方组件如下。许可证原文件随包保留在各自目录。

| 组件 | 版本 | 许可证 | 便携包内许可文件 |
| --- | --- | --- | --- |
| markdown-it | 15.0.3 | MIT | `node_modules/markdown-it/LICENSE` |
| selection-hook | 2.1.1 | MIT | `node_modules/selection-hook/LICENSE` |
| node-gyp-build | 4.8.4 | MIT | `node_modules/node-gyp-build/LICENSE` |
| punycode.js | 2.3.1 | MIT | `node_modules/punycode.js/LICENSE-MIT.txt` |
| uc.micro | 3.0.0 | MIT | `node_modules/uc.micro/LICENSE.txt` |
| Electron / Chromium | 44.7.2 | MIT 及 Chromium 第三方许可 | `LICENSE`、`LICENSES.chromium.html` |

`selection-hook` 的预编译二进制位于 `prebuilds/win32-x64/selection-hook.node`，随同其 MIT 许可证分发。Electron 的许可证与 Chromium credits 由打包器保留在便携包根目录，项目打包校验会要求这些文件存在。

## 开发与构建依赖

源码仓库通过 `package-lock.json` 锁定构建工具和测试依赖，包括 `electron`、`@electron/packager` 等。它们不是便携包内需要单独列出的应用运行时组件；重新构建时应遵循各自许可证和仓库来源。`@electron/packager` 使用 BSD-2-Clause，仅作为构建工具使用。

`markdown-it` 的完整运行时依赖闭包还包括 `argparse`、`entities`、`linkify-it`、`mdurl`、`punycode.js`、`uc.micro` 等包。`markdown-it` 的浏览器构建产物内嵌了 `punycode.js` 与 `uc.micro` 代码，因此便携包一并保留这两份 MIT 许可证原文。其余包由构建产物内联或仅参与构建，源码仓库保留锁文件。

## 项目自制素材

- `src/renderer/assets` 中的品牌 SVG、PNG、ICO 和多尺寸图形由 `scripts/generate-brand-assets.cjs` 从项目内的 `brand-glyphs.json` 生成，不包含第三方图标或模板。
- `src/renderer/assets/pin-on.wav` 由 `scripts/generate-pin-sound.cjs` 确定性合成，不包含外部采样。
- `docs/images/showcase-overview.png` 和 `docs/images/showcase-demo.gif` 使用 PickGloss 正式界面与虚构阅读材料制作，不包含真实用户网页、会话或截图；演示文字为测试材料。
- `tests/fixtures/mimo-fixed-crop.png` 是用于连接测试的固定合成图像，不包含真实用户材料。

## 使用边界

项目根目录的 MIT 许可证覆盖 PickGloss 自有代码和随项目提供的自制素材，不改变第三方组件各自的许可证。对外再分发时应保留本文件、项目许可证以及便携包内各第三方许可证原文。若将本项目用于商业或高风险场景，请自行完成适用于所在司法辖区的进一步法律核验。
