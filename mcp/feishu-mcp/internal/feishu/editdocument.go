package feishu

import (
	"context"
	"encoding/json"
	"errors"
	"strconv"
)

// Operation 是 feishu_edit_document 里的一步编辑。
type Operation struct {
	Op     string `json:"op" jsonschema:"操作类型：update / patch / insert / append / replace / delete / delete_range"`
	Action string `json:"action,omitempty" jsonschema:"op 的别名，二选一"`

	// update / patch / replace / delete
	BlockID    string       `json:"block_id,omitempty" jsonschema:"目标块 ID（update/patch/replace/delete 必填）"`
	Text       *string      `json:"text,omitempty" jsonschema:"update：新的纯文本"`
	Spans      []Span       `json:"spans,omitempty" jsonschema:"update：分片富文本，给了就忽略 text"`
	Style      *InlineStyle `json:"style,omitempty" jsonschema:"update：整段内联样式"`
	BlockStyle *BlockStyle  `json:"block_style,omitempty" jsonschema:"update：块级样式"`

	// patch
	Find    string `json:"find,omitempty" jsonschema:"patch：要查找的原文本（精确匹配）"`
	Replace string `json:"replace,omitempty" jsonschema:"patch：替换成的新文本，空串等于删除"`
	All     bool   `json:"all,omitempty" jsonschema:"patch：替换该块内全部命中，默认只替换第一处"`

	// insert / append / replace
	Blocks        []BlockSpec `json:"blocks,omitempty" jsonschema:"insert/append/replace：块列表，格式同 feishu_insert_blocks"`
	Index         *int        `json:"index,omitempty" jsonschema:"insert：插入位置下标，省略或 -1 表示末尾"`
	ParentBlockID string      `json:"parent_block_id,omitempty" jsonschema:"insert / delete_range：父块 ID，省略表示文档顶层"`

	// delete_range
	StartIndex *int `json:"start_index,omitempty" jsonschema:"delete_range：起始下标（含）"`
	EndIndex   *int `json:"end_index,omitempty" jsonschema:"delete_range：结束下标（不含）"`
}

// EditDocumentResult 是批量编辑的结果。
type EditDocumentResult struct {
	DocumentID string           `json:"document_id"`
	DryRun     bool             `json:"dry_run"`
	Applied    int              `json:"applied" jsonschema:"成功执行的步数"`
	Results    []map[string]any `json:"results"`
}

