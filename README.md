<a id="readme-top"></a>

<div align="center">
  <a href="https://github.com/qwayo/PickGloss">
    <img src="src/renderer/assets/pickgloss-app.png" alt="PickGloss 标志" width="88" height="88">
  </a>

  <h1>PickGloss</h1>

  <p>
    在阅读现场选中文字或框选截图，立即获得解释，继续追问，并在本地留下可回访的阅读笔记。
    <br />
    Windows x64 · Electron · 本地优先 · 0.1.12
  </p>

  <p>
    <img src="https://img.shields.io/badge/Electron-44.7.2-1f2937?style=for-the-badge&logo=electron&logoColor=9FEAF9" alt="Electron 44.7.2">
    <img src="https://img.shields.io/badge/Node.js-%3E%3D18-339933?style=for-the-badge&logo=node.js&logoColor=white" alt="Node.js">
    <img src="https://img.shields.io/badge/Windows-x64-0078D4?style=for-the-badge&logo=windows11&logoColor=white" alt="Windows x64">
    <img src="https://img.shields.io/badge/Markdown-markdown--it-000000?style=for-the-badge&logo=markdown&logoColor=white" alt="markdown-it">
    <img src="https://img.shields.io/badge/UI%20Automation-Windows-5C2D91?style=for-the-badge&logo=windows&logoColor=white" alt="Windows UI Automation">
  </p>

  <p>
    <a href="#overview"><strong>了解 PickGloss</strong></a>
    &middot;
    <a href="#getting-started">快速开始</a>
    &middot;
    <a href="#usage">使用方式</a>
    &middot;
    <a href="#development">开发</a>
    &middot;
    <a href="#roadmap">路线图</a>
    &middot;
    <a href="#license">许可证</a>
  </p>
</div>

<div align="center">
  <img src="docs/images/showcase-demo.gif" alt="PickGloss 演示：在阅读页选中 compound，通过选区入口打开解释小窗，再展开为材料与回答并列的阅读视图" width="100%">
  <br />
  <sub>选中文字 → 就地解释 → 展开阅读视图；演示使用虚构阅读材料。</sub>
</div>

> [!WARNING]
> 当前可执行文件尚未进行正式代码签名。Windows 可能在启动时显示“未知发布者”或 SmartScreen 提示；请先核对下载来源和 Release 中公布的 SHA-256。

<a id="overview"></a>

## 产品概览

PickGloss 是一款 Windows 划词与截图解释助手。它把“查一下这个词”变成一条连续的阅读动作：

1. 在浏览器、PDF 阅读器或办公软件中选中文字，点击选区附近的划词入口。
2. 使用可信段落进行**语境解释**，或者在没有上下文时进行**独立释义**。
3. 遇到无法取词的图表、代码截图或扫描页面，直接框选屏幕区域并补充说明。
4. 在紧凑小窗中快速读完，或展开为左侧材料、右侧回答的阅读视图继续追问。
5. 让材料、问答和草稿留在本机会话历史中，收藏后继续补充。

<p align="right">(<a href="#readme-top">回到顶部</a>)</p>

## 核心能力

| 能力 | 说明 |
| --- | --- |
| 划词解释 | 读取 Windows 辅助功能提供的选区与可信段落；不模拟复制，不擅自改动剪贴板。 |
| 两种文字模式 | 语境解释依据当前材料与段落；独立释义解释一般含义，两种模式的问答和草稿彼此隔离，可按需用联网资料补充公开背景。 |
| 截图理解 | 通过 `Ctrl+Shift+S` 框选鼠标所在显示器，默认先预览；可在设置中开启完成后自动解释。 |
| 联网搜索 | 输入区地球图标记住最后一次联网选择，支持 Exa、Brave、DeepSeek 和自定义兼容接口；回答保留编号来源，文字和截图都可按需检索。 |
| 阅读工作区 | 小窗为 300 × 483、阅读视图为 860 × 690（逻辑像素）；在阅读视图中材料与回答并列。 |
| 本地会话 | 会话、材料、截图、问答和草稿保存在本机，支持搜索、改名、日期分组、收藏和回收站删除。 |
| 回答操作 | 流式显示 Markdown 回答，支持停止生成、手动重试和复制原始 Markdown。 |
| 外观与快捷键 | 深色、浅色、跟随系统，实色或磨砂；保存自定义主题预设，并录制 10 项全局快捷键。 |
| 兼容 AI 服务 | 使用 OpenAI 兼容的 `/chat/completions` 接口；提供 DeepSeek、小米 MiMo 和自定义配置，文字与识图可共用或分别配置。 |

