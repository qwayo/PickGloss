# 桌面划词解释入口跟随调研

日期：2026-10-16。研究目标：不安装浏览器扩展，判断拾译能否让桌面解释入口在滚动时稳定贴住选定内容，并找出本轮值得验证的最小改进。

**本轮建议恢复屏幕固定入口。** 当前原生选区路径的轮询提速已经失败；本轮补做的事件订阅对照也没有改善坐标更新。没有找到可以在现有桌面路径上小改、并已证明达到跟随门槛的方案。这不表示“无扩展永远做不到”：浏览器调试桥、图像追踪、Word 专用接口都是不同程度可行的路线，但需要新的使用条件、实现和验收。

研究仅读取公开一手资料、仓库代码与固定样本诊断结果；未读取用户网页、文档、密钥或会话，未操作用户 Edge、Word 或运行中的拾译。研究者只写本报告；事件实验由主代理在独立诊断目录执行。仓库当前没有 `docs/adr/`，本报告不构成已采纳 ADR。

## 现有结果究竟证明了什么

先前延迟诊断在隔离 Electron 固定样本中测到：120 毫秒轮询的位置更新间隔 P95 为 541 毫秒；改为 16 毫秒仍为 531 毫秒；直接读取选区矩形仍为 527 毫秒。文字校验与矩形调用本身很快，却反复返回旧坐标。因此需要调查坐标来源的更新，而不只是继续缩短等待时间。该诊断保留在本机验收归档。

这个实验没有覆盖用户日常 Edge 的全部情况，也没有覆盖 Word、Edge 内置 PDF、WPS、触控板或多屏。它足以否定“当前固定样本只要提高轮询频率就能修好”，不足以否定所有无扩展方案。

## 与本机依赖相匹配的源码证据

