package feishu

import (
	"context"
	"errors"
	"net/url"
	"regexp"
	"strconv"
	"strings"
)

var (
	docxRefPattern = regexp.MustCompile(`/docx/([A-Za-z0-9]+)`)
	wikiRefPattern = regexp.MustCompile(`/wiki/([A-Za-z0-9]+)`)
	tokenPattern   = regexp.MustCompile(`^[A-Za-z0-9]+$`)
)

// DocRef 是文档定位结果。
type DocRef struct {
	DocumentID string `json:"document_id"`
	Type       string `json:"type"`
	Title      string `json:"title,omitempty"`
}

// ResolveDoc 把 wiki 链接 / wiki token / docx 文档 ID 解析成文档 ID。
func (c *Client) ResolveDoc(ctx context.Context, ref string) (*DocRef, error) {
	ref = strings.TrimSpace(ref)

	if m := docxRefPattern.FindStringSubmatch(ref); m != nil {
		return &DocRef{DocumentID: m[1], Type: "docx"}, nil
	}

	m := wikiRefPattern.FindStringSubmatch(ref)
	token := ref
	if m != nil {
		token = m[1]
	}
	if m != nil || tokenPattern.MatchString(token) {
		data, err := c.do(ctx, "GET", "/wiki/v2/spaces/get_node", nil, url.Values{"token": {token}})
		if err == nil {
			if node := asMap(data["node"]); len(node) > 0 {
				docID, _ := node["obj_token"].(string)
				objType, _ := node["obj_type"].(string)
				title, _ := node["title"].(string)
				return &DocRef{DocumentID: docID, Type: objType, Title: title}, nil
			}
		}
	}
	return &DocRef{DocumentID: token, Type: "docx"}, nil
}

func (c *Client) documentID(ctx context.Context, ref string) (*DocRef, error) {
	doc, err := c.ResolveDoc(ctx, ref)
	if err != nil {
		return nil, err
	}
	if doc.DocumentID == "" {
		return nil, errf(-1, "无法从引用中解析出文档 ID：%s", ref)
	}
	return doc, nil
}

func (c *Client) docMeta(ctx context.Context, docID string) (map[string]any, error) {
	data, err := c.do(ctx, "GET", "/docx/v1/documents/"+docID, nil, nil)
	if err != nil {
		return nil, err
	}
	return asMap(data["document"]), nil
}

// allBlocks 拉取文档全部块（自动翻页）。
func (c *Client) allBlocks(ctx context.Context, docID string) ([]map[string]any, error) {
	return c.pagedBlocks(ctx, "/docx/v1/documents/"+docID+"/blocks")
}

// childrenOf 拉取某个父块的全部直接子块（自动翻页）。
func (c *Client) childrenOf(ctx context.Context, docID, parentID string) ([]map[string]any, error) {
	return c.pagedBlocks(ctx, "/docx/v1/documents/"+docID+"/blocks/"+parentID+"/children")
}

func (c *Client) pagedBlocks(ctx context.Context, path string) ([]map[string]any, error) {
	var items []map[string]any
	pageToken := ""
	for {
		q := url.Values{"page_size": {"500"}}
		if pageToken != "" {
			q.Set("page_token", pageToken)
		}
		data, err := c.do(ctx, "GET", path, nil, q)
		if err != nil {
			return nil, err
		}
		items = append(items, mapsFromAny(data["items"])...)
		hasMore, _ := data["has_more"].(bool)
		next, _ := data["page_token"].(string)
		if !hasMore || next == "" {
			break
		}
		pageToken = next
	}
	return items, nil
}

// BlockNode 是块树的节点。
type BlockNode struct {
	BlockID string `json:"block_id" jsonschema:"稳定 ID（编辑时用它定位，不要用文字去猜）"`
	Type    string `json:"type" jsonschema:"text / heading1-9 / bullet / ordered / code / quote / todo / divider / callout / grid / table / table_cell / image ..."`
	Index   int    `json:"index" jsonschema:"在父块 children 里的下标（0 起，用于定点插入）"`
	Path    string `json:"path" jsonschema:"位置路径，如 3 或 3.1"`
	Text    string `json:"text" jsonschema:"纯文本"`

	Style    map[string]any `json:"style,omitempty" jsonschema:"块级样式（include_style 为 true 时返回）"`
	Spans    []Span         `json:"spans,omitempty" jsonschema:"逐片内联样式（include_style 为 true 时返回）"`
	Children []*BlockNode   `json:"children,omitempty" jsonschema:"子块（列表项缩进、高亮块内容、表格单元格内容都在这里）"`
}