<p align="right">(<a href="#readme-top">回到顶部</a>)</p>

## 界面预览

<div align="center">
  <img src="docs/images/showcase-overview.png" alt="PickGloss 正式界面总览：快捷菜单、小窗与阅读视图" width="100%">
  <br />
  <sub>一张图看三条阅读路径：快捷菜单负责入口与设置，小窗完成快速解释，阅读视图承载材料与回答的持续阅读。</sub>
</div>

> 画面由当前 `src/renderer/` 的正式界面配合虚构阅读材料生成；快捷菜单、小窗与阅读视图均完整呈现，具体显示效果可能随 Windows 缩放和主题能力略有差异。

<p align="right">(<a href="#readme-top">回到顶部</a>)</p>

<a id="getting-started"></a>

## 快速开始

### 使用便携版

便携版本由 `npm run package` 生成到：

```text
dist/<构建时间戳>/PickGloss-win32-x64/
```

解压后运行 `PickGloss-win32-x64/PickGloss.exe`。请保留整个目录，尤其是 `resources/`、`locales/` 和 `resources/native/ContextProbe.exe`；只拿走可执行文件无法运行。

每个包旁边会生成 `candidate-manifest.json`、`README.txt` 和 `release-checksum.json`。拿到 ZIP 时，先通过独立渠道核对 SHA-256，再执行：

```powershell
node scripts/verify-package.cjs <解压目录> --expected-zip-sha256=<ZIP 的 SHA-256>
```

### 从源码运行

### 环境要求

- Windows x64
- Node.js 与 npm
- Windows 自带的 .NET Framework C# 编译器（用于构建原生段落助手，不需要安装 .NET SDK）
- Windows SDK 10.0.18362 或更新版本（仅源码构建需要，用于翻译工具条的原生圆角背景；便携版用户无需安装）

### 安装

```powershell
git clone https://github.com/qwayo/PickGloss.git
cd PickGloss
npm ci
npm run build:native
npm start
```

首次安装 Electron 时需要下载运行时。`npm run build:native` 会生成 `build/native/` 下的段落、窗口外观和屏幕采集助手；应用通过 Windows UI Automation 读取真实选区与段落，截图翻译工具条使用原生实时背景模糊并按圆角裁切。构建会自动选择已安装的兼容 Windows SDK 元数据，运行便携版不需要 SDK。

<p align="right">(<a href="#readme-top">回到顶部</a>)</p>

<a id="usage"></a>

## 使用方式

### 1. 配置 AI 服务

打开窗口底部的「AI 服务」或「配置 AI 服务」，填写：

- 服务地址：例如 `https://api.example.com/v1` 或本机 `http://127.0.0.1:1234/v1`
- 模型名称：服务支持的文字模型名称
- API Key：按服务要求填写；已经保存的密钥留空时不会被清空

服务需要兼容 OpenAI 的 `/chat/completions` 接口。远程地址必须使用 HTTPS；`localhost`、`127.0.0.1` 和 `::1` 可以使用 HTTP。

识图模型名称留空时，截图解释、截图追问和识图连接测试会完整沿用文字模型的地址、模型与密钥。填写独立识图模型后，识图请求只使用识图配置；配置不完整或请求失败时会明确提示，不会悄悄切换到另一个服务。

可选择 DeepSeek、小米 MiMo 预设，或继续使用自定义服务。各厂商的地址、模型与加密密钥分别记住；“获取 API Key”会打开该厂商的官方密钥管理页面。密钥输入框下方显示 Windows DPAPI 加密说明和当前配置文件位置。

连接测试会发送一条短文字请求；识图测试会发送内置小图片，并可能产生服务费用。解释请求超时为 60 秒，连接测试超时为 15 秒。

### 2. 解释选中文字

1. 在支持 Windows 辅助功能取词的软件里拖选文字。
2. 松开鼠标后，点击选区下方或上方的划词入口。
3. 有可信段落时使用「语境解释」；无法取得段落时，可以切换到「独立释义」，或手动补充所在段落。
4. 在输入框继续追问，按 `Enter` 发送，按 `Shift+Enter` 换行。

