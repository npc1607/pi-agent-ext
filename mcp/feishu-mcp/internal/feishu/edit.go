package feishu

import (
	"context"
	"encoding/json"
	"net/http"
	"strconv"
)

// ---------------------------------------------------------------------------
// 创建
// ---------------------------------------------------------------------------

// InsertBlocksResult 是插入块的结果。
type InsertBlocksResult struct {
	DocumentID    string            `json:"document_id"`
	ParentBlockID string            `json:"parent_block_id"`
	Created       []CreatedBlock    `json:"created"`
	IDMap         map[string]string `json:"id_map,omitempty" jsonschema:"临时 ID -> 真实 block_id（只在嵌套创建时返回）"`
}

// InsertBlocks 在指定位置插入一批块（默认文档末尾）。
func (c *Client) InsertBlocks(ctx context.Context, ref string, blocks []BlockSpec, index int, parentBlockID string) (*InsertBlocksResult, error) {
	doc, err := c.documentID(ctx, ref)
	if err != nil {
		return nil, err
	}
	docID := doc.DocumentID
	parentID := parentBlockID
	if parentID == "" {
		parentID = docID
	} else if _, err := c.GetBlock(ctx, ref, parentID); err != nil {
		return nil, err
	}

	if index >= 0 {
		existing, err := c.childrenOf(ctx, docID, parentID)
		if err != nil {
			return nil, err
		}
		if index > len(existing) {
			return nil, errf(-1, "index 越界：父块 %s 现有 %d 个子块，index 只能是 0..%d（-1 表示末尾）",
				parentID, len(existing), len(existing))
		}
	}

	specs := make([]BlockSpec, len(blocks))
	hasNested := false
	for i, b := range blocks {
		n, err := NormalizeSpec(b)
		if err != nil {
			return nil, err
		}
		specs[i] = n
		if len(n.Children) > 0 {
			hasNested = true
		}
	}

	if hasNested {
		created, relations, err := c.createDescendants(ctx, docID, parentID, specs, index)
		if err != nil {
			return nil, err
		}
		return &InsertBlocksResult{
			DocumentID:    docID,
			ParentBlockID: parentID,
			Created:       renderCreated(created),
			IDMap:         relations,
		}, nil
	}

	payloads := make([]map[string]any, len(specs))
	for i, s := range specs {
		p, err := blockPayload(s)
		if err != nil {
			return nil, err
		}
		payloads[i] = p
	}
	created, err := c.createChildren(ctx, docID, parentID, payloads, index)
	if err != nil {
		return nil, err
	}
	return &InsertBlocksResult{
		DocumentID:    docID,
		ParentBlockID: parentID,
		Created:       renderCreated(created),
	}, nil
}

// AppendDocument 向文档末尾追加块（等价 InsertBlocks(index=-1)）。
func (c *Client) AppendDocument(ctx context.Context, ref string, blocks []BlockSpec) (*InsertBlocksResult, error) {
	return c.InsertBlocks(ctx, ref, blocks, -1, "")
}

// createChildren 在 parent 下创建同级块；index<0 表示追加到末尾。
func (c *Client) createChildren(ctx context.Context, docID, parentID string, blocks []map[string]any, index int) ([]map[string]any, error) {
	if len(blocks) == 0 {
		return nil, nil
	}
	body := map[string]any{"children": blocks}
	if index >= 0 {
		body["index"] = index
	}
	data, err := c.do(ctx, http.MethodPost, "/docx/v1/documents/"+docID+"/blocks/"+parentID+"/children", body, nil)
	if err != nil {
		return nil, err
	}
	return mapsFromAny(data["children"]), nil
}

