# feishu-mcp

飞书机器人的 stdio MCP 服务（Go 版），基于官方 [MCP Go SDK](https://github.com/modelcontextprotocol/go-sdk)。把飞书开放平台能力（发消息、云文档读写、知识库节点解析）封装成 12 个 MCP 工具，供 pi、Cursor、Claude Desktop、Qoder 或任意支持 MCP 的 agent 调用。

**重点：支持原地编辑已有段落。** 不是只能“文末追加 / 整段删除”——改一段话用 `feishu_update_block`，文字、`block_id`、在文档里的位置都不变，前后结构不受影响。

- 单个静态二进制，无运行时依赖
- 官方 SDK，协议帧、握手、错误处理均由 SDK 处理
- 凭据通过环境变量或本地 `config.json` 提供，`config.json` 已 gitignore
- 日志只走 stderr，stdout 专用于 MCP 协议

## 构建

```bash
go build -o feishu-mcp .
./feishu-mcp          # 直接从 stdin/stdout 跑 MCP stdio 服务
```

静态门禁：

```bash
go build ./... && go vet ./... && go test ./...
```

## 提供的工具

| 工具 | 说明 |
| --- | --- |
| `feishu_send_message` | 以机器人身份发消息（私聊/群聊，默认纯文本） |
| `feishu_resolve_doc` | 把 wiki 链接 / wiki token / docx 文档 ID 解析成文档 ID |
| `feishu_read_document` | 读文档标题 + 完整块树（block_id、类型、位置、层级、可选样式） |
| `feishu_update_block` | **原地改已有块**的内容 / 内联样式 / 块级样式，位置和 ID 不变 |
| `feishu_patch_block` | 段内查找替换，保留该段其余文字的内联样式 |
| `feishu_insert_blocks` | 在任意下标插入，支持 `children` 嵌套（列表缩进、高亮块等） |
| `feishu_append_document` | 末尾追加（等价 `insert_blocks(index=-1)`，保留兼容） |
| `feishu_delete_block` | 按 block_id 删除（任意层级，含子块） |
| `feishu_replace_block` | 换块类型：同位置插入新块 + 删旧块（`block_id` 会变） |
| `feishu_edit_document` | 一次提交多步编辑，支持 `dry_run` 预检 |
| `feishu_insert_image` | 上传图片并插入（本地路径或 http(s) URL，返回可复用 `file_token`） |
| `feishu_insert_flowchart` | 插画板块并用 PlantUML 渲染流程图 |

## 怎么改已有段落

```text
1. feishu_read_document(ref)                          拿到 blocks[].block_id
2. feishu_update_block(ref, block_id, text="新内容")    原地覆盖这一段
```

只改一句话里的几个字、且想保住加粗/链接等格式：

```text
feishu_patch_block(ref, block_id, find="旧词", replace="新词")
```

要插到中间而不是末尾：

```text
feishu_insert_blocks(ref, blocks, index=3)            插到第 3 个块之前
```

给某个列表项加子项：

```text
feishu_insert_blocks(ref, blocks, parent_block_id=<列表项的 block_id>)
```

整篇结构调整（先预演）：

```text
feishu_edit_document(ref, operations, dry_run=true)
feishu_edit_document(ref, operations)
```

### 块定义格式（`feishu_insert_blocks` / `feishu_replace_block` / `feishu_append_document`）

```json
{"type": "heading2", "text": "背景"}
{"type": "text", "text": "普通段落"}
{"type": "text", "spans": [{"text": "加粗", "bold": true}, {"text": "普通"}]}
{"type": "bullet", "text": "父项", "children": [
  {"type": "bullet", "text": "子项一"},
  {"type": "bullet", "text": "子项二"}]}
{"type": "todo", "text": "待办", "done": false}
{"type": "code", "text": "print(1)", "language": "python"}
{"type": "ordered", "text": "第一条"}
{"type": "quote", "text": "引用"}
{"type": "divider"}
{"type": "table", "rows": [["表头A", "表头B"], ["值1", "值2"]], "header_row": true}
{"type": "callout", "text": "高亮内容", "background_color": "lightyellow"}
```

- `type` 必填。支持 `text` / `heading1`~`heading9` / `bullet` / `ordered` / `quote` / `todo` / `code` / `divider` / `table` / `callout` / `table_cell`，也接受 `h1`~`h9`、`title`、`subtitle`、`paragraph`、`ul`、`ol`、`checkbox`、`hr`、`pre` 等别名。
- `spans` 用于同段内不同样式（`bold` / `italic` / `underline` / `strikethrough` / `inline_code` / `link`），给了就忽略 `text`。
- `block_style` 改块级样式：`align`（left/center/right 或 1/2/3）、`done`、`folded`、`language`（名称或枚举数字）、`wrap`、`indentation_level`、`background_color`、`sequence`（不能单独使用）。
- `table` 的 `rows` 是二维数组，单元格可以是字符串，也可以是块定义：

```json
{"type": "table", "rows": [
  ["表头A", "表头B"],
  [{"type": "text", "text": "普通文本"}, {"type": "todo", "text": "待办", "done": true}]
]}
```

表格也可以直接写 `children`（`table_cell` 列表）。高亮块、分栏列必须至少有一个子块，`callout` 传 `text` 时会自动补一个文本子块。

## 能力边界（接口没有的，不是没实现）

| 需求 | 结论 |
| --- | --- |
| 改已有段落的文字/样式 | ✅ `feishu_update_block`，ID 与位置不变 |
| 段内局部替换、保格式 | ✅ `feishu_patch_block` |
| 插入到任意位置 | ✅ `feishu_insert_blocks(index=...)` |
| 嵌套列表 / 高亮块 / 分栏 | ✅ `children` + 创建嵌套块接口 |
| 改 todo 勾选、代码语言、折叠、对齐 | ✅ `block_style` |
| 改文档标题 | ✅ 对 `title_block_id` 调 `feishu_update_block` |
| **改 block_type**（正文↔标题） | ❌ 飞书无此接口。用 `feishu_replace_block`：同位置插新删旧，顺序不乱但 `block_id` 会变 |
| 删除中间某个块 | ✅ `feishu_delete_block`（按父块+下标，不是按 ID 硬删） |
| 表格创建 / 单元格文字 | ✅ `{"type":"table","rows":[...]}`；单元格文字用嵌套 text 块的 `block_id` 原地改 |
| 高亮块 / 分栏 | ✅ `{"type":"callout","children":[...]}`，分栏列需自带子块 |
| 插入图片 | ✅ `feishu_insert_image`（本地文件或 URL，≤20MB，需 `docs:document.media:upload`） |
| 流程图 | ✅ `feishu_insert_flowchart`（PlantUML → 画板节点，需 `board:whiteboard:node:create`）；❌ 原生 `diagram` 块无法创建 |
| 代码块 + 语言高亮 | ✅ `{"type":"code","language":"go"}`，支持 `wrap`、`block_style.language` 原地改 |
| 高亮块配色 | ✅ `{"type":"callout","background_color":"lightyellow"}`，14 种颜色 |
| 段内文字颜色 / 标记底色 | ✅ `style.text_color` / `style.background_color`（飞书 TextColor/BackgroundColor 枚举值） |
| 电子表格 / 多维表格创建 | ❌ 未封装（需要子表初始化） |
| 未知字段 / 缺 `type` | ❌ 被入参 schema 直接拒绝（返回 SDK 的英文 schema 校验错误，不会发出请求）。字段名必须与 schema 完全一致，拼错即失败 |

## 快速开始

```bash
# 1. 准备凭据（二选一）
cp config.example.json config.json   # 然后填入 app_id / app_secret
# 或者用环境变量：
export FEISHU_APP_ID=cli_xxx
export FEISHU_APP_SECRET=xxx

# 2. 构建
go build -o feishu-mcp .

# 3. 直接跑（stdio MCP 服务，日志在 stderr）
./feishu-mcp
```

## 构建与安装

```bash
go build -trimpath -ldflags="-s -w" -o feishu-mcp .
```

推荐装到 `~/.pi/mcp-servers/feishu-mcp/`（二进制 + 同级 `config.json`），这样不依赖启动时的工作目录：

```bash
mkdir -p ~/.pi/mcp-servers/feishu-mcp
go build -trimpath -ldflags="-s -w" -o ~/.pi/mcp-servers/feishu-mcp/feishu-mcp .
cp config.json ~/.pi/mcp-servers/feishu-mcp/config.json
```

## 接入 MCP 客户端

**pi（推荐，走 pi-mcp-adapter 的用户级共享配置）**：编辑 `~/.config/mcp/mcp.json`

```json
{
  "mcpServers": {
    "feishu": {
      "command": "/Users/你/.pi/mcp-servers/feishu-mcp/feishu-mcp",
      "lifecycle": "lazy",
      "requestTimeoutMs": 60000,
      "description": "飞书机器人：发消息、读文档块树、原地编辑段落"
    }
  }
}
```

改完在 pi 会话里 `/reload`，或用 `/mcp-adapter` 查看；命令行校验：

```bash
~/.pi/agent/npm/node_modules/.bin/pi-mcp-adapter doctor   # 期望 feishu → state ok, tools 10
```

注意：`pi mcp list` 读的是 pi 自带的 `~/.pi/agent/mcp.json`，与上面这份共享配置是两套；本项目按共享配置接入（与 `gopls-lsp` 一致）。工具名形如 `mcp__feishu__feishu_read_document`，默认走 codemode（模型需用 `searchTools()` 发现），想让模型直接看到 10 个工具就给 entry 加 `"directTools": true`。

也可用 `pi mcp add` 写 pi 自带位置（二选一，不要两边重复注册）：

```bash
pi mcp add feishu --env FEISHU_APP_ID=cli_xxx --env FEISHU_APP_SECRET=xxx \
  --exposure deferred -- /Users/你/.pi/mcp-servers/feishu-mcp/feishu-mcp
```

通用 JSON 形式（Qoder `~/.qoder/settings.json` / Cursor `~/.cursor/mcp.json` 等）：

```json
{
  "mcpServers": {
    "feishu": {
      "command": "/绝对路径/feishu-mcp",
      "env": {
        "FEISHU_APP_ID": "cli_xxx",
        "FEISHU_APP_SECRET": "xxx"
      }
    }
  }
}
```

`env` 里不放凭据时，服务会回退到 `config.json`。

## 配置优先级

1. 环境变量 `FEISHU_APP_ID` + `FEISHU_APP_SECRET`
2. 环境变量 `FEISHU_CONFIG` 指向的 JSON 文件
3. 可执行文件同目录的 `config.json`
4. 当前工作目录的 `config.json`

## 权限要求

应用需在飞书开放平台开通以下权限（scope）：

- `im:message:send_as_bot` —— 发消息
- `docx:document:write_only` —— 编辑文档（创建/更新/删除块）
- `docx:document:readonly` —— 读取文档
- `wiki:node:read` —— 解析知识库节点（缺这个时，`/wiki/` 链接只能靠 token 恰好等于 docx token 侥幸成功）
- `docs:document.media:upload` —— `feishu_insert_image` 上传图片
- `board:whiteboard:node:create` —— `feishu_insert_flowchart` 渲染流程图节点

要操作的文档需把机器人添加为协作者（可编辑）才能写入；**能读不能写** 时报 `1770032 forBidden`。

### 图片与流程图

```text
feishu_insert_image(ref, source="/abs/path/shot.png", align="center")
feishu_insert_image(ref, source="https://example.com/a.png")

feishu_insert_flowchart(ref, plantuml="""@startuml
start
:读取文档;
if (校验通过?) then (是)
  :写入块;
else (否)
  :返回错误;
endif
stop
@enduml""")
```

也可以只建空白画板（`{"type":"board"}` / `{"type":"image","token":"..."}` 走 `feishu_insert_blocks`），再用画板节点接口自行摆放精确坐标的架构图。

> 飞书 docx 的 `diagram` 块**无法通过 API 创建**（`1770029 block not support to create`），所以流程图走「`board` 画板块 + `/board/v1/whiteboards/{id}/nodes/plantuml`」这条路。

## 限频与健壮性

飞书对单应用 3 QPS、单文档并发 3 QPS 限频（错误码 99991400 / 1254290 / 1061045 / HTTP 429）。客户端已内置：

- 写请求最小间隔（360ms），避免自己打满 3 QPS
- 命中限频时指数退避重试（最多 5 次，单次上限 8s）
- 读请求网络异常自动重试
- **写请求网络中断不自动重试**（结果未知，重试可能建出重复块），直接报错并提示先读文档确认
- 非 JSON 响应体不重试，错误码直接取 HTTP 状态码
- `tenant_access_token` 进程内缓存，过期前 1 分钟自动刷新

## 目录结构

```
feishu-mcp/
├── main.go                     # 凭据装载 + stdio MCP 服务入口
├── internal/
│   ├── feishu/
│   │   ├── client.go           # HTTP / 限频 / 重试 / token / baseURL
│   │   ├── config.go           # 凭据优先级
│   │   ├── errors.go           # 统一错误类型
│   │   ├── types.go            # 块类型枚举表 / BlockSpec / BlockStyle / Span
│   │   ├── elements.go         # 富文本 elements 构造 + 段内查找替换
│   │   ├── blocks.go           # 块定义规整与 payload
│   │   ├── doc.go              # resolve / read / 树构建 / locate
│   │   ├── edit.go             # insert / update / patch / delete / replace
│   │   ├── editdocument.go     # 批量编辑
│   │   ├── message.go          # 发消息
│   │   ├── media.go            # 图片上传 / 画板与流程图
│   │   └── *_test.go           # 单元测试（httptest，不触网）
│   └── mcpserver/
│       ├── server.go           # MCP 服务装配
│       ├── tools.go            # 12 个工具的入参结构与描述
│       └── schema.go           # 递归 BlockSpec 的 $defs/block schema
├── config.example.json         # 凭据模板
├── config.json                 # 真实凭据（gitignore）
└── go.mod / go.sum
```

## 已知行为与取舍

| 行为 | 说明 |
| --- | --- |
| 入参强类型、禁止未知字段 | 字段名必须与工具 schema 完全一致，拼错或塞未知字段会被 SDK 直接拒绝并返回**英文** schema 校验栈（不会发出请求）；`BlockSpec.type` 必填 |
| `dry_run` 也会校验必填参数 | `find` / `start_index` / `end_index` 在 `dry_run` 下同样必填 |
| 块树 `index` 保真 | 父块 `children` 里存在但响应缺失的块 ID 会被跳过，**但保留下标不压缩** —— `index` 可以直接拿去 `feishu_insert_blocks` |
| `feishu_replace_block` 空 `blocks` | 等价删除，回包里带 `deleted`（同时仍有 `replaced_block_id` / `created`） |
| `include_style=true` 时空样式被省略 | 该块没有块级样式时不下发 `style` 键 |
| `revision_id` 拿不到时为 `0` | 不返回 `null` |
| 空文本字段被省略 | `span.text` / `updated.text` 为空时不下发该键 |
| 表格尺寸校验更严 | `row_size` / `column_size` 为负或缺失时直接报错，不会把非法值下发 |
| `block_style.language` 对 code 块生效 | 顶层 `language` 与 `block_style.language` 都认（后者优先），属超集 |
| `feishu_read_document` 不生成 outputSchema | 返回结构是递归树，靠 `structuredContent` + `content[0].text` 携带 |
| 空文档的 `blocks` 是 `[]` | 不是 `null`，调用方可以直接遍历 |
| `feishu_update_block` 分两次下发 | 飞书 `batch_update` 不允许同一个块一次请求里既改文本又改样式（`1770001`），所以给 text+block_style 时会顺序发两次；第二次失败的错误里会提示“文本已改完、样式未生效” |
| `folded` 只对标题/可折叠块有效 | 对普通段落设 `folded` 会拿到 `1770024`，错误信息里会点名原因 |

