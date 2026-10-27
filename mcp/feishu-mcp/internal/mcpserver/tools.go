package mcpserver

import (
	"context"
	"reflect"

	"feishu-mcp/internal/feishu"
	"github.com/google/jsonschema-go/jsonschema"
	"github.com/modelcontextprotocol/go-sdk/mcp"
)

// ---------------------------------------------------------------------------
// 消息
// ---------------------------------------------------------------------------

// SendMessageArgs 是 feishu_send_message 的入参。
type SendMessageArgs struct {
	ReceiveID     string               `json:"receive_id" jsonschema:"接收方 ID，含义由 receive_id_type 决定（邮箱 / open_id / user_id / chat_id）"`
	Content       string               `json:"content" jsonschema:"消息内容。msg_type 为 text 时为纯文本；其他类型时为 JSON 字符串"`
	ReceiveIDType feishu.ReceiveIDType `json:"receive_id_type,omitempty" jsonschema:"接收方 ID 类型，默认 email"`
	MsgType       feishu.MsgType       `json:"msg_type,omitempty" jsonschema:"消息类型，默认 text"`
}

func (s *Server) registerMessage(srv *mcp.Server) {
	mcp.AddTool(srv, &mcp.Tool{
		Name: "feishu_send_message",
		Description: "以机器人身份发送飞书消息（私聊或群聊）。\n\n" +
			"receive_id 的含义由 receive_id_type 决定：email（默认）/ open_id / user_id / chat_id。\n" +
			"msg_type=text（默认）时 content 直接写纯文本；其他类型时 content 必须是 JSON 字符串。",
		InputSchema: sendMessageInputSchema(),
	}, handler(func(ctx context.Context, in SendMessageArgs) (*feishu.SendMessageResult, error) {
		return s.c.SendMessage(ctx, in.ReceiveID, in.Content, in.ReceiveIDType, in.MsgType)
	}))
}

// sendMessageInputSchema 在反射生成的 schema 上给两个枚举字段挂可选值。
func sendMessageInputSchema() *jsonschema.Schema {
	return inputSchema[SendMessageArgs](map[reflect.Type]*jsonschema.Schema{
		reflect.TypeFor[feishu.ReceiveIDType](): {
			Type: "string", Enum: []any{"email", "open_id", "user_id", "chat_id"},
		},
		reflect.TypeFor[feishu.MsgType](): {
			Type: "string", Enum: []any{"text", "post", "text_card", "image", "interactive"},
		},
	})
}

// ---------------------------------------------------------------------------
// 文档定位 / 读取
// ---------------------------------------------------------------------------

// ResolveDocArgs 是 feishu_resolve_doc 的入参。
type ResolveDocArgs struct {
	Ref string `json:"ref" jsonschema:"wiki 链接 / wiki 节点 token / docx 文档 ID 都行"`
}

func (s *Server) registerResolve(srv *mcp.Server) {
	mcp.AddTool(srv, &mcp.Tool{
		Name:        "feishu_resolve_doc",
		Description: "把 wiki 链接 / wiki 节点 token / docx 文档 ID 解析为文档 ID，返回类型与标题。",
	}, handler(func(ctx context.Context, in ResolveDocArgs) (*feishu.DocRef, error) {
		return s.c.ResolveDoc(ctx, in.Ref)
	}))
}

// ReadDocumentArgs 是 feishu_read_document 的入参。
type ReadDocumentArgs struct {
	Ref          string `json:"ref" jsonschema:"文档引用（wiki 链接 / wiki token / docx 文档 ID 都行）"`
	IncludeStyle bool   `json:"include_style,omitempty" jsonschema:"是否需要样式细节。要“只改颜色/加粗/看代码语言”时置 true"`
}