划词入口固定在鼠标松开时的屏幕位置，滚动不会让它跟随或消失；点击入口外部、按 `Esc` 或重新划词会取消或替换旧入口。点击普通划词不会自动发送请求，只有点击入口后才接纳材料。

### 3. 解释截图

按 `Ctrl+Shift+S`，在鼠标所在显示器框选区域，松手即提交；顶端可切换“识图／翻译”，按 `Esc` 取消。截图只从框选区域裁剪成 PNG，上限为 15 MiB。

常规设置的“识图模式”可选“立即识别”或“先补充提示词”，默认立即识别。选择后者时先打开预览，描述图片背景或识别要求后点击“开始识图”。配置不完整或请求失败时截图仍会保留。此选项不影响 OCR 翻译。

OCR 翻译优先使用 Windows 本地识别，按行距和空间关系合并相近换行，明显空白与分栏保留边界。翻译菜单的“快速／深度”控制模型思考，工具栏的地球图标单独控制当前模式的联网并立即重译；两个模式分别记住选择，开启时有填充底色。联网使用已配置的搜索服务。

常规设置位于设置分类最左侧，集中管理悬浮球、划词入口、截图与识图模式、自启动、置顶提示音、窗口大小恢复及系统状态。AI 服务页只配置模型与搜索服务。

### 4. 按需联网

在 AI 服务设置的“联网搜索”中选择 Exa、Brave、DeepSeek 或自定义，并填写该搜索服务的 API Key。自定义服务需填写完整搜索地址，并选择 Exa、Brave 或 DeepSeek 兼容格式。搜索服务和回答模型可分别选择。

输入区发送按钮旁的地球图标控制联网，初始关闭；最后一次开关选择保存在本机，后续新划词、粘贴和截图会话都会继承，重启后仍生效。已有历史会话保留各自的状态。开启后，每次提交先生成简短查询、检索公开资料，再由当前模型回答；截图联网先由识图模型提炼查询，搜索服务只收到文字查询。

联网回答显示编号来源，可展开查看标题和链接，每条来源的摘录默认折叠，点击小三角查看；来源随该条回答保存，后续重新搜索不会覆盖旧回答的依据。展开来源列表时，会尝试读取网站自己的图标；失败时通过系统代理依次向 DuckDuckGo、Google 图标服务补取，仅发送网站域名，不发送页面路径、搜索词、会话内容、Cookie 或 API Key。Google 图标跳转只允许已知图标 CDN 地址。仍取不到时显示通用网站图标，失败短时缓存后可重试。搜索失败会保留问题，可重试或选择“不联网继续”。停止按钮会终止本次查询、搜索及回答流程。

### 5. 管理会话与窗口

- 历史图标会按日期分组列出会话，搜索覆盖标题、原文、上下文、截图说明和所有模式的问答。
- 星形图标收藏整个会话；取消收藏不会删除历史。
- 删除会话会把会话及截图移到 Windows 回收站。
- 悬浮球整球可拖，左键默认打开或关闭最新会话，也可改为截图框选；右键打开菜单。
- 固定窗口在其他软件获得焦点时仍保持可见；新的划词到来时，固定窗口留在原位。

### 默认快捷键

| 功能 | 默认快捷键 |
| --- | --- |
| 粘贴文字 | `Alt+Shift+G` |
| 截图框选 | `Ctrl+Shift+S` |
| 置顶或取消置顶 | `Alt+Shift+P` |
| 展开或收窄 | `Alt+Shift+W` |

「快捷键设置」还可以为历史、外观、悬浮球、划词入口、停止回答和关闭面板等 10 项功能录制组合键。组合键被其他程序占用或写入失败时，原设置与编辑草稿会保留。

<p align="right">(<a href="#readme-top">回到顶部</a>)</p>

## 数据与隐私

- 设置与会话保存在 `%LOCALAPPDATA%\PickGloss\data`。
- API Key 使用 Electron `safeStorage` 通过 Windows DPAPI 加密保存，界面不会以明文返回已保存密钥；加密不可用时拒绝保存。
- 会话正文与截图是本机普通文件，不是加密知识库；备份或共享目录前请自行评估其中的材料。
- 点击解释、追问或测试连接时会调用配置的服务；开启截图自动解释后，完成框选也会请求识图服务。没有后台批量上传或云端历史同步。
- 语境解释发送选定文字、可信段落和该模式对话；独立释义只发送选定文字和独立模式对话；截图解释只发送裁剪图片、截图说明和截图对话。
- 开启联网后，模型服务会先提炼简短查询；搜索服务接收查询，回答模型接收返回的联网资料。截图文件只发送给识图模型。历史联网回答的来源与对应回答一起保留，联网资料不替代原文上下文。
- 普通划词不模拟复制快捷键，不读取或改写剪贴板；只有点击「复制 Markdown」时才写入剪贴板。
- 会话中的 HTML 按文字显示，远程图片不会自动加载，链接需要主动点击。