// EditDocument 按顺序执行一组编辑操作。
//
// 每个操作都是独立的一次 API 调用；失败会停在该步并返回已完成的部分。
// dryRun 只校验参数与 block_id 是否存在，不写入。
func (c *Client) EditDocument(ctx context.Context, ref string, ops []Operation, dryRun bool) (*EditDocumentResult, error) {
	doc, err := c.documentID(ctx, ref)
	if err != nil {
		return nil, err
	}
	docID := doc.DocumentID
	results := make([]map[string]any, 0, len(ops))

	fail := func(i int, kind string, inner *Error) error {
		if inner == nil {
			return errf(-1, "第 %d 个操作（%s）失败。已成功 %d 步", i, kindOrQ(kind), len(results))
		}
		return &Error{
			Code:   inner.Code,
			Msg:    "第 " + strconv.Itoa(i) + " 个操作（" + kindOrQ(kind) + "）失败：" + inner.Msg + "。已成功 " + strconv.Itoa(len(results)) + " 步",
			Status: inner.Status,
			Path:   inner.Path,
		}
	}
	missing := func(i int, kind, param string) error {
		return errf(-1, "第 %d 个操作（%s）缺少参数 %q。已成功 %d 步", i, kindOrQ(kind), param, len(results))
	}

	for i, op := range ops {
		kind := kindOf(op)
		var stepErr error

		switch kind {
		case "update":
			if op.BlockID == "" {
				return nil, missing(i, kind, "block_id")
			}
			if dryRun {
				if _, err := c.GetBlock(ctx, ref, op.BlockID); err != nil {
					stepErr = err
					break
				}
				results = append(results, map[string]any{"op": "update", "block_id": op.BlockID, "dry_run": true})
				break
			}
			res, err := c.UpdateBlock(ctx, ref, op.BlockID, UpdateBlockArgs{
				Text: op.Text, Spans: op.Spans, Style: op.Style, BlockStyle: op.BlockStyle,
			})
			if err != nil {
				stepErr = err
				break
			}
			results = append(results, mergeOp("update", res))

		case "patch":
			if op.BlockID == "" {
				return nil, missing(i, kind, "block_id")
			}
			if op.Find == "" {
				return nil, missing(i, kind, "find")
			}
			if dryRun {
				if _, err := c.GetBlock(ctx, ref, op.BlockID); err != nil {
					stepErr = err
					break
				}
				results = append(results, map[string]any{"op": "patch", "block_id": op.BlockID, "dry_run": true})
				break
			}
			res, err := c.PatchBlock(ctx, ref, op.BlockID, op.Find, op.Replace, op.All)
			if err != nil {
				stepErr = err
				break
			}
			results = append(results, mergeOp("patch", res))

		case "insert":
			index := -1
			if op.Index != nil {
				index = *op.Index
			}
			if dryRun {
				if err := validateSpecs(op.Blocks); err != nil {
					stepErr = err
					break
				}
				results = append(results, map[string]any{"op": "insert", "index": index, "dry_run": true})
				break
			}
			res, err := c.InsertBlocks(ctx, ref, op.Blocks, index, op.ParentBlockID)
			if err != nil {
				stepErr = err
				break
			}
			results = append(results, mergeOp("insert", res))

		case "append":
			if dryRun {
				results = append(results, map[string]any{"op": "append", "dry_run": true})
				break
			}
			res, err := c.AppendDocument(ctx, ref, op.Blocks)
			if err != nil {
				stepErr = err
				break
			}
			results = append(results, mergeOp("append", res))

		case "delete":
			if op.BlockID == "" {
				return nil, missing(i, kind, "block_id")
			}
			if dryRun {
				if _, _, _, err := c.locate(ctx, docID, op.BlockID); err != nil {
					stepErr = err
					break
				}
				results = append(results, map[string]any{"op": "delete", "block_id": op.BlockID, "dry_run": true})
				break
			}
			res, err := c.DeleteBlock(ctx, ref, op.BlockID)
			if err != nil {
				stepErr = err
				break
			}
			results = append(results, mergeOp("delete", res))

		case "delete_range":
			if op.StartIndex == nil {
				return nil, missing(i, kind, "start_index")
			}
			if op.EndIndex == nil {
				return nil, missing(i, kind, "end_index")
			}
			if dryRun {
				results = append(results, map[string]any{"op": "delete_range", "dry_run": true})
				break
			}
			res, err := c.DeleteRange(ctx, ref, *op.StartIndex, *op.EndIndex, op.ParentBlockID)
			if err != nil {
				stepErr = err
				break
			}
			results = append(results, mergeOp("delete_range", res))

		case "replace":
			if op.BlockID == "" {
				return nil, missing(i, kind, "block_id")
			}
			if dryRun {
				if _, _, _, err := c.locate(ctx, docID, op.BlockID); err != nil {
					stepErr = err
					break
				}
				if err := validateSpecs(op.Blocks); err != nil {
					stepErr = err
					break
				}
				results = append(results, map[string]any{"op": "replace", "block_id": op.BlockID, "dry_run": true})
				break
			}
			res, err := c.ReplaceBlock(ctx, ref, op.BlockID, op.Blocks)
			if err != nil {
				stepErr = err
				break
			}
			results = append(results, mergeOp("replace", res))

		default:
			return nil, errf(-1, "未知操作：%q（可用 update/patch/insert/append/delete/delete_range/replace）", kind)
		}

		if stepErr != nil {
			var fe *Error
			errors.As(stepErr, &fe)
			return nil, fail(i, kind, fe)
		}
	}

	return &EditDocumentResult{
		DocumentID: docID,
		DryRun:     dryRun,
		Applied:    len(results),
		Results:    results,
	}, nil
}

func kindOf(op Operation) string {
	k := op.Op
	if k == "" {
		k = op.Action
	}
	return trimSpace(lower(k))
}

func kindOrQ(kind string) string {
	if kind == "" {
		return "?"
	}
	return kind
}

// validateSpecs 在 dry_run 下预检块定义是否合法。
func validateSpecs(blocks []BlockSpec) error {
	for _, b := range blocks {
		n, err := NormalizeSpec(b)
		if err != nil {
			return err
		}
		if _, err := blockPayload(n); err != nil {
			return err
		}
	}
	return nil
}

// mergeOp 把 "op" 键合并进结果对象。
func mergeOp(op string, v any) map[string]any {
	m := toMap(v)
	m["op"] = op
	return m
}

func toMap(v any) map[string]any {
	raw, err := json.Marshal(v)
	if err != nil {
		return map[string]any{}
	}
	var m map[string]any
	if json.Unmarshal(raw, &m) != nil {
		return map[string]any{}
	}
	return m
}
