package feishu

import (
	"encoding/json"
	"fmt"
	"sort"
	"strings"
)

// normalizeBlockType 解析块类型别名并校验是否支持创建。
func normalizeBlockType(kind string) (string, error) {
	k := strings.ToLower(strings.TrimSpace(kind))
	if k == "" {
		k = "text"
	}
	if alias, ok := typeAliases[k]; ok {
		k = alias
	}
	if _, ok := writeBlocks[k]; !ok {
		names := make([]string, 0, len(writeBlocks))
		for name := range writeBlocks {
			names = append(names, name)
		}
		sort.Strings(names)
		return "", errf(-1, "不支持的块类型：%s（可用：%s）", k, strings.Join(names, ", "))
	}
	return k, nil
}

// specFromAny 把 rows 里的单元格（字符串 / 块定义）统一成 BlockSpec。
func specFromAny(v any) (BlockSpec, error) {
	switch cell := v.(type) {
	case nil:
		return BlockSpec{Type: "text"}, nil
	case string:
		return BlockSpec{Type: "text", Text: cell}, nil
	case map[string]any:
		raw, err := json.Marshal(cell)
		if err != nil {
			return BlockSpec{}, errf(-1, "单元格定义无法解析：%v", err)
		}
		var spec BlockSpec
		if err := json.Unmarshal(raw, &spec); err != nil {
			return BlockSpec{}, errf(-1, "单元格定义无法解析：%v", err)
		}
		if spec.Type == "" {
			spec.Type = "text"
		}
		return spec, nil
	default:
		return BlockSpec{Type: "text", Text: fmt.Sprint(cell)}, nil
	}
}

// NormalizeSpec 规整块定义：表格糖、高亮块默认子块、递归处理 children。
func NormalizeSpec(spec BlockSpec) (BlockSpec, error) {
	kind, err := normalizeBlockType(spec.Type)
	if err != nil {
		return spec, err
	}
	out := spec
	out.Type = kind

	switch kind {
	case "table":
		if len(spec.Rows) > 0 {
			var cells []BlockSpec
			cols := 0
			for _, row := range spec.Rows {
				if len(row) > cols {
					cols = len(row)
				}
				for _, cell := range row {
					child, err := specFromAny(cell)
					if err != nil {
						return out, err
					}
					cells = append(cells, BlockSpec{Type: "table_cell", Children: []BlockSpec{child}})
				}
			}
			if len(out.Children) == 0 {
				out.Children = cells
			}
			out.RowSize = len(spec.Rows)
			out.ColumnSize = cols
		}
	case "callout", "table_cell":
		if len(spec.Children) == 0 {
			out.Children = []BlockSpec{{Type: "text", Text: spec.Text}}
		}
	}

	if len(out.Children) > 0 {
		children := make([]BlockSpec, len(out.Children))
		for i, ch := range out.Children {
			nc, err := NormalizeSpec(ch)
			if err != nil {
				return out, err
			}
			children[i] = nc
		}
		out.Children = children
	}
	return out, nil
}

// blockPayload 把块定义规范成飞书 block 结构。
func blockPayload(spec BlockSpec) (map[string]any, error) {
	kind, err := normalizeBlockType(spec.Type)
	if err != nil {
		return nil, err
	}
	wb := writeBlocks[kind]

	switch kind {
	case "divider":
		return map[string]any{"block_type": wb.BlockType, "divider": map[string]any{}}, nil
	case "table_cell":
		return map[string]any{"block_type": wb.BlockType, "table_cell": map[string]any{}}, nil
	case "board":
		return map[string]any{"block_type": wb.BlockType, "board": map[string]any{}}, nil
	case "image":
		if spec.Token == "" {
			return nil, errf(-1, "创建 image 块需要 token（素材 file_token）；先用 feishu_insert_image 上传，或直接给已有 token")
		}
		img := map[string]any{"token": spec.Token}
		if spec.Align != "" {
			if v, ok := alignValues[strings.ToLower(string(spec.Align))]; ok {
				img["align"] = v
			} else {
				img["align"] = spec.Align
			}
		}
		return map[string]any{"block_type": wb.BlockType, "image": img}, nil
	case "callout":
		data := map[string]any{}
		if spec.BackgroundColor != "" {
			key := strings.ToLower(spec.BackgroundColor)
			if v, ok := calloutBackgrounds[key]; ok {
				data["background_color"] = v
			} else {
				data["background_color"] = spec.BackgroundColor
			}
		}
		if spec.EmojiID != "" {
			data["emoji_id"] = spec.EmojiID
		}
		return map[string]any{"block_type": wb.BlockType, "callout": data}, nil
	case "table":
		if spec.RowSize <= 0 || spec.ColumnSize <= 0 {
			return nil, errf(-1, "创建表格要给 rows 二维数组，或同时给 row_size 和 column_size")
		}
		prop := map[string]any{"row_size": spec.RowSize, "column_size": spec.ColumnSize}
		if spec.HeaderRow != nil {
			prop["header_row"] = *spec.HeaderRow
		}
		if spec.HeaderColumn != nil {
			prop["header_column"] = *spec.HeaderColumn
		}
		if len(spec.ColumnWidth) > 0 {
			prop["column_width"] = spec.ColumnWidth
		}
		return map[string]any{"block_type": wb.BlockType, "table": map[string]any{"property": prop}}, nil
	}

	node := map[string]any{"elements": elementsFromSpec(spec)}
	style, _, err := buildBlockStyle(spec.styleFor(kind))
	if err != nil {
		return nil, err
	}
	if len(style) > 0 {
		node["style"] = style
	}
	return map[string]any{"block_type": wb.BlockType, wb.Field: node}, nil
}

// CreatedBlock 是创建成功后返回的块摘要。
type CreatedBlock struct {
	BlockID string `json:"block_id"`
	Type    string `json:"type"`
	Text    string `json:"text"`
}

func renderCreated(blocks []map[string]any) []CreatedBlock {
	out := make([]CreatedBlock, 0, len(blocks))
	for _, b := range blocks {
		out = append(out, CreatedBlock{
			BlockID: blockIDOf(b),
			Type:    blockTypeName(blockTypeOf(b)),
			Text:    blockText(b),
		})
	}
	return out
}

func mapsFromAny(v any) []map[string]any {
	items := asSlice(v)
	out := make([]map[string]any, 0, len(items))
	for _, it := range items {
		if m, ok := it.(map[string]any); ok {
			out = append(out, m)
		}
	}
	return out
}