func (s *Server) registerRead(srv *mcp.Server) {
	mcp.AddTool(srv, &mcp.Tool{
		Name: "feishu_read_document",
		Description: "读取文档标题与完整块树。**改文档前先调用它拿 block_id。**\n\n" +
			"返回的 blocks 是树形结构，每个节点包含：\n" +
			"  block_id  稳定 ID（编辑时用它定位，不要用文字去猜）\n" +
			"  type      text / heading1-9 / bullet / ordered / code / quote / todo / divider / callout / grid / table / table_cell / image ...\n" +
			"  index     在父块 children 里的下标（0 起，用于定点插入）\n" +
			"  path      位置路径，如 \"3\" 或 \"3.1\"\n" +
			"  text      纯文本\n" +
			"  children  子块（列表项缩进、高亮块内容、表格单元格内容都在这里）\n\n" +
			"同时返回 title_block_id —— 它就是文档标题块，可传给 feishu_update_block 改标题。\n" +
			"include_style=true 时额外返回 style（对齐/折叠/代码语言/todo 勾选）与 spans（逐片内联样式）。",
	}, handler(func(ctx context.Context, in ReadDocumentArgs) (any, error) {
		return s.c.ReadDocument(ctx, in.Ref, in.IncludeStyle)
	}))
}

// ---------------------------------------------------------------------------
// 原地编辑
// ---------------------------------------------------------------------------

// UpdateBlockArgs 是 feishu_update_block 的入参。
type UpdateBlockArgs struct {
	Ref        string              `json:"ref" jsonschema:"文档引用"`
	BlockID    string              `json:"block_id" jsonschema:"要改的块（来自 feishu_read_document）"`
	Text       *string             `json:"text,omitempty" jsonschema:"新的纯文本。整段内容会被替换"`
	Spans      []feishu.Span       `json:"spans,omitempty" jsonschema:"分片富文本，用于同段内不同样式。给了这个就忽略 text。例：[{\"text\":\"重要：\",\"bold\":true},{\"text\":\"普通说明\"}]"`
	Style      *feishu.InlineStyle `json:"style,omitempty" jsonschema:"整段统一的内联样式，如 {\"bold\":true}、{\"link\":\"https://...\"}"`
	BlockStyle *feishu.BlockStyle  `json:"block_style,omitempty" jsonschema:"块级样式（不是字体）：align / done / folded / language / wrap / indentation_level / background_color / sequence"`
}

func (s *Server) registerUpdate(srv *mcp.Server) {
	mcp.AddTool(srv, &mcp.Tool{
		Name: "feishu_update_block",
		Description: "**原地修改一个已存在的块**：block_id 不变、在文档中的位置和顺序不变、子块不变。\n\n" +
			"这是“改已有段落”的标准做法，不要用 delete + append 重建整篇。\n\n" +
			"block_style 说明：\n" +
			"  align: left / center / right\n" +
			"  done: bool          —— todo 勾选状态\n" +
			"  folded: bool        —— 标题/列表折叠\n" +
			"  language: str       —— 仅 code 块，如 \"python\" / \"go\"\n" +
			"  wrap: bool          —— 仅 code 块，自动换行\n" +
			"  indentation_level: \"none\" / \"one\"\n" +
			"  background_color: 如 \"LightGrayBackground\"\n" +
			"  sequence: \"auto\" / \"1\" —— 仅 ordered 列表编号\n\n" +
			"注意：block_type 不能通过本工具改（飞书没有该接口）。把普通段落改成标题请用 feishu_replace_block。\n\n" +
			"示例：\n" +
			"  改一段正文      feishu_update_block(ref, \"doxcn...\", text=\"新的说明\")\n" +
			"  只改 todo 勾选  feishu_update_block(ref, \"doxcn...\", block_style={\"done\": true})\n" +
			"  代码块换语言    feishu_update_block(ref, \"doxcn...\", block_style={\"language\": \"go\"})\n" +
			"  改文档标题      feishu_update_block(ref, <title_block_id>, text=\"新标题\")",
		InputSchema: inputSchema[UpdateBlockArgs](nil),
	}, handler(func(ctx context.Context, in UpdateBlockArgs) (*feishu.UpdateBlockResult, error) {
		return s.c.UpdateBlock(ctx, in.Ref, in.BlockID, feishu.UpdateBlockArgs{
			Text: in.Text, Spans: in.Spans, Style: in.Style, BlockStyle: in.BlockStyle,
		})
	}))
}

// PatchBlockArgs 是 feishu_patch_block 的入参。
type PatchBlockArgs struct {
	Ref     string `json:"ref" jsonschema:"文档引用"`
	BlockID string `json:"block_id" jsonschema:"目标块（来自 feishu_read_document）"`
	Find    string `json:"find" jsonschema:"要查找的原文本（精确匹配）"`
	Replace string `json:"replace,omitempty" jsonschema:"替换成的新文本；传空串等于删除这几个字"`
	All     bool   `json:"all,omitempty" jsonschema:"为 true 时替换该块内全部命中，默认只替换第一处"`
}

