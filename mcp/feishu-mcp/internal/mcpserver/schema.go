package mcpserver

import (
	"bytes"
	"encoding/json"
	"reflect"

	"feishu-mcp/internal/feishu"
	"github.com/google/jsonschema-go/jsonschema"
)

// flexTypes 把 FlexString 在 schema 里表达成“字符串或整数”，
// 让 {"language": 22} 这类数字写法能通过入参校验。
var flexTypes = map[reflect.Type]*jsonschema.Schema{
	reflect.TypeFor[feishu.FlexString](): {Types: []string{"string", "integer"}},
}

// inputSchema 生成 MCP 工具的入参 schema。
//
// feishu.BlockSpec 是递归类型（children 里还是 BlockSpec），jsonschema-go 的类型推断
// 遇到递归会直接报 cycle detected，所以用 $defs/block + $ref 显式表达递归，
// 其余字段仍由反射按 jsonschema tag 生成。overrides 用于补充其它需要手写的类型
// （例如给 receive_id_type 挂枚举）。
func inputSchema[T any](overrides map[reflect.Type]*jsonschema.Schema) *jsonschema.Schema {
	types := map[reflect.Type]*jsonschema.Schema{
		reflect.TypeFor[feishu.BlockSpec](): {Ref: "#/$defs/block"},
	}
	for t, s := range flexTypes {
		types[t] = s
	}
	for t, s := range overrides {
		types[t] = s
	}
	s, err := jsonschema.For[T](&jsonschema.ForOptions{TypeSchemas: types})
	if err != nil {
		// 与 SDK 自身的 panic 行为一致：schema 构造失败属于启动期致命错误。
		panic("构造 MCP 工具入参 schema 失败：" + err.Error())
	}
	s.Defs = nil
	if raw, err := json.Marshal(s); err == nil && bytes.Contains(raw, []byte("#/$defs/block")) {
		s.Defs = map[string]*jsonschema.Schema{"block": blockDef()}
	}
	return s
}

// mustSchema 用反射推断一个非递归类型的 schema，失败即 panic（启动期）。
func mustSchema[T any]() *jsonschema.Schema {
	s, err := jsonschema.For[T](&jsonschema.ForOptions{TypeSchemas: flexTypes})
	if err != nil {
		panic("构造 MCP 工具入参 schema 失败：" + err.Error())
	}
	return s
}

// blockDef 是 feishu.BlockSpec 的对外 schema（$defs/block）。
//
// 字段名必须与 BlockSpec 的 json tag 一一对应，由 schema_test.go 守护，禁止单边改动。
func blockDef() *jsonschema.Schema {
	str := func(desc string) *jsonschema.Schema {
		return &jsonschema.Schema{Type: "string", Description: desc}
	}
	// 枚举既可以写名字也可以写枚举数字（Python 版靠动态类型容纳）
	flex := func(desc string) *jsonschema.Schema {
		return &jsonschema.Schema{Types: []string{"string", "integer"}, Description: desc}
	}
	boolean := func(desc string) *jsonschema.Schema {
		return &jsonschema.Schema{Type: "boolean", Description: desc}
	}

	inlineStyle := mustSchema[feishu.InlineStyle]()
	inlineStyle.Description = "整段统一的内联样式（bold / italic / underline / strikethrough / inline_code / link）"
	blockStyle := mustSchema[feishu.BlockStyle]()
	blockStyle.Description = "块级样式（对齐/折叠/缩进/背景色/编号/代码语言）"

	props := map[string]*jsonschema.Schema{
		"type": str("块类型（必填）：text / heading1~heading9 / bullet / ordered / quote / todo / code / divider / table / callout / table_cell，并接受 h1~h9、title、subtitle、paragraph、ul、ol、checkbox、hr、pre 等别名"),

		"text":        str("纯文本内容；给了 spans 时忽略"),
		"spans":       {Type: "array", Items: mustSchema[feishu.Span](), Description: "分片富文本，用于同段内不同样式；每片可选 bold/italic/underline/strikethrough/inline_code/link"},
		"style":       inlineStyle,
		"block_style": blockStyle,
		"children": {Type: "array", Items: &jsonschema.Schema{Ref: "#/$defs/block"},
			Description: "子块（递归同结构）；列表缩进、高亮块内容、表格单元格都用它"},

		"language": flex("仅 code 块：代码语言名，如 python / go / json，也接受枚举数字"),
		"done":     boolean("仅 todo 块：是否勾选"),

		"align":             flex("对齐方式：left / center / right，也接受 1/2/3"),
		"folded":            boolean("是否折叠"),
		"wrap":              boolean("仅 code 块：是否自动换行"),
		"indentation_level": str("缩进层级：none / one"),
		"sequence":          flex("仅 ordered 列表：auto 或起始编号；不能单独使用，需同时给其它块级样式"),

		"rows": {Type: "array",
			Items:       &jsonschema.Schema{Type: "array", Items: &jsonschema.Schema{}},
			Description: "table 专用：二维数组，单元格可以是字符串或块定义。等价于自行组织 table_cell children"},
		"header_row":    boolean("table 专用：首行是否为表头"),
		"header_column": boolean("table 专用：首列是否为表头"),
		"column_width": {Type: "array", Items: &jsonschema.Schema{Type: "integer"},
			Description: "table 专用：列宽数组"},
		"row_size":    {Type: "integer", Description: "table 专用：行数（不给 rows 时必须同时给 column_size）"},
		"column_size": {Type: "integer", Description: "table 专用：列数"},

		"token": str("image 专用：飞书素材 file_token（先用 feishu_insert_image 上传拿到）"),

		"background_color": str("callout 专用背景色：lightred / lightorange / lightyellow / lightgreen / lightblue / lightpurple / lightgray 及 dark 系列"),
		"emoji_id":         str("callout 专用：图标 emoji id"),

		"bold":          boolean("整段加粗（等价 style.bold）"),
		"italic":        boolean("整段斜体（等价 style.italic）"),
		"underline":     boolean("整段下划线（等价 style.underline）"),
		"strikethrough": boolean("整段删除线（等价 style.strikethrough）"),
		"inline_code":   boolean("整段行内代码（等价 style.inline_code）"),
		"link":          str("整段超链接（等价 style.link）"),
		"text_color":    &jsonschema.Schema{Type: "integer", Description: "整段文字颜色，飞书 TextColor 枚举值（等价 style.text_color）"},
		"bg_color":      &jsonschema.Schema{Type: "integer", Description: "整段文字标记底色，飞书 BackgroundColor 枚举值（等价 style.background_color）"},
	}

	return &jsonschema.Schema{
		Type:                 "object",
		Properties:           props,
		Required:             []string{"type"},
		AdditionalProperties: &jsonschema.Schema{Not: &jsonschema.Schema{}},
	}
}