本地数据目录如下。密钥密文在 `settings.json`；会话记录与截图位于各自的会话目录，三者不是同一个文件。

```text
%LOCALAPPDATA%\PickGloss\data\
├── settings.json                  # 服务设置与加密后的密钥密文
└── sessions\
    └── <会话 ID>\
        ├── session.json           # 会话正文、问答与截图说明
        └── crop.png               # 截图会话的裁剪图片
```

> PickGloss 不会替你判断所选 AI 服务如何保存请求。发送敏感材料前，请阅读对应服务的隐私政策。

材料上限：

| 项目 | 上限 |
| --- | --- |
| 选定文字 | 12,000 字符 |
| 上下文段落 | 6,000 字符 |
| 追问或截图说明 | 4,000 字符 |
| 单次文字材料与历史总预算 | 40,000 字符 |
| 截图 PNG | 15 MiB |

超过限制时会明确提示，不会静默截断；超限划词只保留提示入口，不创建无效会话或发送请求。

<p align="right">(<a href="#readme-top">回到顶部</a>)</p>

## 架构

```text
PickGloss/
├── src/
│   ├── main.cjs                 # Electron 主进程、IPC、窗口与请求生命周期
│   ├── preload.cjs              # renderer 与主进程之间的最小桥
│   ├── core/
│   │   ├── provider.cjs         # OpenAI 兼容协议与模式材料隔离
│   │   ├── store.cjs            # 设置、会话、草稿与回收站
│   │   ├── history.cjs          # 历史索引、搜索与展示
│   │   ├── validation.cjs       # 字符与图片大小限制
│   │   ├── appearance.cjs       # 主题与预设校验
│   │   └── shortcuts.cjs        # 快捷键规范化与注册边界
│   ├── windows/
│   │   ├── desktop.cjs          # 托盘、悬浮球、菜单、截图与全局入口
│   │   ├── geometry.cjs         # 工作区、DPI 与窗口布局计算
│   │   ├── selection-worker.cjs # 选区材料移交
│   │   └── ContextProbe.cs      # UI Automation 原生段落助手
│   └── renderer/                # 小窗、阅读视图、设置、历史与 Markdown
├── scripts/                     # 原生构建、打包、核验与交互检查
├── tests/                       # 核心、窗口、渲染器与包完整性测试
├── docs/                        # 规格、设计与研究文档
├── prototypes/                  # 本机设计样机与截图证据（不进入公开仓库）
└── DESIGN.md / GLOSSARY.md      # 设计规范与领域词汇
```

主进程负责窗口与材料生命周期，渲染器只通过白名单 IPC 访问桌面能力。文字与截图使用不同材料构造器；会话写入不等待模型成功，因此未解释、失败与停止的会话也能保留。

<p align="right">(<a href="#readme-top">回到顶部</a>)</p>

<a id="development"></a>

## 开发

### 常用命令

```powershell
npm start              # 从源码启动正式应用
npm run build:native   # 构建 UI Automation 段落助手
npm test               # 核心、Windows、渲染器测试
npm run test:host      # Electron 宿主契约与本机安全能力
npm run test:interaction
npm run test:markdown
npm run smoke          # 隔离数据目录下的启动检查
npm run package        # 构建、打包、校验并生成 ZIP
npm run check:publication
```

额外的界面检查需要 Electron，并使用隐藏窗口、临时数据目录和虚构材料，不访问真实 AI 服务或正常会话：

```powershell
npx --no-install electron scripts/check-ui-refinements.cjs
npx --no-install electron scripts/check-ui-appearance.cjs
npx --no-install electron scripts/check-brand-entries.cjs
```

`npm test` 会打开隔离 Electron 窗口，不适合当作完全后台的纯 Node 检查。`npm run smoke` 使用独立临时数据目录；隔离模式不会启动系统划词监听、悬浮球或全局快捷键，也不会读写系统剪贴板。

### 发布检查

```powershell
npm ci
npm test
npm run check:publication
npm run package
```

