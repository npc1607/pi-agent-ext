---
name: dev-doc-workflow
description: 开发全流程文档工作流（Obsidian vault「docs」）。接到需求后在 TODO/ 新建技术方案 TODO，方案定稿后迁移到 技术方案/，开发完成后基于 自测文档/开发提测文档-模板.md 生成开发提测文档。当用户提到「写技术方案」「记个 TODO」「方案定稿/归档」「提测」「写提测文档」「开发提测文档」等时使用。
---

# 开发全流程文档：技术方案 TODO → 技术方案 → 开发提测

覆盖三个阶段，按用户当前所处阶段执行对应部分，不要一次性全部执行。

## 环境与路径

| 资源 | 位置 |
| --- | --- |
| Obsidian vault | 名为 `docs`，基路径 `~/obsidian/docs`（可用 `obsidian eval code="app.vault.getName()"` 校验） |
| 技术方案 TODO | `TODO/` 目录 |
| 技术方案（定稿） | `技术方案/` 目录，按年月子目录分类（如 `技术方案/2026-09/`）；已完成归档的放 `技术方案/归档/<YYYY-MM>/` |
| 提测文档模板 | `自测文档/开发提测文档-模板.md`（vault 未配置 Template 插件，直接读该文件内容作模板） |
| 提测文档实例 | `自测文档/开发提测文档-<JIRA编号>-<需求标题>.md` |
| 代码仓库 | `~/Project/services/`（gitlab.x2robot.com，`glab` CLI 可用） |

工具选择原则：

- **读/搜索/移动/属性**：优先用 `obsidian` CLI（`obsidian read`、`obsidian search`、`obsidian move`、`obsidian property:set`）。`obsidian move` 会自动更新反链，不要直接 `mv`。
- **写大段内容**：CLI 的 `content=` 需要 `\n` 转义，长文档不适用。直接用 write 工具写 vault 基路径下的绝对路径（如 `~/obsidian/docs/TODO/xxx.md`），Obsidian 会自动感知新文件。已存在的文件先 `obsidian read` 再编辑。

## 阶段一：新建技术方案 TODO

在 `TODO/` 下创建笔记，文件名用需求短标题（如 `解析事件跳过中间态直接推进终态与预处理分流方案.md`）。

frontmatter 固定格式（参考 `TODO/0709.md`、`TODO/QC 质检人改派权限待办.md`）：

```yaml
---
title: <完整标题，可含服务名前缀，如 data-service 任务与审核列表改造 TODO>
date: YYYY-MM-DD
tags:
  - todo
  - <服务名，如 data-service>
  - <领域，如 job / qc / dispatch>
status: todo
---
```

正文结构约定：

1. `# <标题>`，紧跟 `> [!summary] 目标` callout 用一两句话写目标。
2. `> [!important] 当前代码基线` callout：先实际读代码确认已有能力（用 rg / read），明确「已存在什么、还缺什么」，避免方案里重复新增同义字段。**不要凭空写基线，必须查代码。**
3. 正文按模块分节（`## 一、xxx`），待办用 `- [ ]` checkbox，每个 checkbox 是可验证的改动点（精确到文件/函数/字段/SQL）。
4. 需要澄清的需求点单独列出，标注「需要维护…的映射」「最终值需冻结」等风险提示。

## 阶段二：TODO 定稿 → 技术方案

1. 将 TODO 笔记迁移：`obsidian move path="TODO/<文件>.md" to="技术方案/<当前年月，如 2026-10>"`（目录不存在先 `mkdir`，`obsidian move` 不会自动建目录），文件名按惯例改为 `<标题>技术方案.md`（可用 `obsidian rename`）。
2. 内容从「开发自查清单」改写为「面向评审的方案文档」（参考 `技术方案/人员真实姓名展示改造技术方案.md`）：
   - 去掉 frontmatter 的 `status: todo`，改 `status: design`（或删除 frontmatter，与技术方案目录现有文档保持一致：标题下用 blockquote 列 **状态 / 适用服务 / 文档路径 / 涉及接口**）。
   - checkbox 展开为 `## 1. 背景与目的`、`## 2. 现状全景分析`（接口×字段×数据来源的矩阵表格）、`## 3. 改造方案`、`## 4. 性能与兼容性`、`## 5. 测试要点` 等成文章节。
   - 接口清单必须写完整路径（如 `POST /api/job/v1/list`）。