// buildTree 把扁平的块列表还原成树。
func buildTree(items []map[string]any, includeStyle bool) ([]*BlockNode, map[string]any, error) {
	byID := make(map[string]map[string]any, len(items))
	for _, b := range items {
		byID[blockIDOf(b)] = b
	}
	var root map[string]any
	for _, b := range items {
		if blockTypeOf(b) == 1 {
			root = b
			break
		}
	}
	if root == nil {
		return nil, nil, errf(-1, "文档里找不到 page 根块，可能没有读权限")
	}

	var node func(b map[string]any, index int, path string) *BlockNode
	node = func(b map[string]any, index int, path string) *BlockNode {
		bt := blockTypeOf(b)
		n := &BlockNode{
			BlockID: blockIDOf(b),
			Type:    blockTypeName(bt),
			Index:   index,
			Path:    path,
			Text:    blockText(b),
		}
		if field, ok := textFieldByType[bt]; ok && includeStyle && editableTextTypes[bt] {
			content := asMap(b[field])
			n.Style = asMap(content["style"])
			if spans := spansFromBlock(b); len(spans) > 0 {
				n.Spans = spans
			}
		}
		var kids []*BlockNode
		for i, cid := range childrenIDsOf(b) {
			child, ok := byID[cid]
			if !ok {
				continue
			}
			kids = append(kids, node(child, i, path+"."+strconv.Itoa(i)))
		}
		n.Children = kids
		return n
	}

	var top []*BlockNode
	for i, cid := range childrenIDsOf(root) {
		child, ok := byID[cid]
		if !ok {
			continue
		}
		top = append(top, node(child, i, strconv.Itoa(i)))
	}
	if top == nil {
		// 空文档要返回 [] 而不是 null（JSON 里 null 会让调用方遍历时报错）
		top = []*BlockNode{}
	}
	return top, root, nil
}

// ReadDocumentResult 是 feishu_read_document 的返回值。
type ReadDocumentResult struct {
	DocumentID   string       `json:"document_id" jsonschema:"文档 ID"`
	Title        string       `json:"title" jsonschema:"文档标题"`
	TitleBlockID string       `json:"title_block_id" jsonschema:"文档标题块的 ID，可传给 feishu_update_block 改标题"`
	RevisionID   int          `json:"revision_id" jsonschema:"文档版本号"`
	Count        int          `json:"count" jsonschema:"正文块总数（不含根块）"`
	Blocks       []*BlockNode `json:"blocks" jsonschema:"顶层块树"`
}

// ReadDocument 读取文档标题与完整块树。
func (c *Client) ReadDocument(ctx context.Context, ref string, includeStyle bool) (*ReadDocumentResult, error) {
	doc, err := c.documentID(ctx, ref)
	if err != nil {
		return nil, err
	}
	docID := doc.DocumentID
	meta, err := c.docMeta(ctx, docID)
	if err != nil {
		return nil, err
	}
	items, err := c.allBlocks(ctx, docID)
	if err != nil {
		return nil, err
	}
	tree, root, err := buildTree(items, includeStyle)
	if err != nil {
		return nil, err
	}

	title, _ := meta["title"].(string)
	if title == "" {
		title = blockText(root)
	}
	if title == "" {
		title = doc.Title
	}
	revision, _ := toInt(meta["revision_id"])

	return &ReadDocumentResult{
		DocumentID:   docID,
		Title:        title,
		TitleBlockID: blockIDOf(root),
		RevisionID:   revision,
		Count:        len(items) - 1,
		Blocks:       tree,
	}, nil
}

// GetBlock 取单个块的原始结构。
func (c *Client) GetBlock(ctx context.Context, ref, blockID string) (map[string]any, error) {
	doc, err := c.documentID(ctx, ref)
	if err != nil {
		return nil, err
	}
	data, err := c.do(ctx, "GET", "/docx/v1/documents/"+doc.DocumentID+"/blocks/"+blockID, nil, nil)
	if err != nil {
		if isErr(err, 1770001, 1770002, 1770003) {
			return nil, errf(codeOf(err), "块 %s 不存在或已删除，请重新调用 feishu_read_document 取最新 block_id", blockID)
		}
		return nil, err
	}
	block := asMap(data["block"])
	if len(block) == 0 {
		return nil, errf(-1, "找不到块 %s", blockID)
	}
	return block, nil
}

// locate 返回 (父块 ID, 在父块 children 中的下标, 父块原始结构)。
func (c *Client) locate(ctx context.Context, docID, blockID string) (string, int, map[string]any, error) {
	blocks, err := c.allBlocks(ctx, docID)
	if err != nil {
		return "", 0, nil, err
	}
	byID := make(map[string]map[string]any, len(blocks))
	for _, b := range blocks {
		byID[blockIDOf(b)] = b
	}
	target, ok := byID[blockID]
	if !ok {
		return "", 0, nil, errf(-1, "文档里没有块 %s；请先调用 feishu_read_document 取最新 block_id", blockID)
	}
	parentID := parentIDOf(target)
	parent, ok := byID[parentID]
	if !ok {
		for _, b := range blocks {
			if blockTypeOf(b) == 1 {
				parent = b
				parentID = blockIDOf(b)
				break
			}
		}
	}
	if parent == nil {
		return "", 0, nil, errf(-1, "找不到块 %s 的父块", blockID)
	}
	children := childrenIDsOf(parent)
	for i, cid := range children {
		if cid == blockID {
			return parentID, i, parent, nil
		}
	}
	return "", 0, nil, errf(-1, "块 %s 不在父块 %s 的子块列表中（可能已被删除）", blockID, parentID)
}

func codeOf(err error) int {
	var fe *Error
	if errors.As(err, &fe) {
		return fe.Code
	}
	return -1
}
