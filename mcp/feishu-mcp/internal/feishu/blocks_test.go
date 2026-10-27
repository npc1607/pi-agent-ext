package feishu

import (
	"strings"
	"testing"
)

func TestNormalizeBlockType(t *testing.T) {
	ok := map[string]string{
		"text":       "text",
		"":           "text",
		"h1":         "heading1",
		"title":      "heading1",
		"H2":         "heading2",
		" H2 ":       "heading2",
		"paragraph":  "text",
		"p":          "text",
		"ul":         "bullet",
		"ol":         "ordered",
		"checkbox":   "todo",
		"hr":         "divider",
		"pre":        "code",
		"table_cell": "table_cell",
	}
	for in, want := range ok {
		got, err := normalizeBlockType(in)
		if err != nil {
			t.Errorf("normalizeBlockType(%q) 返回错误：%v", in, err)
			continue
		}
		if got != want {
			t.Errorf("normalizeBlockType(%q) = %q，期望 %q", in, got, want)
		}
	}

	_, err := normalizeBlockType("video")
	if err == nil {
		t.Fatal("video 应该报错")
	}
	want := "飞书错误 -1：不支持的块类型：video（可用：board, bullet, callout, code, divider, heading1, heading2, heading3, heading4, heading5, heading6, heading7, heading8, heading9, image, ordered, quote, table, table_cell, text, todo）"
	if err.Error() != want {
		t.Errorf("错误信息不匹配\n得到：%s\n期望：%s", err.Error(), want)
	}
}

func TestNormalizeSpec(t *testing.T) {
	t.Run("表格糖", func(t *testing.T) {
		out, err := NormalizeSpec(BlockSpec{Type: "table", Rows: [][]any{
			{"a", "b"},
			{"c", "d"},
		}})
		if err != nil {
			t.Fatal(err)
		}
		if out.RowSize != 2 || out.ColumnSize != 2 {
			t.Errorf("RowSize/ColumnSize = %d/%d，期望 2/2", out.RowSize, out.ColumnSize)
		}
		if len(out.Children) != 4 {
			t.Fatalf("children 数量 = %d，期望 4", len(out.Children))
		}
		for i, ch := range out.Children {
			if ch.Type != "table_cell" {
				t.Errorf("children[%d].Type = %q，期望 table_cell", i, ch.Type)
			}
			if len(ch.Children) != 1 {
				t.Errorf("children[%d] 的子块数量 = %d，期望 1", i, len(ch.Children))
			}
		}
		if got := out.Children[0].Children[0].Text; got != "a" {
			t.Errorf("第一个单元格文本 = %q，期望 a", got)
		}
	})

	t.Run("ragged 行", func(t *testing.T) {
		out, err := NormalizeSpec(BlockSpec{Type: "table", Rows: [][]any{
			{"a"},
			{"b", "c", "d"},
		}})
		if err != nil {
			t.Fatal(err)
		}
		if out.RowSize != 2 || out.ColumnSize != 3 {
			t.Errorf("RowSize/ColumnSize = %d/%d，期望 2/3", out.RowSize, out.ColumnSize)
		}
		if len(out.Children) != 4 {
			t.Errorf("children 数量 = %d，期望 4（逐行逐单元格）", len(out.Children))
		}
	})

	t.Run("单元格可以是块定义", func(t *testing.T) {
		out, err := NormalizeSpec(BlockSpec{Type: "table", Rows: [][]any{
			{map[string]any{"type": "h3", "text": "表头"}},
		}})
		if err != nil {
			t.Fatal(err)
		}
		if got := out.Children[0].Children[0].Type; got != "heading3" {
			t.Errorf("单元格内块类型 = %q，期望 heading3", got)
		}
	})

	t.Run("callout 默认子块", func(t *testing.T) {
		out, err := NormalizeSpec(BlockSpec{Type: "callout", Text: "note"})
		if err != nil {
			t.Fatal(err)
		}
		if len(out.Children) != 1 {
			t.Fatalf("children 数量 = %d，期望 1", len(out.Children))
		}
		if out.Children[0].Type != "text" || out.Children[0].Text != "note" {
			t.Errorf("默认子块 = %+v，期望 text/note", out.Children[0])
		}
	})

	t.Run("table_cell 默认子块", func(t *testing.T) {
		out, err := NormalizeSpec(BlockSpec{Type: "table_cell"})
		if err != nil {
			t.Fatal(err)
		}
		if len(out.Children) != 1 || out.Children[0].Type != "text" {
			t.Errorf("默认子块 = %+v，期望一个 text 子块", out.Children)
		}
	})

	t.Run("显式 children 不被 rows 覆盖", func(t *testing.T) {
		out, err := NormalizeSpec(BlockSpec{
			Type:     "table",
			Rows:     [][]any{{"ignored"}},
			Children: []BlockSpec{{Type: "table_cell", Children: []BlockSpec{{Type: "text", Text: "keep"}}}},
		})
		if err != nil {
			t.Fatal(err)
		}
		if out.RowSize != 1 || out.ColumnSize != 1 {
			t.Errorf("RowSize/ColumnSize = %d/%d，期望 1/1", out.RowSize, out.ColumnSize)
		}
		if len(out.Children) != 1 || out.Children[0].Children[0].Text != "keep" {
			t.Errorf("显式 children 被覆盖了：%+v", out.Children)
		}
	})

	t.Run("递归归一化子块", func(t *testing.T) {
		out, err := NormalizeSpec(BlockSpec{
			Type: "ul",
			Children: []BlockSpec{
				{Type: "h2", Text: "子标题"},
			},
		})
		if err != nil {
			t.Fatal(err)
		}
		if out.Type != "bullet" {
			t.Errorf("Type = %q，期望 bullet", out.Type)
		}
		if len(out.Children) != 1 || out.Children[0].Type != "heading2" {
			t.Errorf("子块类型 = %+v，期望 heading2", out.Children)
		}
	})

	t.Run("非法子类型冒泡", func(t *testing.T) {
		_, err := NormalizeSpec(BlockSpec{
			Type:     "text",
			Children: []BlockSpec{{Type: "video"}},
		})
		if err == nil || !strings.Contains(err.Error(), "不支持的块类型：video") {
			t.Errorf("期望冒泡子块错误，得到：%v", err)
		}
	})
}