3. 需求上线或彻底关闭后：`obsidian move path="技术方案/<年月>/<文件>.md" to="技术方案/归档/<该文件的年月>"`（归档同样按年月子目录存放，月份取文件原所在年月，不随归档时间变）。

## 阶段三：生成开发提测文档

产物：`自测文档/开发提测文档-<JIRA编号>-<需求标题>.md`（如 `开发提测文档-RD001-2236-人员展示名与同名账号数据隔离.md`）。

### 内容来源（按此顺序采集，缺失项先问用户，不要编造）

1. **模板结构**：先 `obsidian read path="自测文档/开发提测文档-模板.md"`，完整复制七大节（基础信息 / 提测内容 / 测试指引 / 依赖与风险 / 开发自测情况 / 附件 / 备注），保持表格结构不删节。模板里 `Pipline链接` 的拼写照抄。
2. **关联技术方案笔记**：`obsidian search query="<需求关键词>"` 找 `技术方案/<年月>/` 和 `TODO/` 下的相关笔记，提取：
   - 需求背景 → §2.1（改写为带序号的问题描述，含 Jira 单号和 PRD 链接时写入 §一 基础信息）
   - 改造点清单 → §2.2 功能清单（每行：功能点 / 说明 / P0~P2 优先级）
   - 涉及接口、表结构变更、第三方依赖 → §2.3 改动范围（接口写全路径，一行一个用 `<br>`）
   - 明确不做的部分（兼容回退、洗数等）→ §2.4 本次不包含内容
3. **git 仓库信息**：确认涉及的服务仓库（默认 `~/Project/services/<服务名>`）后执行：
   ```bash
   git -C <repo> branch --show-current                 # 代码分支
   git -C <repo> remote get-url origin                 # 拼 MR 基础链接
   git -C <repo> log --oneline origin/main..HEAD 2>/dev/null || git -C <repo> log --oneline -10  # 改动摘要
   glab mr list -R <group>/<repo> --source-branch=<分支>  # MR 编号
   ```
   MR 链接格式：`https://gitlab.x2robot.com/cloud/<repo>/-/merge_requests/<iid>`；Pipeline 链接为 MR 合并后的 `/-/pipelines/<id>`。
4. **对话中提供**：提测人、提测日期、预计测试周期、Jira/PRD 链接、提测环境（测试环境 / 预发环境）、测试重点、已知问题。信息不全时集中一次性询问用户（用 ask_user_question 或直接列出缺项），仍缺的在表格中留空。

### 填写规范

- 不确定的字段**留空**，禁止编造测试账号、覆盖率、自测结果。
- §5.1 自测结果和 §5.2 自动化测试：有真实数据才填「通过」，否则保持模板占位。
- 提测文档创建后，如关联 TODO 笔记仍为 `status: todo`，用 `obsidian property:set name="status" value="done" path="TODO/<文件>.md"` 更新（或按用户要求归档）。
- 创建完成后输出文件完整路径，并提醒用户补齐测试环境信息（§3.1 通常由测试/用户填写）。

## 快速命令参考

```bash
obsidian search query="<关键词>" limit=10            # 找笔记
obsidian read path="TODO/<文件>.md"                    # 读笔记
obsidian move path="TODO/<文件>.md" to="技术方案/2026-10"  # 迁移（自动更新反链，目录需先 mkdir）
obsidian property:set name="status" value="done" path="TODO/<文件>.md"
```