`npm run package` 会使用白名单裁剪运行文件，并核对源码、原生助手和包内文件摘要。不要手工修改打包目录中的 `candidate-manifest.json`；如果包内容变化，应重新打包并生成新的清单和校验和。

### 目录约定

- 新增运行时代码放在 `src/`，新增测试放在 `tests/`。
- 不把本机路径、API Key、`settings.json`、会话数据、验收截图或 ZIP 放进公开提交。
- `docs/verification/`、`output/`、`dist/`、`prototypes/` 默认留在本机；需要公开证据时，先逐项脱敏并在 Issue 或文档中说明证据范围。
- 所有用户可见文本使用中文；领域概念使用 `GLOSSARY.md` 中的名称。

<p align="right">(<a href="#readme-top">回到顶部</a>)</p>

## 当前边界

当前验证版面向 Windows 11 x64、单屏环境，重点覆盖桌面划词、截图解释、本地会话与便携包。以下项目尚未作为本版本的公开承诺：

- macOS、Linux、Windows 10、ARM64 与多显示器兼容性
- 安装器、自动更新、开机自启、系统商店分发和正式代码签名（当前发行版未签名，Windows 可能显示未知发布者）
- 对所有浏览器、WPS、PDF 阅读器、办公软件或显示缩放组合的兼容性
- 跨资料检索问答、全文文件导入、长期原文记号、图片圈画与箭头标注
- 真实模型质量、费用与可用性的普遍保证

从源码构建、Electron 交互检查、Windows 宿主检查和便携包核验是不同的证据，不能互相替代。真实桌面划词、真实截图、真实 AI 服务和用户主路径需要在目标 Windows 环境中单独验收。

<p align="right">(<a href="#readme-top">回到顶部</a>)</p>

<a id="roadmap"></a>

## 路线图

- [x] Windows 划词入口与可信段落采集
- [x] 语境解释、独立释义与截图解释
- [x] 小窗、阅读视图、固定窗口与位置记忆
- [x] 会话历史、搜索、收藏、改名与回收站删除
- [x] Markdown 渲染、停止、重试与原始内容复制
- [x] 深色、浅色、跟随系统、磨砂与主题预设
- [x] 10 项全局快捷键录制
- [x] 便携包白名单、候选清单与校验和
- [x] 在 GitHub Releases 发布带校验和的便携包
- [ ] 补充目标 Windows 环境下的真实设备验收记录
- [ ] 评估安装器、自动更新与正式代码签名

路线图只说明维护方向，不代表尚未完成的项目已经通过验证。

<p align="right">(<a href="#readme-top">回到顶部</a>)</p>

## 贡献

欢迎通过 Issue 报告问题或提出功能建议。提交变更前请先阅读仓库中的 `AGENTS.md`，并遵守以下约定：

1. 先创建或确认对应的 GitHub Issue，再开始较大范围的实现。
2. 使用 `codex/` 前缀创建分支，保持提交范围清晰。
3. 提交前运行相关测试、`npm test` 和 `npm run check:publication`。
4. 不为通过测试而降低断言、伪造验收结果或把未执行的检查写成已通过。
5. 不提交凭据、本机用户数据、未脱敏截图或与变更无关的生成文件。

工程验证入口与证据边界见 [工程验证说明](docs/engineering-verification.md)，包括失败阻断、隐藏界面 CI、冻结便携包和 Windows 实屏边缘检查。

<p align="right">(<a href="#readme-top">回到顶部</a>)</p>

## 致谢

- [Best-README-Template](https://github.com/othneildrew/Best-README-Template)：本 README 的信息架构参考。
- [oil-ui](https://github.com/oil-oil/oil-ui)：界面设计与视觉方向参考。
- [beautify-github-readme](https://github.com/oil-oil/beautify-github-readme)：README 视觉设计与演示素材制作参考。
- [Electron](https://www.electronjs.org/)：跨平台桌面运行时。
- [markdown-it](https://github.com/markdown-it/markdown-it)：Markdown 渲染。
- [selection-hook](https://github.com/0xfullex/selection-hook)：系统选区事件支持。
- Windows UI Automation：原生选区与段落信息采集。

<p align="right">(<a href="#readme-top">回到顶部</a>)</p>

<a id="license"></a>

## 许可证

本项目采用 [MIT License](LICENSE)。

<p align="right">(<a href="#readme-top">回到顶部</a>)</p>