func (s *Server) registerPatch(srv *mcp.Server) {
	mcp.AddTool(srv, &mcp.Tool{
		Name: "feishu_patch_block",
		Description: "在单个块内做“查找替换”，**保留其余文字的内联样式和整段结构**。\n\n" +
			"用于只改一句话里的几个字：比 feishu_update_block（整段替换）更不容易丢格式。\n" +
			"跨 text_run 的匹配也能处理（例如把加粗片段里的词换掉）。\n\n" +
			"返回 replaced 为实际替换次数；为 0 表示没找到，文档未改动。",
	}, handler(func(ctx context.Context, in PatchBlockArgs) (*feishu.PatchBlockResult, error) {
		return s.c.PatchBlock(ctx, in.Ref, in.BlockID, in.Find, in.Replace, in.All)
	}))
}

// ---------------------------------------------------------------------------
// 结构编辑
// ---------------------------------------------------------------------------

// InsertBlocksArgs 是 feishu_insert_blocks 的入参。
type InsertBlocksArgs struct {
	Ref           string             `json:"ref" jsonschema:"文档引用"`
	Blocks        []feishu.BlockSpec `json:"blocks" jsonschema:"块列表。每块至少要有 type，其余按需给 text / spans / style / block_style / language / done / children"`
	Index         *int               `json:"index,omitempty" jsonschema:"插入到父块 children 的下标位置（0 起）；省略或 -1 表示末尾。例如现有 [A,B,C]，index=1 插在 A 与 B 之间"`
	ParentBlockID string             `json:"parent_block_id,omitempty" jsonschema:"父块 ID。省略 = 文档顶层。要给某个列表项加子项、往高亮块里塞内容时传该父块的 block_id"`
}

func (s *Server) registerInsert(srv *mcp.Server) {
	mcp.AddTool(srv, &mcp.Tool{
		Name: "feishu_insert_blocks",
		Description: "在指定位置插入一批块（默认文档末尾）。\n\n" +
			"与 append 的区别：可以插到任何下标，不会打乱前后结构。\n\n" +
			"块定义示例：\n" +
			"  标题 + 正文 + 带两个子项的无序列表\n" +
			"  [{\"type\": \"heading2\", \"text\": \"背景\"},\n" +
			"   {\"type\": \"text\", \"text\": \"普通段落。\"},\n" +
			"   {\"type\": \"bullet\", \"text\": \"父项\", \"children\": [\n" +
			"       {\"type\": \"bullet\", \"text\": \"子项一\"},\n" +
			"       {\"type\": \"bullet\", \"text\": \"子项二\"}]}]\n\n" +
			"  2x2 表格\n" +
			"  [{\"type\": \"table\", \"rows\": [[\"表头A\", \"表头B\"], [\"值1\", \"值2\"]], \"header_row\": true}]\n\n" +
			"  高亮块\n" +
			"  [{\"type\": \"callout\", \"text\": \"注意\", \"background_color\": \"lightyellow\"}]\n\n" +
			"  在文档最前面插一段\n" +
			"  feishu_insert_blocks(ref, [{\"type\": \"text\", \"text\": \"开头\"}], index=0)\n\n" +
			"type 支持：text / heading1~heading9 / bullet / ordered / quote / todo / code / divider / table / callout。\n" +
			"高亮块、分栏列必须至少有一个子块，callout 传 text 时会自动补一个文本子块。",
		InputSchema: inputSchema[InsertBlocksArgs](nil),
	}, handler(func(ctx context.Context, in InsertBlocksArgs) (*feishu.InsertBlocksResult, error) {
		index := -1
		if in.Index != nil {
			index = *in.Index
		}
		return s.c.InsertBlocks(ctx, in.Ref, in.Blocks, index, in.ParentBlockID)
	}))
}

// AppendDocumentArgs 是 feishu_append_document 的入参。
type AppendDocumentArgs struct {
	Ref    string             `json:"ref" jsonschema:"文档引用"`
	Blocks []feishu.BlockSpec `json:"blocks" jsonschema:"块列表，格式同 feishu_insert_blocks"`
}

