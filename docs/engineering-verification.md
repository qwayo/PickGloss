# 工程验证入口

本页对应 [工程验证任务 #15](https://github.com/qwayo/PickGloss/issues/15)。所有界面入口使用虚构材料及独立数据目录；不读取正常实例的设置、密钥或剪贴板，不连接收费模型。

## 失败阻断

`scripts/checked-runner.cjs` 的 `runSteps` 按顺序执行参数数组或异步校验函数。任一步启动失败、非零退出、超时或断言失败，立即抛错，不执行余下步骤。命令不经过 shell 拼接。调用方必须捕获异常并设置非零退出码；跨越该入口后另外编排的 shell 命令不在其保护范围内。

Node 脚本可复用以下形式；有副作用的动作必须放在同一受检序列内：

```js
const { runSteps } = require('./scripts/checked-runner.cjs');
runSteps([
  { name: '前置校验', command: process.execPath, args: ['scripts/check-script-encoding.cjs'] },
  { name: '后续校验', command: process.execPath, args: ['scripts/check-publication-hygiene.cjs'] },
], { logFile: 'output/受检日志.txt' }).catch(error => {
  console.error(error.message);
  process.exitCode = 1;
});
```

也可把 `steps` 和可选 `logFile` 写入 JSON，运行 `node scripts/checked-runner.cjs <计划文件>`。相对工作目录为计划文件所在目录。不要把真实密钥放进参数或计划；接口的 `secrets` 选项可从环境读取需遮盖的值。日志只记录阶段和经过脱敏的子进程输出，不打印参数或环境；子进程须按 UTF-8 输出，Python 的 `PYTHONUTF8=1` 与 `PYTHONIOENCODING=utf-8` 由运行器强制设置。Windows PowerShell 5.1 的自有脚本采用带 BOM 的 UTF-8，显式设置控制台输出编码。

`compareText(actual, expected, true)` 仅规范 CRLF/LF，不忽略空格、尾换行或其他内容差异。文件清单、产品源码、ZIP 和原生助手继续通过现有 SHA-256 按字节核验。

`node --test tests/windows/checked-runner.test.cjs` 使用替身验证失败阻断、成功顺序、中文及 `ℹ`、日志脱敏与换行规则，并实际从 Windows PowerShell 5.1 和可用的 PowerShell 7 启动入口；不会提交、合并或发布。

## 隐藏界面与便携包

| 入口 | 覆盖 | 运行阶段 |
| --- | --- | --- |
| `npm run check:ui` | 唯一点击夹具、300×483 服务界面、正式桌面模块隐藏检查 | Windows 普通 CI 与本机 |
| `npm run check:portable -- <候选目录>` | 冻结文件和 ZIP 校验、真实 EXE 保存失败阻断、真实 preload/主进程与本机服务贯通 | 打包后或已有冻结候选包 |
| `npm run package` | 原生构建、现有打包逻辑，冻结后自动执行上述便携验证 | 本机构建；CI 按版本／打包改动选择或手动追加 |
| `npm run check:changes` | 根据改动选择设置、历史、截图翻译及冻结包专项，报告未覆盖能力 | Windows 普通 CI 与本机 |
| `npm run check:merge` | 与改动入口相同，另要求实际获焦滑块及本机 OCR | 有交互桌面和所需识别语言的本地合并前检查 |

普通 PR 和主分支 CI 调用 `check:changes`，在界面相关改动中运行 `check:ui`，在版本／打包相关改动中自动执行完整冻结包验证。检查报告及隔离证据每次保留；没有交互桌面的 CI 不执行原生实屏检查。阅读视图等既有检查按产品改动相关性运行。

`ui-driver.cjs` 的点击必须匹配一个可见且可操作的控件。可提供明确分区；全局出现多个同名可操作控件立即失败，零匹配、多个可见分区、隐藏、禁用及不可操作控件也不会被直接点击。夹具覆盖同名“保存设置”跨常规与服务分区的情况。切换动画中的控件需先等待可见，再点击。

超时和拒绝保存记录阶段、期望、固定页面名、固定分区名、匹配数及错误分类，不记录输入值、密钥、正文或响应原文。自定义阶段和期望应使用固定描述，不能拼接选定内容或会话标题。保存失败注入向真实主进程提交不允许的服务地址，确认在网络请求前拒绝；错误报告为“隔离模式拒绝服务地址”，随后不发送解释请求。

服务界面夹具通过测试窗口的媒体模拟，依次验证系统减少动态效果与正常动效两种条件，再执行既有动画断言，避免 CI 系统偏好导致动画检查超时。桌面模块隐藏夹具也控制原生动态偏好，正常动效保留逐帧断言，减少动态效果另外验证立即落位及每次只写入一个目标尺寸；两条路径均必检，不会修改系统设置。失败诊断同时记录媒体条件和界面减少动态效果状态。独立原生实屏入口继续使用真实系统偏好。

## Windows 实屏边缘

在可交互的 Windows 11 桌面运行：

```powershell
npm run check:native-edges -- --output-dir output/verification/native-current
```

该入口加载正式桌面模块和渲染器，创建虚构解释会话及自有纯色背景窗，检查深／浅主题 × 实色／磨砂 × 未固定／固定有光条／固定无描边，并补充 321×487 奇数尺寸固定窗口，共十六组。截图通过 Windows `CopyFromScreen` 获取最终合成，报告保存实际 DPI、系统版本、请求与实际材质、DWM 可见矩形、客户区边界、参数、像素及结论。窗口尺寸为逻辑请求，实际尺寸可能因 DPI 取整相差 1 像素。

捕获前后逐像素核对矩形只属于本次创建的两个窗口，核对所属进程、窗口位置及遮挡；无法证明时不保存截图并返回失败。测试完成或失败后关闭自己的窗口；不会关闭用户实例，也不会自动改变系统缩放。报告与图片仅留在本机忽略目录。

采样不是整图快照比较：普通外缘检查客户区和可见原生边色，不能跳过磨砂的实体黑圈；暖橙光条检查四角、四条直边的实体色带宽度，以及柔光是否直接贴合实体条。系统色彩转换后允许从近橙色内侧实体区取受限参考，不能把原生边框误计成完整实体条。每次运行在隔离窗口注入普通灰线、重复裁切、不等宽光条、实体条内侧留缝和真实 DWM 磨砂黑边，必须能检出这五类回归。当前系统不支持读回 DWM 边色属性时，记录原生设置成功应答，并继续用实屏像素检出黑边。正式样式不作修改。

不支持的系统、锁屏、工作区不足或遮挡会明确失败，不能算作实屏通过。磨砂回退为实色时报告实际材质，不能宣称磨砂已覆盖。当前机器的检查结果只证明记录的 DPI；其他 DPI 和机器仍须单独运行。机械采样也不替代目标设备上的人工观感验收。

可增加 `--inject-capture-failure` 在隔离实窗就绪后主动失败，验证进程非零退出；报告中的“自有窗口已关闭”应为真。这个模式只验证失败清理，不生成实屏通过证据。

## 截图翻译与历史设置

- 对照高度回归：`node --test tests/windows/translation-layout.test.cjs tests/windows/requested-actions.test.cjs tests/windows/lifecycle.test.cjs` 配合下面的正式隐藏渲染器入口，检查短文收缩、长文限高、工作区变化、拖动位置、来源展开／收起、滚动保留、旧截图反馈隔离及测量权限；窗口尺寸反馈不写偏好、不移动原图覆盖、不抢焦点。实际短长文截图与修复前失败证据按本轮输出目录留存，不将隐藏界面验收视为所有 DPI 的系统合成验收。
- 检索利用回归：`node --test tests/core/translation.test.cjs tests/core/translation-thinking.test.cjs tests/core/search.test.cjs` 检查真实搜索摘录通过 OCR 和识图两条路径送入最终请求、目标语言与原文 ID 不变、资料仍处于引用角色，以及纯翻译、同实体译名采纳和术语一致性约束。测试替身不能证明真实模型会正确采用每条证据；提示词设计依据见 [AI 翻译提示词与检索利用调研](research/2026-10-26-AI翻译提示词与检索利用调研.md)。
- `npm run test:screenshot-translation`：生成固定中英文图片，实际调用 Windows OCR，再通过本机 HTTP 请求逐张批量翻译。通过正式预加载和两个隐藏渲染器验证独立的覆盖窗及控制窗、覆盖／对照互斥、按住眼睛临时查看原图并在释放／失焦／取消／换截图后复位、对照、复制、语言选择立即保存、连续切换中日目标语言后立即框选、保存失败时保留本次语言并在恢复后继承最新值、长译文完整保留，以及复用截图窗口时正反模式切换。对覆盖区域的实际像素再次识别，核对 `Desktop → 桌面`，避免仅检查 canvas 存在而遗漏原文残留。还检查常规／深度快捷按钮、独立联网偏好、来源打开、普通操作忙碌与完成状态，以及深浅主题中的清晰选中背景。当前夹具需要本机已安装英语与简体中文识别包，不访问真实屏幕、正常设置或收费模型。
- `electron scripts/check-translation-material.cjs`：使用正式桌面模块和翻译渲染器，在自有背景窗口上检查深浅主题、紧凑工具条、识图后备、对照和错误提示。通过 `capture-owned-window.ps1` 核对本进程窗口及当前绑定助手的材质 HWND／PID 后保存实际合成像素；背景变色应反映到透明表面，14 像素圆角外应保留清晰条纹。可用 `--output-dir <目录>` 分开保存本轮证据。`--inject-small-clip` 仅将原生背景圆角缩至 8 像素，保持内容圆角不变，应检出方角残留并以非零退出。该检查会短暂显示测试窗口，不能与其他可见窗口取证并发运行；遇到其他窗口遮挡立即中止，不保存遮挡内容。
- `node --test tests/core/translation.test.cjs tests/windows/ocr-quality.test.cjs tests/windows/requested-actions.test.cjs`：覆盖品牌译名规则、结构化输出、保守 OCR 质量信号、自动后备及手动识图在请求前后的状态、取消与配置边界。测试替身不证明真实模型的翻译质量；真实服务验证另用固定公开词语记录。
- `node --test tests/core/translation-thinking.test.cjs tests/core/provider.test.cjs tests/core/translation.test.cjs tests/core/store.test.cjs tests/windows/requested-actions.test.cjs`：检查思考参数实际写入、最高可用档位映射及未知能力处理、常规不搜索、深度联网／不联网、查询与来源边界、视觉后备、搜索失败不降级、途中切换模式阻断旧任务，以及模式与联网偏好重启恢复。普通解释请求不附加本轮翻译专属思考参数。
- `npm run test:history-settings`：使用虚构历史和 IPC 响应检查紧凑图标、多选工具条在小窗下滑固定、离开再进入或显式重复进入时退出旧多选、模拟隐藏后清理旧选择、同一轮状态推送保留选择、分页及筛选隐藏项保护、批量部分失败重试；覆盖配色多选及全选删除、默认配色保护、取消、失败重试和删除后保留当前颜色；同时覆盖自启与截图默认模式、当前表单获取模型、独立翻译模型及留空沿用、密钥和连接状态配色。
- `electron scripts/check-ui-appearance.cjs --output-dir <目录>`：正式桌面模块、预加载、隐藏渲染器和真实临时存储，检查常规与服务自动保存、刷新读回、失败保留与恢复、后台厂商错误入口、外观预设自动更新及深浅布局。不会注册实际开机自启或访问真实模型。`tests/renderer/settings-autosave.test.cjs` 另测字段合并、串行落盘、迟到响应、失焦加速、失败定位和显式放弃；外观和快捷键专属测试覆盖有效输入自动提交、无效值与冲突不提交，以及保存期间继续编辑。
- `electron scripts/check-pin-glow-contact.cjs`：隐藏窗口使用正式 CSS 核对明暗、材质和尺寸组合中柔光与实体条使用同一内孔；`--inject-old-glow` 必须检出旧布局。最终像素仍由实屏入口验收。
- `npm test`：覆盖模型列表超时、密钥来源保护、结构化翻译、旧结果取消、批量回收的不确定状态、启动设置失败回滚，以及原生助手异常后的页面尺寸清理。后者不能替代真正登录 Windows 或目标 DPI 的人工验收。

本轮范围和技术依据分别见[截图翻译与设置改进](specs/screen-translation-and-settings-20261025.md)和[截图翻译技术调研](research/2026-10-25-截图翻译技术调研.md)。

## 截图启动耗时与连续截图

`node scripts/check-capture-latency.cjs --electron --cycles=3 --assert-fast --report=output/verification/capture-hidden.json` 使用真实隐藏 Electron 界面和预制像素，明确禁用原生截图助手，仅验证编码、定向传输、解码及复用，不代表真实取图延迟。

可交互的单屏 Windows 桌面另运行：

```powershell
node_modules/.bin/electron.cmd scripts/check-capture-startup.cjs --capture=electron --report=output/verification/capture-electron.json
node_modules/.bin/electron.cmd scripts/check-capture-startup.cjs --capture=native --settle-ms=100 --report=output/verification/capture-native.json
node_modules/.bin/electron.cmd scripts/check-capture-startup.cjs --capture=native --settle-ms=0 --report=output/verification/capture-native-immediate.json
```

先运行 `npm run build:native` 构建采集助手。该入口在单屏上铺满无系统边框的自有蓝色背景，校准真实采集路径的系统色彩转换，再用正式桌面模块及渲染器测量真实取图和可框选耗时。覆盖有／无自有面板、160／50 毫秒退隐预算和三轮重复，逐像素核对整屏颜色，检查自有窗口是否残留。原生模式必须实际走原生采集，不允许后备采集冒充原生速度。像素核对在就绪计时结束后进行。

原生预热只握手，不读屏；单测还验证请求长度、帧拆分、编号、128 MiB 上限、并发、超时、管道错误、异常回退、取消后立即重开与助手退出。包内必须包含与采集桥接相配的 `ScreenCapture.exe` 及其摘要。

该入口不保存整屏图片，不读取私人配置或剪贴板，结束时关闭自有窗口和采集助手。多屏直接拒绝执行；真实模型、其他 DPI、HDR、锁屏及受保护内容需要单独验收。报告中的 160 毫秒场景仅在隔离模块副本中改变退隐预算，不修改产品文件。

## 设置保存失败与截图入口回归

磨砂滑块的保存回归已接入本地合并前入口 `npm run check:merge`。仅运行该专项时可用：

```powershell
node --test tests/renderer/appearance-autosave.test.cjs tests/renderer/settings-autosave.test.cjs
node_modules/.bin/electron.cmd scripts/check-appearance-slider-save.cjs --visible
```

第二条会打开一个独立的测试设置窗口，并要求页面实际取得焦点后用鼠标事件拖动不透明度，再验证控件节点保留、连续输入和失焦、保存状态结束、其他设置和关闭按钮可用。仅使用虚构 IPC 与临时用户目录，不修改日常设置或原生材质。默认不传 `--visible` 时是隐藏界面检查，可检查节点保留，但不能替代有焦点窗口中“移除滑块→失焦→空保存→重绘”的循环回归。

空 `flush()` 必须直接成功，不能通知宿主重绘；真实保存后由外观组件读回并同步自身，不应重建整页。组件测试覆盖无变更、已保存后失焦、有变更串行保存、失败保留与重试。原生材质和实际存储另用正式主进程及隔离配置验证，不能以虚构 IPC 结果代替。

```powershell
node_modules/.bin/electron.cmd scripts/check-settings-recovery.cjs
node_modules/.bin/electron.cmd scripts/check-settings-visual-repair.cjs
```

前者使用正式预加载、隐藏窗口和虚构 IPC，验证自启动失败后开关回滚并可关闭、保存回声保留控件、快捷键顶部与页面恢复可关闭、两个截图入口的固定模式，以及菜单项精简。后者验证 300 像素小窗的图标、导航简写、按钮对齐及保存状态期间行高稳定。它们不注册真实快捷键、不改实际自启动，不代表可见桌面合成验收。

`scripts/check-startup-native.cjs` 是单独的 Windows 原生接口探针，会实际写入两个带进程号的临时登录项，并在 finally 中仅清理自己的精确名称、读回确认不存在；正式 PickGloss 项及正常设置不修改。用于区分名称、参数匹配和系统拒绝，不能替代重启登录验收。

截图翻译提示词增加普通词规则和至多一次漏译复核。复核保留完整截图语境及实际联网资料，只更新疑似漏译条目，继续使用原模式的思考参数；不重写已有译文和图像坐标。自动测试与实际供应商输出必须分开记录，少量词语成功不代表任意输入准确率。

截图翻译菜单的地球按钮以当前快速／深度模式为作用域；前后端判定与两次切换恢复的矩阵由 `tests/renderer/translation-search.test.cjs` 覆盖。旧 `deepSearchEnabled` 迁移后保留原先仅深度联网的含义。设置页只提供识图的立即／提示词选项，不展示翻译联网范围。

`tests/renderer/translation-draft.test.cjs` 覆盖控制窗语言保存失败后的草稿：切换覆盖／对照、复制和重新翻译不能用旧默认语言覆盖选框；同图重译生成新编号后仍需保留本次语言，换截图或保存成功后恢复正常同步。语言草稿及保存错误独立于普通操作错误，迟到回执只更新对应版本。截图专项同时用正式预加载及隐藏 Electron 重放失败保存、显示切换和重译参数，不读取日常设置或调用真实翻译服务。

`tests/windows/ocr-paragraphs.test.cjs` 验证相近行、明显间距、分栏、字号、无效几何及先质量后分段；真实固定图片 OCR 专项验证近行距一段、大行距两段。覆盖排版另用六行合并框检查，修复前字号过大只能显示箭头，修复后像素有六行文字且末行可由本机 OCR 识别。原生光标资源和中心热点通过正式页面样式检查；隐藏页面截图不包含系统光标，不能替代实屏鼠标观感。

## 根据改动执行专项

固定入口为 `npm run check:changes`；本地合并前使用 `npm run check:merge`。选中正式桌面模块或设置专项时，入口先构建所需原生助手，不依赖此前残留的构建。后者在同一选择规则上启用 `--interactive --ocr`，会在设置相关改动中打开虚构设置窗口并验证真实焦点，在截图翻译相关改动中要求本机具备 Windows OCR 和英文、简体中文识别语言。焦点或所需 OCR 能力不可用时，该专项失败，不以隐藏检查或固定识别材料冒充通过。

```powershell
npm run check:changes -- --plan-only
npm run check:merge -- --base origin/main --output-dir output/verification/合并前检查
```

入口比较指定基线与 HEAD 的共同祖先，同时包含暂存、未暂存和未忽略的新文件；删除及重命名的旧、新路径也参与选择。基线不能解析时直接失败。默认基线为 `origin/main`；检查已经合并的提交时，应明确传入合并前的提交，例如 `--base HEAD^`，避免将当前 HEAD 与自身比较。

| 改动范围 | 自动执行 |
| --- | --- |
| 界面、桌面模块或检查基础设施 | 唯一点击夹具、300×483 服务界面、正式桌面模块隐藏检查 |
| 设置、自动保存、外观、快捷键或相关共享依赖 | 正式临时存储保存读回及失败草稿／恢复、失败后的返回和关闭阻断、设置恢复、窄窗视觉、隐藏滑块；交互入口另执行获焦滑块 |
| 历史、存储或共享界面 | 历史与设置专项，包括筛选／分页隐藏项保护、批量部分失败及重试 |
| 截图翻译、OCR、采集或相关共享依赖 | 使用固定识别材料的普通 UI 合同，包括目标语言保存失败后的草稿与恢复；`--ocr` 另执行本机识别及覆盖像素专项 |
| `package.json`、锁文件、打包／核验脚本、原生助手源码或构建脚本 | 完整构建及冻结便携包套件：文件与 ZIP 核验、真实 EXE 保存失败阻断、本机解释／追问请求及历史和密钥加密核对 |

精确路径规则由 `scripts/change-check-plan.cjs` 维护。共享依赖采用保守选择，同一专项只运行一次。`--all` 选择全部检查（含打包），`--ui-all` 选择全部界面专项，`--package` 显式增加冻结便携包套件；后两者都保留路径规则已经选中的检查。

每次执行在输出目录写入 `改动检查报告.json`，记录基线、改动、选择原因、逐项结果及未覆盖能力，各步骤的日志由 `checked-runner.cjs` 统一处理超时、UTF-8、脱敏和失败阻断。`--plan-only` 仅列计划，不标记通过。任一专项失败，后续步骤保持“未执行”。

获焦专项显式使用 `windowsHide: false` 启动 GUI，避免 Windows 的隐藏子进程选项把测试窗口隐藏。输入前必须同时取得原生可见／焦点状态和页面焦点，输入事件另核对 `isTrusted` 及发生时的页面焦点，并验证鼠标输入值实际保存；页面 `document.hasFocus()` 单独为真不能计为通过。其他步骤仍保持执行器默认的隐藏控制台行为。设置恢复夹具对“保存期间回声”使用正式状态订阅的确认后再返回保存响应，确保节点保留断言确实覆盖这段顺序；该场景不能证明保存响应之后的迟到广播也保留节点。

设置专项分别固定正常动效和减少动态效果条件，避免 CI 系统偏好改变测试场景。阅读位置检查先等待原生及渲染器布局均提交，并断言已经滚动到指定的“阅读段落 4”，随后保持同段落和 3 像素偏差阈值；失败记录往返锚点及状态／滚动／尺寸事件。减少动态效果的宿主通知仅在进入该状态时触发，重复状态回声不能在尺寸提交前清除阅读锚点；组件回归和 `--reduced-motion --anchor-only` 专项共同覆盖。

窄窗导航几何检查等待字体和有限动画就绪，并保存就绪前后几何。图标按按钮内容区中心核对，计入上下不对称内边距；继续保留小于 1 像素的居中精度及文字右侧不溢出断言。旧检查将内容区中心与外框中心混用，静止时恰差 1 像素，未完成的缩放动画反而会误通过。`check-settings-visual-repair.cjs --inject-misaligned-nav` 在隔离夹具中将图标下移 3 像素，必须失败，不修改产品样式。

Windows CI 使用 PR 基线或推送前提交自动选择专项，版本或打包改动不再依赖手动勾选。普通 CI 不声明交互桌面或 OCR 能力，报告会列出获焦滑块／本机 OCR 的未覆盖项及本地入口；工作流手动输入 `verify_ocr` 可要求本机 OCR 专项，`verify_package` 可显式增加打包验证。每次运行均上传选择和能力边界报告，失败时也保留已经写出的隔离诊断。CI 通过不替代本地合并前的实际获焦证据。

截图翻译的两类证据可以单独执行：

```powershell
node_modules/.bin/electron.cmd scripts/check-screenshot-translation.cjs --ui-only --output-dir output/verification/翻译界面
node_modules/.bin/electron.cmd scripts/check-screenshot-translation.cjs --native-ocr --output-dir output/verification/翻译本机识别
```

普通 UI 模式仍使用正式预加载、渲染器及真实本机 HTTP 翻译请求，仅将识别结果替换为固定材料，不调用 Windows OCR。原生模式保留固定中英文图片、段落识别、单词覆盖及六行译文的真实 OCR 断言；缺少语言组件时失败并记录阶段及错误码。两者均不读取日常配置、不调用真实远端模型、不表示原生实屏或翻译质量验收。原有 `npm run test:screenshot-translation` 默认仍执行原生模式。

接入时修正了对照测量回归：主进程会忽略覆盖模式下到达的旧测量，渲染器回到对照时必须重新提交高度，即便数值相同；同一对照状态的普通重绘仍去重。`tests/renderer/translation-draft.test.cjs` 使用正式渲染模块和可控帧锁住这段竞争，旧渲染器在该回归中失败。截图专项的夹具与正式主进程一致保留本图测量高度，重复对照回执不再重置为默认 144 像素；完整长文仍断言增长至 480 像素上限。该问题与下节截图预览完整显示偶发失败分别跟踪，不能混作同一个根因。

## 截图预览偶发失败的诊断入口

跟踪任务为 [#22](https://github.com/qwayo/PickGloss/issues/22)。首次 CI 失败只留下截图预览完整显示断言的位置，没有保存溢出数值；重跑通过不能说明图片解码、字体、动画或真实布局中哪一项是原因。当前仍未证实根因，任务保持开放。

原断言仍检查 `scrollHeight <= clientHeight + 1` 及操作区底边不超过预览容器底边，横图和竖图均保留，没有扩大阈值或重跑用例直到成功。`check-floating-ui.cjs` 在断言前写入 `截图预览布局采样.json`，记录图片完成状态及固有尺寸、字体状态与实际字体、有限动画、窗口和视口、主题／材质、缩放、容器及按钮边界。成功也保留采样，便于比较首次运行和重跑。

```powershell
node_modules/.bin/electron.cmd scripts/check-floating-ui.cjs --preview-layout-only --preview-probe --preview-rounds=100 --output-dir output/verification/预览采样
```

`--preview-layout-only` 只运行正式桌面模块的截图预览场景；`--preview-probe` 收集每次采样并在存在任何失败时返回非零，失败样本不会因后续通过被清除。普通流程首次断言失败即停止。探针可分别使用 `--preview-cpu-rate=4`、`--preview-image-delay=100`、`--preview-height=483` 改变一个条件；仅隔离夹具生效，不修改产品。`--preview-inject-overflow` 在夹具中制造真实按钮溢出，用于确认原阈值及诊断能检出问题，不能当作原 CI 故障的复现。

2026-10-27 本机排查：原脚本五次均通过；新增结构化采样共 690 次，目标溢出为 0，其中 100 次是尚未设置图片源的受控延迟样本，不能计为图片已就绪的证据。包含原操作顺序的二十次完整尝试中，十九次完成，另一次在更早的置顶边色断言失败，未进入截图预览，不能归因于本任务。CPU 降速和精确 483 像素视口未触发目标故障；字体首次加载及干净 Windows CI 的差异仍未排除。故本次只交付诊断回路，不声称消除了偶发失败，也未选择未经证实的等待条件。后续干净 CI 若再次失败，应以本次新增采样比较实际布局状态再确定修复。