// createDescendants 一次创建带层级结构的块树（高亮块/分栏/表格必须走这里）。
func (c *Client) createDescendants(ctx context.Context, docID, parentID string, specs []BlockSpec, index int) ([]map[string]any, map[string]string, error) {
	var topIDs []string
	var descendants []map[string]any
	counter := 0

	var walk func(spec BlockSpec) (string, error)
	walk = func(spec BlockSpec) (string, error) {
		counter++
		tmp := "tmp_" + strconv.Itoa(counter)
		payload, err := blockPayload(spec)
		if err != nil {
			return "", err
		}
		payload["block_id"] = tmp
		if len(spec.Children) > 0 {
			childIDs := make([]string, 0, len(spec.Children))
			for _, ch := range spec.Children {
				cid, err := walk(ch)
				if err != nil {
					return "", err
				}
				childIDs = append(childIDs, cid)
			}
			payload["children"] = childIDs
		}
		descendants = append(descendants, payload)
		return tmp, nil
	}

	for _, spec := range specs {
		id, err := walk(spec)
		if err != nil {
			return nil, nil, err
		}
		topIDs = append(topIDs, id)
	}

	body := map[string]any{"children_id": topIDs, "descendants": descendants}
	if index >= 0 {
		body["index"] = index
	}
	data, err := c.do(ctx, http.MethodPost, "/docx/v1/documents/"+docID+"/blocks/"+parentID+"/descendant", body, nil)
	if err != nil {
		return nil, nil, err
	}

	relations := map[string]string{}
	for _, r := range mapsFromAny(data["block_id_relations"]) {
		tmp, _ := r["temporary_block_id"].(string)
		real, _ := r["block_id"].(string)
		if tmp != "" {
			relations[tmp] = real
		}
	}
	created := mapsFromAny(data["children"])
	// 附上临时 ID 映射，方便调用方对应
	topSet := map[string]bool{}
	for _, id := range topIDs {
		topSet[id] = true
	}
	for _, cb := range created {
		for tmp, real := range relations {
			if blockIDOf(cb) == real && topSet[tmp] {
				cb["temporary_block_id"] = tmp
			}
		}
	}
	return created, relations, nil
}

// ---------------------------------------------------------------------------
// 原地修改
// ---------------------------------------------------------------------------

// UpdatedBlock 是修改成功后返回的块摘要。
type UpdatedBlock struct {
	BlockID string `json:"block_id"`
	Type    string `json:"type,omitempty"`
	Text    string `json:"text,omitempty"`
}

// UpdateBlockArgs 是原地修改一个块的入参。
type UpdateBlockArgs struct {
	Text       *string      `json:"text,omitempty"`
	Spans      []Span       `json:"spans,omitempty"`
	Style      *InlineStyle `json:"style,omitempty"`
	BlockStyle *BlockStyle  `json:"block_style,omitempty"`
}

// UpdateBlockResult 是原地修改的结果。
type UpdateBlockResult struct {
	DocumentID string       `json:"document_id"`
	Updated    UpdatedBlock `json:"updated"`
}

// UpdateBlock 原地修改已有块：block_id 和文档位置都不变。
func (c *Client) UpdateBlock(ctx context.Context, ref, blockID string, args UpdateBlockArgs) (*UpdateBlockResult, error) {
	doc, err := c.documentID(ctx, ref)
	if err != nil {
		return nil, err
	}
	docID := doc.DocumentID
	block, err := c.GetBlock(ctx, ref, blockID)
	if err != nil {
		return nil, err
	}
	bt := blockTypeOf(block)
	if !editableTextTypes[bt] {
		return nil, errf(-1, "块 %s 是 %s 类型，不含可改的富文本。改它的子块（table_cell/callout 里的 text 块），或删掉重建",
			blockID, blockTypeName(bt))
	}

	// 飞书的 batch_update 不允许同一个块的一次请求里同时带 update_text_elements
	// 与 update_text_style（会返回 1770001 invalid param；同一个 block_id 在一次
	// requests 里出现两次也不行）。所以拆成多次独立请求顺序下发。
	var reqs []map[string]any
	if args.Spans != nil || args.Text != nil {
		spec := BlockSpec{Spans: args.Spans, Style: args.Style}
		if args.Text != nil {
			spec.Text = *args.Text
		}
		reqs = append(reqs, map[string]any{
			"block_id":             blockID,
			"update_text_elements": map[string]any{"elements": elementsFromSpec(spec)},
		})
	}
	if args.BlockStyle != nil {
		style, fields, err := buildBlockStyle(args.BlockStyle)
		if err != nil {
			return nil, err
		}
		if len(fields) > 0 {
			reqs = append(reqs, map[string]any{
				"block_id":          blockID,
				"update_text_style": map[string]any{"style": style, "fields": fields},
			})
		}
	}
	if len(reqs) == 0 {
		return nil, errf(-1, "没有要更新的内容：至少给 text / spans / block_style 之一")
	}

	var updated []map[string]any
	for i, req := range reqs {
		data, err := c.do(ctx, http.MethodPatch, "/docx/v1/documents/"+docID+"/blocks/batch_update",
			map[string]any{"requests": []any{req}}, nil)
		if err != nil {
			return nil, annotateUpdateError(err, blockID, blockTypeName(bt), i, len(reqs))
		}
		updated = mapsFromAny(data["blocks"])
	}
	return &UpdateBlockResult{
		DocumentID: docID,
		Updated:    firstUpdated(updated, blockID),
	}, nil
}