func (s *Server) registerAppend(srv *mcp.Server) {
	mcp.AddTool(srv, &mcp.Tool{
		Name: "feishu_append_document",
		Description: "向文档**末尾**追加块（等价 feishu_insert_blocks(index=-1)）。\n\n" +
			"只在真的要“往后接内容”时用。要改已有段落请用 feishu_update_block / feishu_patch_block；\n" +
			"要插到中间请用 feishu_insert_blocks 指定 index。块格式同 feishu_insert_blocks。",
		InputSchema: inputSchema[AppendDocumentArgs](nil),
	}, handler(func(ctx context.Context, in AppendDocumentArgs) (*feishu.InsertBlocksResult, error) {
		return s.c.AppendDocument(ctx, in.Ref, in.Blocks)
	}))
}

// DeleteBlockArgs 是 feishu_delete_block 的入参。
type DeleteBlockArgs struct {
	Ref     string `json:"ref" jsonschema:"文档引用"`
	BlockID string `json:"block_id" jsonschema:"要删除的块 ID（来自 feishu_read_document）"`
}

func (s *Server) registerDelete(srv *mcp.Server) {
	mcp.AddTool(srv, &mcp.Tool{
		Name: "feishu_delete_block",
		Description: "按 block_id 删除一个块（任意层级，含其所有子块）。\n\n" +
			"删父块会连带删除子块；只想删列表里的某一项就用那一项的 block_id。",
	}, handler(func(ctx context.Context, in DeleteBlockArgs) (*feishu.DeleteBlockResult, error) {
		return s.c.DeleteBlock(ctx, in.Ref, in.BlockID)
	}))
}

// ReplaceBlockArgs 是 feishu_replace_block 的入参。
type ReplaceBlockArgs struct {
	Ref     string             `json:"ref" jsonschema:"文档引用"`
	BlockID string             `json:"block_id" jsonschema:"被替换的块 ID"`
	Blocks  []feishu.BlockSpec `json:"blocks,omitempty" jsonschema:"新的块列表（格式同 feishu_insert_blocks），可以为多块；传空数组等于删除"`
}

func (s *Server) registerReplace(srv *mcp.Server) {
	mcp.AddTool(srv, &mcp.Tool{
		Name: "feishu_replace_block",
		Description: "替换块的类型/内容，**位置不变**（block_id 会变）。\n\n" +
			"飞书接口没有“改 block_type”，所以“普通段落 → 二级标题”只能：\n" +
			"在原下标插入新块，再删除旧块。前后块的位置和顺序不受影响。",
		InputSchema: inputSchema[ReplaceBlockArgs](nil),
	}, handler(func(ctx context.Context, in ReplaceBlockArgs) (*feishu.ReplaceBlockResult, error) {
		return s.c.ReplaceBlock(ctx, in.Ref, in.BlockID, in.Blocks)
	}))
}

// EditDocumentArgs 是 feishu_edit_document 的入参。
type EditDocumentArgs struct {
	Ref        string             `json:"ref" jsonschema:"文档引用"`
	Operations []feishu.Operation `json:"operations" jsonschema:"按顺序执行的操作列表"`
	DryRun     bool               `json:"dry_run,omitempty" jsonschema:"为 true 时只校验 block_id 是否存在、参数是否合法，不写入文档。建议大改动先 dry_run"`
}

func (s *Server) registerEditDocument(srv *mcp.Server) {
	mcp.AddTool(srv, &mcp.Tool{
		Name: "feishu_edit_document",
		Description: "一次提交多步编辑，按顺序执行（减少来回调用，适合整篇结构调整）。\n\n" +
			"每个 operation 的 op 取值：\n" +
			"  {\"op\": \"update\",  \"block_id\": \"...\", \"text\": \"...\", \"block_style\": {...}}\n" +
			"  {\"op\": \"patch\",   \"block_id\": \"...\", \"find\": \"...\", \"replace\": \"...\"}\n" +
			"  {\"op\": \"insert\",  \"index\": 1, \"blocks\": [...], \"parent_block_id\": \"...\"}\n" +
			"  {\"op\": \"append\",  \"blocks\": [...]}\n" +
			"  {\"op\": \"replace\", \"block_id\": \"...\", \"blocks\": [...]}\n" +
			"  {\"op\": \"delete\",  \"block_id\": \"...\"}\n" +
			"  {\"op\": \"delete_range\", \"start_index\": 0, \"end_index\": 2, \"parent_block_id\": \"...\"}  # 左闭右开；parent 省略=顶层\n\n" +
			"dry_run=true 时只校验 block_id 是否存在、参数是否合法，不写入文档。建议大改动先 dry_run。\n\n" +
			"失败会停在出错那一步，返回信息里带“已成功 N 步”，已完成的部分不会回滚\n" +
			"——所以把风险高的操作放前面，或者先用 dry_run 验一遍。",
		InputSchema: inputSchema[EditDocumentArgs](nil),
	}, handler(func(ctx context.Context, in EditDocumentArgs) (*feishu.EditDocumentResult, error) {
		return s.c.EditDocument(ctx, in.Ref, in.Operations, in.DryRun)
	}))
}

