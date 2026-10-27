package feishu

import (
	"encoding/json"
	"fmt"
	"strconv"
)

// blockTypeNames 对齐官方 BlockType 枚举。
var blockTypeNames = map[int]string{
	1:  "page",
	2:  "text",
	3:  "heading1",
	4:  "heading2",
	5:  "heading3",
	6:  "heading4",
	7:  "heading5",
	8:  "heading6",
	9:  "heading7",
	10: "heading8",
	11: "heading9",
	12: "bullet",
	13: "ordered",
	14: "code",
	15: "quote",
	17: "todo",
	18: "bitable",
	19: "callout",
	20: "chat_card",
	21: "diagram",
	22: "divider",
	23: "file",
	24: "grid",
	25: "grid_column",
	26: "iframe",
	27: "image",
	28: "isv",
	29: "mindnote",
	30: "sheet",
	31: "table",
	32: "table_cell",
	33: "view",
	34: "quote_container",
	35: "task",
	36: "okr",
	37: "okr_objective",
	38: "okr_key_result",
	39: "okr_progress",
	40: "add_ons",
	41: "jira_issue",
	42: "wiki_catalog",
	43: "board",
	44: "agenda",
	45: "agenda_item",
	46: "agenda_item_title",
	47: "agenda_item_content",
	48: "link_preview",
	49: "source_synced",
	50: "reference_synced",
}

// textFieldByType 承载富文本的块类型 -> 内容字段名（字段名恰好等于类型名）。
var textFieldByType = map[int]string{
	1:  "page",
	2:  "text",
	12: "bullet",
	13: "ordered",
	14: "code",
	15: "quote",
	17: "todo",
	22: "divider",
}

func init() {
	for i := 1; i <= 9; i++ {
		textFieldByType[2+i] = "heading" + strconv.Itoa(i)
	}
}

// editableTextTypes 能通过 update_text_elements 改写的块类型（分割线没有文字）。
var editableTextTypes = map[int]bool{
	1: true, 2: true,
	3: true, 4: true, 5: true, 6: true, 7: true, 8: true, 9: true, 10: true, 11: true,
	12: true, 13: true, 14: true, 15: true, 17: true,
}

// writeBlock 描述一种可新建的块：BlockType 是飞书枚举，Field 是内容字段名。
type writeBlock struct {
	BlockType int
	Field     string
}

// writeBlocks 可新建的块类型。
var writeBlocks = map[string]writeBlock{
	"text":       {2, "text"},
	"heading1":   {3, "heading1"},
	"heading2":   {4, "heading2"},
	"heading3":   {5, "heading3"},
	"heading4":   {6, "heading4"},
	"heading5":   {7, "heading5"},
	"heading6":   {8, "heading6"},
	"heading7":   {9, "heading7"},
	"heading8":   {10, "heading8"},
	"heading9":   {11, "heading9"},
	"bullet":     {12, "bullet"},
	"ordered":    {13, "ordered"},
	"code":       {14, "code"},
	"quote":      {15, "quote"},
	"todo":       {17, "todo"},
	"callout":    {19, "callout"},
	"divider":    {22, "divider"},
	"table":      {31, "table"},
	"table_cell": {32, "table_cell"},
	"image":      {27, "image"},
	"board":      {43, "board"},
}

// typeAliases 常见别名 -> 规范块类型。
var typeAliases = map[string]string{
	"h1": "heading1", "h2": "heading2", "h3": "heading3", "h4": "heading4",
	"h5": "heading5", "h6": "heading6", "h7": "heading7", "h8": "heading8", "h9": "heading9",
	"title": "heading1", "subtitle": "heading2",
	"paragraph": "text", "p": "text", "plain": "text",
	"list": "bullet", "ul": "bullet", "unordered": "bullet",
	"ol": "ordered", "numbered": "ordered",
	"checkbox": "todo", "check": "todo", "task": "todo",
	"hr": "divider", "separator": "divider", "line": "divider",
	"blockquote": "quote", "pre": "code", "codewrap": "code",
	"img": "image", "picture": "image", "photo": "image", "图片": "image",
	"whiteboard": "board", "画板": "board",
}