// annotateUpdateError 给块级样式相关的飞书错误补一句可操作提示。
func annotateUpdateError(err error, blockID, typeName string, step, total int) error {
	fe, ok := err.(*Error)
	if !ok {
		return err
	}
	note := ""
	if total > 1 && step > 0 {
		// 分两步下发时，第二步失败意味着内容已改、样式未生效
		note = "（文本已改完、样式未生效；重跑一次仅传 block_style 即可补上）"
	}
	switch fe.Code {
	case 1770024:
		note += "（该块类型不支持所请求的块级样式：folded 只对标题/可折叠块有效，done 只对 todo 有效）"
	case 1770001:
		note += "（块级样式取值不合法，请检查 align/language/sequence 等字段）"
	}
	if note == "" {
		return err
	}
	return &Error{
		Code:   fe.Code,
		Msg:    "块 " + blockID + "（" + typeName + "）更新失败：" + fe.Msg + note,
		Status: fe.Status,
		Path:   fe.Path,
	}
}

// PatchBlockResult 是段内查找替换的结果。
type PatchBlockResult struct {
	DocumentID string       `json:"document_id"`
	Updated    UpdatedBlock `json:"updated"`
	Replaced   int          `json:"replaced" jsonschema:"实际替换次数；0 表示没找到，文档未改动"`
	Note       string       `json:"note,omitempty"`
}

// PatchBlock 在块内做查找替换，保留该块其余文字的内联样式。
func (c *Client) PatchBlock(ctx context.Context, ref, blockID, find, replace string, all bool) (*PatchBlockResult, error) {
	if find == "" {
		return nil, errf(-1, "find 不能为空")
	}
	doc, err := c.documentID(ctx, ref)
	if err != nil {
		return nil, err
	}
	docID := doc.DocumentID
	block, err := c.GetBlock(ctx, ref, blockID)
	if err != nil {
		return nil, err
	}
	bt := blockTypeOf(block)
	if !editableTextTypes[bt] {
		return nil, errf(-1, "块 %s 不含富文本，无法做文本替换", blockID)
	}
	field := textFieldByType[bt]

	// 深拷贝 elements，避免就地改动原始响应
	var elements []map[string]any
	for _, el := range asSlice(asMap(block[field])["elements"]) {
		raw, err := json.Marshal(el)
		if err != nil {
			return nil, errf(-1, "块内容无法解析：%v", err)
		}
		var m map[string]any
		if err := json.Unmarshal(raw, &m); err != nil {
			return nil, errf(-1, "块内容无法解析：%v", err)
		}
		elements = append(elements, m)
	}

	count := replaceInElements(elements, find, replace, all)
	if count == 0 {
		return &PatchBlockResult{
			DocumentID: docID,
			Updated:    UpdatedBlock{BlockID: blockID},
			Replaced:   0,
			Note:       "块内没有找到目标文本，未做修改",
		}, nil
	}

	elems := make([]any, len(elements))
	for i, e := range elements {
		elems[i] = e
	}
	req := map[string]any{"block_id": blockID, "update_text_elements": map[string]any{"elements": elems}}
	data, err := c.do(ctx, http.MethodPatch, "/docx/v1/documents/"+docID+"/blocks/batch_update",
		map[string]any{"requests": []any{req}}, nil)
	if err != nil {
		return nil, err
	}
	return &PatchBlockResult{
		DocumentID: docID,
		Updated:    firstUpdated(mapsFromAny(data["blocks"]), blockID),
		Replaced:   count,
	}, nil
}

func firstUpdated(blocks []map[string]any, fallbackID string) UpdatedBlock {
	if len(blocks) == 0 {
		return UpdatedBlock{BlockID: fallbackID}
	}
	b := blocks[0]
	return UpdatedBlock{BlockID: blockIDOf(b), Type: blockTypeName(blockTypeOf(b)), Text: blockText(b)}
}

// ---------------------------------------------------------------------------
// 删除 / 替换
// ---------------------------------------------------------------------------

// DeleteBlockResult 是删除块的结果。
type DeleteBlockResult struct {
	DocumentID    string `json:"document_id"`
	Deleted       string `json:"deleted"`
	ParentBlockID string `json:"parent_block_id"`
}

