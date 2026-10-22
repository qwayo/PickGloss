# 任务跟踪：GitHub Issues

本项目的任务和需求保存在 `qwayo/PickGloss` 的 GitHub Issues：
https://github.com/qwayo/PickGloss/issues

使用 `gh` CLI 操作，每次显式指定 `--repo qwayo/PickGloss`，无需依赖本地 Git 远程配置。

## 常用操作

- 创建任务：`gh issue create --repo qwayo/PickGloss --title "标题" --body-file <正文文件>`
- 读取任务：`gh issue view <编号> --repo qwayo/PickGloss --json number,title,body,labels,comments`
- 列出开放任务：`gh issue list --repo qwayo/PickGloss --state open --json number,title,body,labels,assignees`
- 添加评论：`gh issue comment <编号> --repo qwayo/PickGloss --body-file <评论文件>`
- 添加标签：`gh issue edit <编号> --repo qwayo/PickGloss --add-label "<标签>"`
- 移除标签：`gh issue edit <编号> --repo qwayo/PickGloss --remove-label "<标签>"`
- 关闭任务：`gh issue close <编号> --repo qwayo/PickGloss`

多行正文先写入 UTF-8 文件，再通过 `--body-file` 传递。

## PR 分流配置

`PRs as a request surface: no`

需求分流默认处理 Issues。

## 技能指令的含义

- “发布到任务跟踪器”：创建 GitHub Issue。
- “获取相关任务”：读取指定的 GitHub Issue。
- 分流角色对应的标签见 `triage-labels.md`。

## Wayfinder 工作约定

- 地图：使用一个带 `wayfinder:map` 标签的 Issue，记录笔记、已有决策和待澄清问题。
- 子任务：每个任务单独创建 Issue，并关联为地图的子 Issue。子任务类型使用 `wayfinder:research`、`wayfinder:prototype`、`wayfinder:grilling` 或 `wayfinder:task` 标签；使用前创建缺失的标签。
- 子任务关联：优先使用 GitHub 原生子 Issue；不可用时，在地图正文添加任务清单，并在子任务正文写入 `Part of #<地图编号>`。
- 阻塞关系：优先使用 GitHub 原生任务依赖；API 使用阻塞任务的数字数据库 ID，而非任务编号或 node_id。不可用时，在正文顶部写入 `Blocked by: #<编号>`。
- 可执行任务：从地图的开放子任务中，排除仍被开放任务阻塞或已被指派的任务，再按地图顺序选择第一个。
- 认领：开始处理前，使用 `gh issue edit <编号> --repo qwayo/PickGloss --add-assignee @me`。
- 完成：评论记录答案或结果，关闭子任务，再向地图的已有决策追加摘要和链接。