// codeLanguages 代码块 language 名称 -> 飞书 CodeLanguage 枚举值（官方 1~75）。
var codeLanguages = map[string]int{
	"plaintext": 1, "text": 1, "plain": 1,
	"bash":   7,
	"csharp": 8, "c#": 8,
	"c++": 9, "cpp": 9,
	"c":          10,
	"css":        12,
	"dart":       15,
	"dockerfile": 18, "docker": 18,
	"go": 22, "golang": 22,
	"html":       24,
	"json":       28,
	"java":       29,
	"javascript": 30, "js": 30,
	"kotlin": 32,
	"latex":  33, "tex": 33,
	"lua":      36,
	"markdown": 39, "md": 39,
	"php":    43,
	"python": 49, "py": 49,
	"r":    50,
	"ruby": 52, "rb": 52,
	"rust": 53, "rs": 53,
	"sql":   56,
	"scala": 57,
	"shell": 60, "sh": 60, "zsh": 60,
	"swift":      61,
	"typescript": 63, "ts": 63,
	"xml":  66,
	"yaml": 67, "yml": 67,
	"cmake":   68,
	"diff":    69,
	"graphql": 71,
	"toml":    75,
}

// blockStyleFieldBits 块级样式 -> update_text_style.fields 位。
var blockStyleFieldBits = map[string]int{
	"align":             1,
	"done":              2,
	"folded":            3,
	"language":          4,
	"wrap":              5,
	"background_color":  6,
	"indentation_level": 7,
}

var alignValues = map[string]int{"left": 1, "center": 2, "right": 3}

var indentValues = map[string]string{
	"none": "NoIndent", "noindent": "NoIndent",
	"one": "OneLevelIndent", "onelevelindent": "OneLevelIndent",
}

var backgroundColors = map[string]string{
	"lightgray": "LightGrayBackground", "lightred": "LightRedBackground",
	"lightorange": "LightOrangeBackground", "lightyellow": "LightYellowBackground",
	"lightgreen": "LightGreenBackground", "lightblue": "LightBlueBackground",
	"lightpurple": "LightPurpleBackground", "palegray": "PaleGrayBackground",
	"darkgray": "DarkGrayBackground", "darkred": "DarkRedBackground",
	"darkorange": "DarkOrangeBackground", "darkyellow": "DarkYellowBackground",
	"darkgreen": "DarkGreenBackground", "darkblue": "DarkBlueBackground",
	"darkpurple": "DarkPurpleBackground",
}

// calloutBackgrounds 高亮块背景色（CalloutBackgroundColor 枚举）。
var calloutBackgrounds = map[string]int{
	"lightred": 1, "lightorange": 2, "lightyellow": 3, "lightgreen": 4,
	"lightblue": 5, "lightpurple": 6, "lightgray": 7,
	"darkred": 8, "darkorange": 9, "darkyellow": 10, "darkgreen": 11,
	"darkblue": 12, "darkpurple": 13, "darkgray": 14,
}

// ---------------------------------------------------------------------------
// 对外数据结构
// ---------------------------------------------------------------------------

// Span 是一段带内联样式的文字。
type Span struct {
	Text          string `json:"text,omitempty" jsonschema:"文字内容"`
	Content       string `json:"content,omitempty" jsonschema:"文字内容（text 的别名，与 Python 版兼容）"`
	Bold          bool   `json:"bold,omitempty" jsonschema:"加粗"`
	Italic        bool   `json:"italic,omitempty" jsonschema:"斜体"`
	Underline     bool   `json:"underline,omitempty" jsonschema:"下划线"`
	Strikethrough bool   `json:"strikethrough,omitempty" jsonschema:"删除线"`
	InlineCode    bool   `json:"inline_code,omitempty" jsonschema:"行内代码"`
	Link          string `json:"link,omitempty" jsonschema:"超链接 URL（文字变成该链接）"`
	TextColor     int    `json:"text_color,omitempty" jsonschema:"文字颜色，飞书 TextColor 枚举值（1-7）"`
	BgColor       int    `json:"background_color,omitempty" jsonschema:"文字标记底色，飞书 BackgroundColor 枚举值"`
}