// DeleteBlock 删除块（任意层级，按“父块 + 下标”删）。
func (c *Client) DeleteBlock(ctx context.Context, ref, blockID string) (*DeleteBlockResult, error) {
	doc, err := c.documentID(ctx, ref)
	if err != nil {
		return nil, err
	}
	docID := doc.DocumentID
	parentID, index, _, err := c.locate(ctx, docID, blockID)
	if err != nil {
		return nil, err
	}
	if err := c.deleteRange(ctx, docID, parentID, index, index+1); err != nil {
		return nil, err
	}
	return &DeleteBlockResult{DocumentID: docID, Deleted: blockID, ParentBlockID: parentID}, nil
}

// DeleteRangeResult 是区间删除的结果。
type DeleteRangeResult struct {
	DocumentID    string `json:"document_id"`
	ParentBlockID string `json:"parent_block_id"`
	DeletedRange  [2]int `json:"deleted_range" jsonschema:"被删除的区间 [start, end)"`
}

// DeleteRange 删除父块 children 的 [start, end) 区间（左闭右开）。
func (c *Client) DeleteRange(ctx context.Context, ref string, start, end int, parentBlockID string) (*DeleteRangeResult, error) {
	doc, err := c.documentID(ctx, ref)
	if err != nil {
		return nil, err
	}
	docID := doc.DocumentID
	parentID := parentBlockID
	if parentID == "" {
		parentID = docID
	}
	if end <= start {
		return nil, errf(-1, "end_index 必须大于 start_index")
	}
	if err := c.deleteRange(ctx, docID, parentID, start, end); err != nil {
		return nil, err
	}
	return &DeleteRangeResult{DocumentID: docID, ParentBlockID: parentID, DeletedRange: [2]int{start, end}}, nil
}

func (c *Client) deleteRange(ctx context.Context, docID, parentID string, start, end int) error {
	_, err := c.do(ctx, http.MethodDelete,
		"/docx/v1/documents/"+docID+"/blocks/"+parentID+"/children/batch_delete",
		map[string]any{"start_index": start, "end_index": end}, nil)
	return err
}

// ReplaceBlockResult 是换块类型的结果。
type ReplaceBlockResult struct {
	DocumentID      string         `json:"document_id"`
	ReplacedBlockID string         `json:"replaced_block_id" jsonschema:"被替换掉的旧块 ID（旧 ID 不再存在）"`
	ParentBlockID   string         `json:"parent_block_id"`
	Created         []CreatedBlock `json:"created"`
	Deleted         string         `json:"deleted,omitempty" jsonschema:"blocks 为空（等于删除）时，这里是被删掉的块 ID"`
}

// ReplaceBlock 把块替换成另一种类型/内容，位置不变（block_id 会变）。
//
// 飞书没有「改 block_type」接口，所以 text -> heading 只能：在同一位置插入新块，再删掉旧块。
func (c *Client) ReplaceBlock(ctx context.Context, ref, blockID string, blocks []BlockSpec) (*ReplaceBlockResult, error) {
	doc, err := c.documentID(ctx, ref)
	if err != nil {
		return nil, err
	}
	docID := doc.DocumentID
	parentID, index, _, err := c.locate(ctx, docID, blockID)
	if err != nil {
		return nil, err
	}
	if len(blocks) == 0 {
		res, err := c.DeleteBlock(ctx, ref, blockID)
		if err != nil {
			return nil, err
		}
		return &ReplaceBlockResult{
			DocumentID:      res.DocumentID,
			ReplacedBlockID: blockID,
			ParentBlockID:   res.ParentBlockID,
			Created:         []CreatedBlock{},
			Deleted:         res.Deleted,
		}, nil
	}

	insertParent := ""
	if parentID != docID {
		insertParent = parentID
	}
	inserted, err := c.InsertBlocks(ctx, ref, blocks, index, insertParent)
	if err != nil {
		return nil, err
	}
	if len(inserted.Created) == 0 {
		return nil, errf(-1, "替换失败：新块没有创建成功")
	}
	// 插入可能引起下标漂移，删旧块前重新定位一次，避免删错块
	parentNow, indexNow, _, err := c.locate(ctx, docID, blockID)
	if err != nil {
		return nil, err
	}
	if parentNow != parentID {
		return nil, errf(-1, "替换失败：旧块 parent 发生变化，已停止删除以免误删")
	}
	if err := c.deleteRange(ctx, docID, parentID, indexNow, indexNow+1); err != nil {
		return nil, err
	}
	return &ReplaceBlockResult{
		DocumentID:      docID,
		ReplacedBlockID: blockID,
		ParentBlockID:   parentID,
		Created:         inserted.Created,
	}, nil
}