func boolPtr(b bool) *bool { return &b }

func nodeOf(t *testing.T, payload map[string]any, field string) map[string]any {
	t.Helper()
	n, ok := payload[field].(map[string]any)
	if !ok {
		t.Fatalf("payload[%q] 不是对象：%#v", field, payload[field])
	}
	return n
}

func firstContent(t *testing.T, node map[string]any) string {
	t.Helper()
	els, ok := node["elements"].([]any)
	if !ok || len(els) == 0 {
		t.Fatalf("elements 缺失：%#v", node)
	}
	return asMap(asMap(els[0])["text_run"])["content"].(string)
}

func TestBlockPayloadTextLike(t *testing.T) {
	cases := []struct {
		kind      string
		blockType int
		field     string
	}{
		{"text", 2, "text"},
		{"heading1", 3, "heading1"},
		{"heading2", 4, "heading2"},
		{"heading3", 5, "heading3"},
		{"heading4", 6, "heading4"},
		{"heading5", 7, "heading5"},
		{"heading6", 8, "heading6"},
		{"heading7", 9, "heading7"},
		{"heading8", 10, "heading8"},
		{"heading9", 11, "heading9"},
		{"bullet", 12, "bullet"},
		{"ordered", 13, "ordered"},
		{"quote", 15, "quote"},
	}
	for _, tc := range cases {
		t.Run(tc.kind, func(t *testing.T) {
			p, err := blockPayload(BlockSpec{Type: tc.kind, Text: "内容"})
			if err != nil {
				t.Fatal(err)
			}
			if p["block_type"] != tc.blockType {
				t.Errorf("block_type = %v，期望 %d", p["block_type"], tc.blockType)
			}
			node := nodeOf(t, p, tc.field)
			if got := firstContent(t, node); got != "内容" {
				t.Errorf("content = %q，期望 内容", got)
			}
		})
	}
}

func TestBlockPayloadCode(t *testing.T) {
	p, err := blockPayload(BlockSpec{Type: "code", Text: "print(1)", Language: "python"})
	if err != nil {
		t.Fatal(err)
	}
	if p["block_type"] != 14 {
		t.Errorf("block_type = %v，期望 14", p["block_type"])
	}
	node := nodeOf(t, p, "code")
	style := asMap(node["style"])
	if style["language"] != 49 {
		t.Errorf("style.language = %v，期望 49", style["language"])
	}
	if _, ok := node["fields"]; ok {
		t.Error("payload 里不应出现 fields（Python 版 compute 后丢弃）")
	}
}