// body 返回该片的文字内容，text 优先，content 作为别名兜底（与 Python 版一致）。
func (s Span) body() string {
	if s.Text != "" {
		return s.Text
	}
	return s.Content
}

// InlineStyle 是整段统一的内联样式。
type InlineStyle struct {
	Bold          bool   `json:"bold,omitempty" jsonschema:"加粗"`
	Italic        bool   `json:"italic,omitempty" jsonschema:"斜体"`
	Underline     bool   `json:"underline,omitempty" jsonschema:"下划线"`
	Strikethrough bool   `json:"strikethrough,omitempty" jsonschema:"删除线"`
	InlineCode    bool   `json:"inline_code,omitempty" jsonschema:"行内代码"`
	Link          string `json:"link,omitempty" jsonschema:"超链接 URL"`
	TextColor     int    `json:"text_color,omitempty" jsonschema:"文字颜色，飞书 TextColor 枚举值（1-7）"`
	BgColor       int    `json:"background_color,omitempty" jsonschema:"文字标记底色，飞书 BackgroundColor 枚举值"`
}

// FlexString 是既能接受 JSON 字符串、也能接受 JSON 数字的字符串字段。
//
// 模型常把枚举当数字传（{"language":22}、{"sequence":1}），Python 版靠动态类型
// 天然容纳；Go 在解码时归一成字符串，再交给上层做枚举校验。
type FlexString string

// UnmarshalJSON 接受字符串 / 数字 / null，其余类型报错。
func (f *FlexString) UnmarshalJSON(b []byte) error {
	var v any
	if err := json.Unmarshal(b, &v); err != nil {
		return err
	}
	switch x := v.(type) {
	case nil:
		*f = ""
	case string:
		*f = FlexString(x)
	case float64:
		*f = FlexString(strconv.FormatFloat(x, 'f', -1, 64))
	default:
		return fmt.Errorf("需要字符串或数字，收到 %v", x)
	}
	return nil
}

// BlockStyle 是块级样式（不是字体）。
type BlockStyle struct {
	Align            FlexString `json:"align,omitempty" jsonschema:"对齐方式：left / center / right，也接受 1/2/3"`
	Done             *bool      `json:"done,omitempty" jsonschema:"todo 勾选状态"`
	Folded           *bool      `json:"folded,omitempty" jsonschema:"标题/列表是否折叠"`
	Language         FlexString `json:"language,omitempty" jsonschema:"仅 code 块：代码语言，如 python / go / json，也接受枚举数字"`
	Wrap             *bool      `json:"wrap,omitempty" jsonschema:"仅 code 块：是否自动换行"`
	IndentationLevel string     `json:"indentation_level,omitempty" jsonschema:"缩进层级：none / one"`
	BackgroundColor  string     `json:"background_color,omitempty" jsonschema:"块背景色，如 lightgray / lightyellow / lightblue"`
	Sequence         FlexString `json:"sequence,omitempty" jsonschema:"仅 ordered 列表：auto 或起始编号，不能单独使用，需同时给其它块级样式"`
}