// ---------------------------------------------------------------------------
// 图片 / 流程图
// ---------------------------------------------------------------------------

// InsertImageArgs 是 feishu_insert_image 的入参。
type InsertImageArgs struct {
	Ref           string `json:"ref" jsonschema:"文档引用"`
	Source        string `json:"source" jsonschema:"图片地址：本地文件路径，或 http(s) URL（会先下载再上传）"`
	Index         *int   `json:"index,omitempty" jsonschema:"插入位置下标（0 起）；省略或 -1 表示末尾"`
	ParentBlockID string `json:"parent_block_id,omitempty" jsonschema:"父块 ID，省略 = 文档顶层；要给高亮块里放图时传该高亮块的 block_id"`
	Align         string `json:"align,omitempty" jsonschema:"图片对齐：left / center / right"`
}

func (s *Server) registerImage(srv *mcp.Server) {
	mcp.AddTool(srv, &mcp.Tool{
		Name: "feishu_insert_image",
		Description: "上传一张图片并插入到文档（返回 file_token，可复用同一个 token 插入多张）。\n\n" +
			"source 支持本地路径（绝对/相对）和 http(s) URL；单张上限 20MB。\n" +
			"需要应用开通 docs:document.media:upload 权限，且机器人是该文档的协作者。",
	}, handler(func(ctx context.Context, in InsertImageArgs) (*feishu.InsertImageResult, error) {
		index := -1
		if in.Index != nil {
			index = *in.Index
		}
		return s.c.InsertImage(ctx, in.Ref, in.Source, index, in.ParentBlockID, in.Align)
	}))
}

// InsertFlowchartArgs 是 feishu_insert_flowchart 的入参。
type InsertFlowchartArgs struct {
	Ref           string `json:"ref" jsonschema:"文档引用"`
	PlantUML      string `json:"plantuml" jsonschema:"PlantUML 源码，需包含 @startuml / @enduml"`
	Index         *int   `json:"index,omitempty" jsonschema:"插入位置下标（0 起）；省略或 -1 表示末尾"`
	ParentBlockID string `json:"parent_block_id,omitempty" jsonschema:"父块 ID，省略 = 文档顶层"`
}

func (s *Server) registerFlowchart(srv *mcp.Server) {
	mcp.AddTool(srv, &mcp.Tool{
		Name: "feishu_insert_flowchart",
		Description: "在文档里插入一个画板块，并把 PlantUML 流程图渲染进去。\n\n" +
			"注意：飞书 docx 的 diagram 块无法通过 API 创建（1770029 not support to create），" +
			"所以流程图的可行路径是「建 board 画板块 + 画板接口渲染 PlantUML」。\n" +
			"需要应用开通 board:whiteboard:node:create 权限。\n\n" +
			"示例 plantuml：\n" +
			"  @startuml\n" +
			"  start\n" +
			"  :读取文档;\n" +
			"  if (校验通过?) then (是)\n" +
			"    :写入块;\n" +
			"  else (否)\n" +
			"    :返回错误;\n" +
			"  endif\n" +
			"  stop\n" +
			"  @enduml\n\n" +
			"想精确控制坐标/配色画架构图，可以只建空画板（feishu_insert_blocks 里 type=board），" +
			"再用画板节点接口自行摆放。",
	}, handler(func(ctx context.Context, in InsertFlowchartArgs) (*feishu.InsertFlowchartResult, error) {
		index := -1
		if in.Index != nil {
			index = *in.Index
		}
		return s.c.InsertFlowchart(ctx, in.Ref, in.PlantUML, index, in.ParentBlockID)
	}))
}