本机 `node_modules/electron/package.json` 为 `44.7.2`。主代理还使用本机 `electron.exe` 的 `ELECTRON_RUN_AS_NODE=1`子进程读取 `process.versions`，实际返回 Electron `44.7.2`、Chromium `152.0.7977.149`；与 Electron 官方该版本的 [DEPS](https://github.com/electron/electron/blob/v44.7.2/DEPS)一致。以下优先核查这个版本，不以不断变化的主线替代本机依赖；版本匹配不等于已经对二进制内部执行路径做了追踪。

1. **读取很快，不代表位置刚刚更新。** Chromium 官方架构说明：原生辅助功能查询读取浏览器进程的缓存，渲染进程另行推送更新。该设计同时影响 UIA 和浏览器提供的其他原生辅助功能接口。[辅助功能架构说明](https://chromium.googlesource.com/chromium/src/+/HEAD/docs/accessibility/browser/how_a11y_works_2.md)
2. **这个版本确有与样本吻合的调度分支。** `AXObjectCacheImpl::GetLocationSerializationDelay()`对一般位置变化返回 500 毫秒；只有变化集合包含当前 DOM 焦点节点，且焦点不是文档根节点时，返回 75 毫秒。`SerializeLocationChanges()`按此间隔发送位置与滚动偏移；`HandleScrollPositionChanged()`将滚动节点加入位置更新集合。这个函数没有“订阅了 Windows 事件就使用更快间隔”的分支。[Chromium 152 位置更新源码](https://github.com/chromium/chromium/blob/152.0.7977.149/third_party/blink/renderer/modules/accessibility/ax_object_cache_impl.cc)
3. **现有样本已经请求完整辅助功能模式。** 测量脚本传入无参数 `--force-renderer-accessibility`。相同 Chromium 版本将它初始化为 `kAXModeComplete | kScreenReader`。因此“再打开完整模式或读屏模式”不是本样本尚未试到的独立突破口。[模式初始化源码](https://github.com/chromium/chromium/blob/152.0.7977.149/content/browser/accessibility/browser_accessibility_state_impl.cc)
4. **更新事件通常通知已经到达的变化。** Windows 实现把滚动位置变化映射为 `EVENT_SYSTEM_SCROLLINGEND` 和 UIA 滚动百分比属性变化；位置变化也可发 `EVENT_OBJECT_LOCATIONCHANGE`。事件可降低客户端等待、减少无效轮询，但这些映射本身不证明能加快渲染进程发送坐标。[Windows 事件映射源码](https://github.com/chromium/chromium/blob/152.0.7977.149/ui/accessibility/platform/browser_accessibility_manager_win.cc)、[位置事件源码](https://github.com/chromium/chromium/blob/152.0.7977.149/ui/accessibility/platform/browser_accessibility_win.cc)

**解释边界：** 500 毫秒是上述版本的特定位置更新分支，不是 UIA 规范，也不是所有 Windows 应用或所有 Chromium 更新都必须等待的时间。其他树更新、焦点和版本差异可能改变观测。75 毫秒分支也不是 60 帧同步承诺；不能通过抢焦点或改写用户选区来悄悄换取提速。

## 候选路线与本轮优先级

| 路线 | 一手依据与可行部分 | 目标相关限制 | 判断 |
| --- | --- | --- | --- |
| UIA／WinEvent 事件驱动读取 | UIA 允许提供方依据监听者选择发事件，因此值得验证订阅是否改变行为；WinEvent 提供位置和滚动相关通知。[UIA 事件说明](https://learn.microsoft.com/en-us/windows/win32/winauto/uiauto-eventsoverview)、[WinEvent 定义](https://learn.microsoft.com/en-us/windows/win32/winauto/event-constants) | 事件不等于每帧坐标。`CONTENTSCROLLED`的定义还是滚动完成，不能把它当每帧位移。需实际测量坐标新鲜度。 | **本轮唯一最小实验，已执行且未通过。** |
| 切换 MSAA／IAccessible2 | IA2 的 `get_characterExtents`确实能取字符边界，并触发内联文本框能力；源码随后调用浏览器辅助功能对象的范围边界方法。[IA2 实现](https://github.com/chromium/chromium/blob/152.0.7977.149/ui/accessibility/platform/browser_accessibility_com_win.cc) | 未发现它绕过 Chromium 缓存、同步拉取当前 Blink 布局的证据。MSAA `accLocation`本身还是对象位置，不能直接替代精确文本选区。接口适配会增加复杂度。 | 暂不为本轮重写。其他应用可有不同提供方，不能一并判死。 |
| 读取滚动偏移，再修正旧选区矩形 | UIA ScrollPattern 暴露百分比；Chromium `GetVerticalScrollPercent()`使用辅助功能节点的 `kScrollY/Min/Max`计算。[滚动属性源码](https://github.com/chromium/chromium/blob/152.0.7977.149/ui/accessibility/platform/ax_platform_node_win.cc) | Chromium 滚动偏移仍走上面的缓存更新通道。`GetScrollInfo`面向标准滚动条或实现相关消息的控件，不是任意网页滚动容器的像素坐标接口。[GetScrollInfo](https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-getscrollinfo) | 对特定原生控件可能有效；未找到现有 Edge 网页的独立快速数据源。 |
| 鼠标滚轮钩子＋位置预测／插值 | `WM_MOUSEWHEEL`可提供滚轮转动量。[消息定义](https://learn.microsoft.com/en-us/windows/win32/inputdev/wm-mousewheel) | 输入量不是已绘制像素位移。键盘、拖滚动条、脚本滚动、嵌套容器、平滑滚动中途反向等都可能脱离预测。插值只能改变视觉轨迹，不能恢复尚未收到的真实位置。后两句为工程推断。 | 不满足“始终贴住”，不作为修复交付。 |
| 将入口设成浏览器子窗口／使用原生合成 | `SetParent`改变 HWND 父子关系；DirectComposition 能对自有窗口创建视觉树。[SetParent](https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-setparent)、[CreateTargetForHwnd](https://learn.microsoft.com/en-us/windows/win32/api/dcomp/nf-dcomp-idcompositiondesktopdevice-createtargetforhwnd) | HWND 关系不包含 DOM 文本或网页滚动节点身份；移动外层窗口与页面内部滚动是两件事。DirectComposition 明确拒绝绑定另一个进程的 HWND，不能直接把拾译节点接进 Edge 的页面滚动树。前一项为接口能力推断。 | 可处理外窗移动，不能凭空提供词语锚点；本轮不尝试跨进程挂载或注入。 |
| 无扩展浏览器调试桥（CDP） | Edge 支持 DevTools Protocol；当前官方文档还列出 `edge://inspect` 中允许当前实例远程调试的入口。CDP 可执行页面脚本。[Edge 协议](https://learn.microsoft.com/en-us/microsoft-edge/devtools/protocol/)、[当前实例连接说明](https://learn.microsoft.com/en-us/microsoft-edge/web-platform/devtools-mcp-server)、[Runtime 协议](https://chromedevtools.github.io/devtools-protocol/tot/Runtime/) | **技术上可行，不需要扩展。** 但用户必须开启调试连接，拾译要新增页面脚本、目标绑定、导航清理和桌面桥。权限涉及浏览器活动会话；不是普通桌面进程默认可读的接口。本机 Edge 是否提供该设置，本轮没有打开核查。 | 若未来接受这种使用条件，这是 Edge 网页最直接的后续路线；不冒充本轮小修。 |
| 画面追踪＋UIA 定期校验 | Desktop Duplication 能取逐帧画面及移动／脏矩形；模板匹配能在图像里定位已有图块。[Windows 捕获接口](https://learn.microsoft.com/en-us/windows/win32/direct3ddxgi/desktop-dup-api)、[OpenCV 模板匹配](https://docs.opencv.org/4.13.0/d4/dc6/tutorial_py_template_matching.html) | 可绕过辅助功能坐标节奏，但捕获接口不提供“这仍是同一选区”的语义。重复文本、遮挡、选区变色、缩放重排、离屏重现等需置信度和丢失处理；DXGI 移动矩形也允许为空。实时捕获、图像处理和资源管理是新路径。上述可靠性要求为工程推断。 | 保留为探索，不能凭一个静态模板样例宣称通用可靠。 |

CDP 路线还需区分两种交付：只把页面坐标传给外部浮窗，仍有跨进程更新与显示延迟；把入口放入原文所在滚动容器，才有机会与原文共用滚动变换。后者可复用已有网页内原型的方向，但必须另测复杂页面、嵌套滚动、跨源框架、缩放和实际 Edge；现有原型并不证明这些全部通过。

## 最小实验：事件订阅是否让坐标更及时（已完成）

实验假设：UIA／WinEvent 订阅可能激活不同提供方行为，使保留选区的坐标更新快于纯轮询。本轮先验证这个廉价假设，避免直接投入 IA2 或屏幕图像追踪重构。

事件订阅诊断脚本仅保留在本机归档，不进入公开仓库。脚本从独立保存的跟随探针生成两份临时原生助手，均使用 16 毫秒轮询，绑定自己的固定样本 HWND／PID，三个回合各创建新的隔离窗口。正式助手没有应用事件改动。

订阅组增加：窗口子树的 `BoundingRectangle`、垂直／水平 `ScrollPercent`属性，`LayoutInvalidated`事件，以及按 PID 限定、有消息循环的 `EVENT_OBJECT_LOCATIONCHANGE`、`EVENT_SYSTEM_SCROLLINGEND`钩子。回调只计数；坐标仍由相同的 16 毫秒路径读取。因此它直接检验“订阅是否促使更快更新”，没有把新增回调调度当作产品实现。回调即时读取可能减少客户端等待，但本实验没有出现能被 16 毫秒取样捕获的更快坐标更新。

沿用现有测量门槛：连续移动阶段至少 80 个有效位置更新、更新间隔 P95 不超过 60 毫秒、误差 P95 不超过 18 CSS 像素，并能滚出隐藏、滚回恢复。该门槛仅用于筛选原型，最终体验仍需用户实测。

| 回合 | 无订阅：间隔 P95／误差 P95 | 有订阅：间隔 P95／误差 P95 | 每组有效更新数 | 结论 |
| --- | --- | --- | --- | --- |
| 1 | 524 毫秒／160 CSS 像素 | 518 毫秒／158 CSS 像素 | 7 | 均未通过 |
| 2 | 519 毫秒／163 CSS 像素 | 513 毫秒／159 CSS 像素 | 7 | 均未通过 |
| 3 | 510 毫秒／164 CSS 像素 | 523 毫秒／164 CSS 像素 | 7 | 均未通过 |

原始位置测量：无订阅 1（原件仅本机归档）、无订阅 2（原件仅本机归档）、无订阅 3（原件仅本机归档）、有订阅 1（原件仅本机归档）、有订阅 2（原件仅本机归档）、有订阅 3（原件仅本机归档）。本研究已逐份读取核对。

六组的离屏隐藏和返回恢复均为真。主代理执行输出显示，三个订阅组的位置与滚动钩子都注册成功，每组在 5 秒计数点收到 10 次滚动事件，属性／布局／位置事件各为 0。计数由诊断脚本输出到控制台，不在上述 JSON 中；这里按执行输出记录，不能把“属性事件为 0”扩大成所有 UIA 提供方均不发事件。

**否证结果：** 已有真实滚动事件到达，但订阅没有使本样本坐标更新达到门槛。结果与匹配版本的 Chromium 源码机制一致。继续把事件计数更多、曲线更平滑或轮询更频繁当成修好依据是不成立的。本轮不再围绕同一缓存换读取 API 反复试发布。

该诊断脚本会创建自己的可见固定样本窗口；本次测量范围是坐标来源，不包含实际拾译浮窗端到端显示延迟。脚本仅对固定材料有授权，不应将它改成扫描用户桌面。

## Word 与 PDF 应分别判断

**Word 有值得保留的专用路线。** Word 对象模型的 `Window.GetPoint`能返回指定 `Range`的屏幕坐标；不可见时会报错。这提供了独立于浏览器 UIA 的应用内几何来源。[Word GetPoint 文档](https://learn.microsoft.com/en-us/office/vba/api/word.window.getpoint) 后续可以对固定 Word 文档保存 `Selection.Range.Duplicate`并测量 COM 查询节奏、滚动时响应和选区身份。但文档没有逐帧时延保证，本轮未调用用户 Word；不能把“存在接口”写成“Word 已能平滑跟随”，也不能推导 WPS 兼容。

**Edge PDF 不能套用网页实验。** 微软为内置 PDF 阅读器提供独立配置，并存在 Adobe Acrobat 引擎相关版本迁移。[官方 PDF 阅读器策略](https://learn.microsoft.com/en-us/deployedge/microsoft-edge-policies/newpdfreaderenabled) 本轮未核对用户实例采用的 PDF 引擎，更没有测量其选区事件或矩形节奏。网页 DOM 的选区脚本与 Chromium HTML 辅助功能代码不能直接证明该 PDF 阅读器行为；文字层与扫描图像也必须分开验证。

## 本轮交付决定与以后重启条件

按用户“无可靠方案则恢复屏幕固定入口”的条件，建议恢复已保留的固定入口版本；回退与运行包核对由主代理执行。本报告不声明回退动作已经完成。

本轮保留跟随诊断源码、原始指标和网页内对照材料。以后只有出现以下任一新条件时再重启跟随交付：用户接受浏览器调试桥；某个应用的专用接口在固定样本实测通过；或图像追踪原型先通过误匹配、遮挡、离屏重现及资源占用验证。届时仍应先完成真实目标应用的固定样本测量，再由用户验证体验。

证据分类保持不变：官方文档证明接口与限制，源码证明所查版本的实现，隔离实验说明固定样本的表现，用户真实应用体验才是产品验收。这里没有“所有 Windows 应用固定延迟 500 毫秒”或“无扩展方案绝对不可能”的结论。