// BlockSpec 是一个待创建的块定义。
type BlockSpec struct {
	Type string `json:"type" jsonschema:"块类型：text / heading1..heading9 / bullet / ordered / quote / todo / code / divider / table / callout / table_cell"`

	Text       string       `json:"text,omitempty" jsonschema:"纯文本内容；给了 spans 时忽略"`
	Spans      []Span       `json:"spans,omitempty" jsonschema:"分片富文本，用于同段内不同样式；每片可选 bold/italic/underline/strikethrough/inline_code/link"`
	Style      *InlineStyle `json:"style,omitempty" jsonschema:"整段统一的内联样式"`
	BlockStyle *BlockStyle  `json:"block_style,omitempty" jsonschema:"块级样式（对齐/折叠/缩进/背景色等）"`

	Children []BlockSpec `json:"children,omitempty" jsonschema:"子块（递归同结构）；列表缩进、高亮块内容、表格单元格都用它"`

	Language FlexString `json:"language,omitempty" jsonschema:"仅 code 块：代码语言，如 python / go / json，也接受枚举数字"`
	Done     *bool      `json:"done,omitempty" jsonschema:"仅 todo 块：是否勾选"`

	// 顶层块级样式快捷方式（block_style 缺省时生效）
	Align            FlexString `json:"align,omitempty" jsonschema:"对齐方式：left / center / right，也接受 1/2/3（等价 block_style.align）"`
	Folded           *bool      `json:"folded,omitempty" jsonschema:"是否折叠（等价 block_style.folded）"`
	Wrap             *bool      `json:"wrap,omitempty" jsonschema:"仅 code 块：自动换行（等价 block_style.wrap）"`
	IndentationLevel string     `json:"indentation_level,omitempty" jsonschema:"缩进层级：none / one（等价 block_style.indentation_level）"`
	Sequence         FlexString `json:"sequence,omitempty" jsonschema:"仅 ordered 列表：auto 或起始编号（等价 block_style.sequence）"`

	// 表格
	Rows         [][]any `json:"rows,omitempty" jsonschema:"table 专用：二维数组，单元格可以是字符串或文本块定义。等价于自行组织 table_cell children"`
	HeaderRow    *bool   `json:"header_row,omitempty" jsonschema:"table 专用：首行是否为表头"`
	HeaderColumn *bool   `json:"header_column,omitempty" jsonschema:"table 专用：首列是否为表头"`
	ColumnWidth  []int   `json:"column_width,omitempty" jsonschema:"table 专用：列宽数组"`
	RowSize      int     `json:"row_size,omitempty" jsonschema:"table 专用：行数（不给 rows 时必须同时给 column_size）"`
	ColumnSize   int     `json:"column_size,omitempty" jsonschema:"table 专用：列数"`

	// image / board
	Token string `json:"token,omitempty" jsonschema:"image 专用：飞书素材 file_token（先用 feishu_insert_image 上传拿到；也可用已存在的 token 重复插入）"`

	// 高亮块
	BackgroundColor string `json:"background_color,omitempty" jsonschema:"callout 专用背景色：lightred/lightorange/lightyellow/lightgreen/lightblue/lightpurple/lightgray 及 dark 系列"`
	EmojiID         string `json:"emoji_id,omitempty" jsonschema:"callout 专用：图标 emoji id"`

	// 顶层内联样式快捷方式（等价 style 里的同名字段）
	Bold          bool   `json:"bold,omitempty" jsonschema:"整段加粗（等价 style.bold）"`
	Italic        bool   `json:"italic,omitempty" jsonschema:"整段斜体（等价 style.italic）"`
	Underline     bool   `json:"underline,omitempty" jsonschema:"整段下划线（等价 style.underline）"`
	Strikethrough bool   `json:"strikethrough,omitempty" jsonschema:"整段删除线（等价 style.strikethrough）"`
	InlineCode    bool   `json:"inline_code,omitempty" jsonschema:"整段行内代码（等价 style.inline_code）"`
	Link          string `json:"link,omitempty" jsonschema:"整段超链接（等价 style.link）"`
	TextColor     int    `json:"text_color,omitempty" jsonschema:"整段文字颜色，飞书 TextColor 枚举值（等价 style.text_color）"`
	BgColor       int    `json:"bg_color,omitempty" jsonschema:"整段文字标记底色，飞书 BackgroundColor 枚举值（等价 style.background_color）"`
}

// styleFor 合并 block_style 与顶层快捷字段，并按块类型裁剪不适用的项。
func (s *BlockSpec) styleFor(kind string) *BlockStyle {
	var bs BlockStyle
	if s.BlockStyle != nil {
		bs = *s.BlockStyle
	} else {
		bs = BlockStyle{
			Align:            s.Align,
			Done:             s.Done,
			Folded:           s.Folded,
			Wrap:             s.Wrap,
			IndentationLevel: s.IndentationLevel,
			BackgroundColor:  s.BackgroundColor,
			Sequence:         s.Sequence,
		}
	}
	if kind == "code" {
		if s.Language != "" {
			bs.Language = s.Language
		}
	} else {
		bs.Language = ""
	}
	if kind != "todo" {
		bs.Done = nil
	}
	return &bs
}

// ---------------------------------------------------------------------------
// 块定位辅助（块原始 JSON 用 map 表示，字段形态因类型而异）
// ---------------------------------------------------------------------------