func TestBlockPayloadTodo(t *testing.T) {
	p, err := blockPayload(BlockSpec{Type: "todo", Text: "待办", Done: boolPtr(true)})
	if err != nil {
		t.Fatal(err)
	}
	node := nodeOf(t, p, "todo")
	style := asMap(node["style"])
	if style["done"] != true {
		t.Errorf("style.done = %v，期望 true", style["done"])
	}
	if _, ok := node["fields"]; ok {
		t.Error("payload 里不应出现 fields")
	}
}

func TestBlockPayloadDivider(t *testing.T) {
	p, err := blockPayload(BlockSpec{Type: "divider"})
	if err != nil {
		t.Fatal(err)
	}
	if p["block_type"] != 22 {
		t.Errorf("block_type = %v，期望 22", p["block_type"])
	}
	if _, ok := p["divider"]; !ok {
		t.Error("缺少 divider 字段")
	}
	if _, ok := p["style"]; ok {
		t.Error("divider 不应有 style")
	}
}

func TestBlockPayloadTableCell(t *testing.T) {
	p, err := blockPayload(BlockSpec{Type: "table_cell"})
	if err != nil {
		t.Fatal(err)
	}
	if p["block_type"] != 32 {
		t.Errorf("block_type = %v，期望 32", p["block_type"])
	}
	if _, ok := p["table_cell"]; !ok {
		t.Error("缺少 table_cell 字段")
	}
}

func TestBlockPayloadCallout(t *testing.T) {
	p, err := blockPayload(BlockSpec{Type: "callout", Text: "注意", BackgroundColor: "lightyellow", EmojiID: "e1"})
	if err != nil {
		t.Fatal(err)
	}
	if p["block_type"] != 19 {
		t.Errorf("block_type = %v，期望 19", p["block_type"])
	}
	data := nodeOf(t, p, "callout")
	if data["background_color"] != 3 {
		t.Errorf("background_color = %v，期望 3", data["background_color"])
	}
	if data["emoji_id"] != "e1" {
		t.Errorf("emoji_id = %v，期望 e1", data["emoji_id"])
	}
}

func TestBlockPayloadTable(t *testing.T) {
	p, err := blockPayload(BlockSpec{
		Type: "table", RowSize: 2, ColumnSize: 2, HeaderRow: boolPtr(true),
	})
	if err != nil {
		t.Fatal(err)
	}
	if p["block_type"] != 31 {
		t.Errorf("block_type = %v，期望 31", p["block_type"])
	}
	prop := asMap(nodeOf(t, p, "table")["property"])
	if prop["row_size"] != 2 || prop["column_size"] != 2 {
		t.Errorf("property = %#v，期望 2x2", prop)
	}
	if prop["header_row"] != true {
		t.Errorf("header_row = %v，期望 true", prop["header_row"])
	}
}

func TestBlockPayloadTableRequiresSize(t *testing.T) {
	_, err := blockPayload(BlockSpec{Type: "table"})
	if err == nil || err.Error() != "飞书错误 -1：创建表格要给 rows 二维数组，或同时给 row_size 和 column_size" {
		t.Errorf("错误信息不匹配：%v", err)
	}
}

func TestBlockPayloadStyleOnlyNoFields(t *testing.T) {
	p, err := blockPayload(BlockSpec{Type: "text", Text: "x", BlockStyle: &BlockStyle{Align: "left"}})
	if err != nil {
		t.Fatal(err)
	}
	node := nodeOf(t, p, "text")
	style := asMap(node["style"])
	if style["align"] != 1 {
		t.Errorf("style.align = %v，期望 1", style["align"])
	}
	if _, ok := node["fields"]; ok {
		t.Error("payload 里不应出现 fields")
	}
}

func TestBlockPayloadSequenceAloneOnDivider(t *testing.T) {
	// divider / table_cell 提前返回，因此 sequence 单独出现也不报错（与 Python 一致）
	if _, err := blockPayload(BlockSpec{Type: "divider", Sequence: "auto"}); err != nil {
		t.Errorf("divider 上的 sequence 不应报错：%v", err)
	}
}
