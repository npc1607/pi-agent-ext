package feishu

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"strings"
	"testing"
)

// writeEnv 是假文档服务：既记录请求，又能回答块读取。
type writeEnv struct {
	t       *testing.T
	bodies  map[string]map[string]any // path -> 最后一次请求体
	methods map[string]string
	items   []map[string]any // GET /blocks 返回的块
	docID   string
	// patchBodies 记录每次 batch_update 的请求体（用于验证“不能一次改两类”的拆分）
	patchBodies []map[string]any
}

func newWriteEnv(t *testing.T, items []map[string]any) (*Client, *writeEnv) {
	t.Helper()
	env := &writeEnv{
		t:       t,
		bodies:  map[string]map[string]any{},
		methods: map[string]string{},
		items:   items,
		docID:   "doc1",
	}
	c := newTestClient(t, env.handle)
	return c, env
}

func (e *writeEnv) readBody(r *http.Request) map[string]any {
	e.t.Helper()
	raw, err := io.ReadAll(r.Body)
	if err != nil {
		e.t.Fatalf("读取请求体失败：%v", err)
	}
	// 用路径的最后两段做键，避开 block_id 差异带来的干扰
	key := r.Method + " " + r.URL.Path
	e.methods[key] = r.Method
	if len(raw) == 0 {
		e.bodies[key] = nil
		return nil
	}
	var body map[string]any
	if err := json.Unmarshal(raw, &body); err != nil {
		e.t.Fatalf("%s 请求体不是合法 JSON：%v\n%s", r.URL.Path, err, raw)
	}
	e.bodies[key] = body
	if r.Method == http.MethodPatch && hasSuffix(r.URL.Path, "/blocks/batch_update") {
		e.patchBodies = append(e.patchBodies, body)
	}
	return body
}

func (e *writeEnv) handle(w http.ResponseWriter, r *http.Request) {
	e.t.Helper()
	doc := "/docx/v1/documents/" + e.docID
	switch {
	case hasSuffix(r.URL.Path, "/nodes/plantuml"):
		e.readBody(r)
		writeJSON(w, map[string]any{"code": 0, "data": map[string]any{}})

	case r.URL.Path == doc:
		writeJSON(w, map[string]any{"code": 0, "data": map[string]any{
			"document": map[string]any{"title": "标题", "revision_id": 3},
		}})

	case r.URL.Path == doc+"/blocks":
		writeJSON(w, map[string]any{"code": 0, "data": map[string]any{
			"has_more": false, "items": toAnySlice(e.items),
		}})

	case r.URL.Path == doc+"/blocks/batch_update":
		e.readBody(r)
		// 回显 requests 里提到的 block_id
		var blocks []any
		if body := e.bodies["PATCH "+r.URL.Path]; body != nil {
			for _, req := range asSlice(body["requests"]) {
				id, _ := asMap(req)["block_id"].(string)
				blocks = append(blocks, map[string]any{
					"block_id": id, "block_type": 2.0,
					"text": map[string]any{"elements": []any{
						map[string]any{"text_run": map[string]any{"content": "改后"}},
					}},
				})
			}
		}
		writeJSON(w, map[string]any{"code": 0, "data": map[string]any{"blocks": blocks}})

	case len(r.URL.Path) > len(doc+"/blocks/") && hasSuffix(r.URL.Path, "/children/batch_delete"):
		e.readBody(r)
		writeJSON(w, map[string]any{"code": 0, "data": map[string]any{}})

	case len(r.URL.Path) > len(doc+"/blocks/") && hasSuffix(r.URL.Path, "/children") && r.Method == http.MethodGet:
		// 列子块：InsertBlocks 用它做 index 越界检查
		parent := trimSuffixPath(r.URL.Path, "/children")
		parent = parent[len("/docx/v1/documents/doc1/blocks/"):]
		var kids []any
		for _, b := range e.items {
			if parentIDOf(b) == parent {
				kids = append(kids, b)
			}
		}
		writeJSON(w, map[string]any{"code": 0, "data": map[string]any{
			"has_more": false, "items": kids,
		}})

	case len(r.URL.Path) > len(doc+"/blocks/") && hasSuffix(r.URL.Path, "/children"):
		e.readBody(r)
		parent := strings.TrimPrefix(trimSuffixPath(r.URL.Path, "/children"), doc+"/blocks/")
		created := map[string]any{
			"block_id": "new-1", "block_type": 2.0, "parent_id": parent,
			"text": map[string]any{"elements": []any{
				map[string]any{"text_run": map[string]any{"content": "新块"}},
			}},
		}
		// 画板块：真实接口会返回 board.token，流程图测试依赖它
		if kind := boardKindInBody(e.bodies["POST "+r.URL.Path]); kind {
			created = map[string]any{
				"block_id": "new-1", "block_type": 43.0, "parent_id": parent,
				"board": map[string]any{"token": "wb-1"},
			}
		}
		e.items = append(e.items, created)
		// 挂到父块的 children 上，否则后续 locate 找不到
		for _, b := range e.items {
			if blockIDOf(b) == parent {
				b["children"] = append(asSlice(b["children"]), "new-1")
			}
		}
		writeJSON(w, map[string]any{"code": 0, "data": map[string]any{
			"children": []any{created},
		}})

	case len(r.URL.Path) > len(doc+"/blocks/") && hasSuffix(r.URL.Path, "/descendant"):
		body := e.readBody(r)
		var relations []any
		var children []any
		for _, tmp := range asSlice(body["children_id"]) {
			name, _ := tmp.(string)
			real := "real-" + name
			relations = append(relations, map[string]any{
				"temporary_block_id": name, "block_id": real,
			})
			children = append(children, map[string]any{
				"block_id": real, "block_type": 19.0,
			})
		}
		writeJSON(w, map[string]any{"code": 0, "data": map[string]any{
			"children": children, "block_id_relations": relations,
		}})

	case strings.HasPrefix(r.URL.Path, doc+"/blocks/"):
		// GET 单个块
		id := r.URL.Path[len(doc+"/blocks/"):]
		for _, b := range e.items {
			if blockIDOf(b) == id {
				writeJSON(w, map[string]any{"code": 0, "data": map[string]any{"block": b}})
				return
			}
		}
		writeJSON(w, map[string]any{"code": 1770001, "msg": "block not found"})

	default:
		e.t.Errorf("未预期的路径：%s %s", r.Method, r.URL.Path)
		writeJSON(w, map[string]any{"code": 0, "data": map[string]any{}})
	}
}

func hasSuffix(s, suffix string) bool {
	return len(s) >= len(suffix) && s[len(s)-len(suffix):] == suffix
}

func trimSuffixPath(s, suffix string) string { return s[:len(s)-len(suffix)] }

func toAnySlice(in []map[string]any) []any {
	out := make([]any, len(in))
	for i, v := range in {
		out[i] = v
	}
	return out
}

// flatDoc 是一份「page 根 + 一个 text 块」的块列表。
func flatDoc() []map[string]any {
	return []map[string]any{
		{"block_id": "doc1", "block_type": 1.0, "children": []any{"b1"}},
		{"block_id": "b1", "block_type": 2.0, "parent_id": "doc1",
			"text": map[string]any{"elements": []any{
				map[string]any{"text_run": map[string]any{
					"content":            "原始文本 ALPHA",
					"text_element_style": map[string]any{"bold": true},
				}},
			}},
		},
	}
}

// TestCreateChildrenRequest 校验 POST /children 的请求体（扁平插入路径）。
func TestCreateChildrenRequest(t *testing.T) {
	c, env := newWriteEnv(t, flatDoc())

	res, err := c.InsertBlocks(context.Background(), "/docx/doc1",
		[]BlockSpec{{Type: "text", Text: "新块"}}, 1, "")
	if err != nil {
		t.Fatal(err)
	}
	key := "POST /docx/v1/documents/doc1/blocks/doc1/children"
	body := env.bodies[key]
	if body == nil {
		t.Fatalf("没有打到 %s，实际请求：%v", key, env.methods)
	}
	if got, _ := toInt(body["index"]); got != 1 {
		t.Errorf("index = %v，期望 1", body["index"])
	}
	children := asSlice(body["children"])
	if len(children) != 1 {
		t.Fatalf("children 长度 = %d，期望 1", len(children))
	}
	child := asMap(children[0])
	if got, _ := toInt(child["block_type"]); got != 2 {
		t.Errorf("block_type = %v，期望 2", child["block_type"])
	}
	elements := asSlice(asMap(child["text"])["elements"])
	if got := asMap(asMap(elements[0])["text_run"])["content"]; got != "新块" {
		t.Errorf("content = %v，期望 新块", got)
	}
	if len(res.Created) != 1 || res.Created[0].BlockID != "new-1" {
		t.Errorf("Created = %+v", res.Created)
	}
	if res.ParentBlockID != "doc1" {
		t.Errorf("ParentBlockID = %q，期望 doc1", res.ParentBlockID)
	}
}

// TestCreateChildrenNoIndexWhenAppend 末尾追加时请求体不能带 index。
func TestCreateChildrenNoIndexWhenAppend(t *testing.T) {
	c, env := newWriteEnv(t, flatDoc())
	if _, err := c.AppendDocument(context.Background(), "/docx/doc1",
		[]BlockSpec{{Type: "text", Text: "尾"}}); err != nil {
		t.Fatal(err)
	}
	body := env.bodies["POST /docx/v1/documents/doc1/blocks/doc1/children"]
	if body == nil {
		t.Fatal("没有打到 children 接口")
	}
	if _, ok := body["index"]; ok {
		t.Errorf("append 不应带 index，实际 %v", body["index"])
	}
}

// TestCreateDescendantsRequest 校验嵌套创建：tmp_id 后序编号、父子挂载、relations 回填。
func TestCreateDescendantsRequest(t *testing.T) {
	c, env := newWriteEnv(t, flatDoc())

	blocks := []BlockSpec{{
		Type: "callout", Text: "注意", BackgroundColor: "lightyellow",
		Children: []BlockSpec{{Type: "text", Text: "子内容"}},
	}}
	res, err := c.InsertBlocks(context.Background(), "/docx/doc1", blocks, -1, "")
	if err != nil {
		t.Fatal(err)
	}

	body := env.bodies["POST /docx/v1/documents/doc1/blocks/doc1/descendant"]
	if body == nil {
		t.Fatalf("没有打到 descendant 接口，实际请求：%v", env.methods)
	}
	topIDs := asSlice(body["children_id"])
	if len(topIDs) != 1 || topIDs[0] != "tmp_1" {
		t.Errorf("children_id = %v，期望 [tmp_1]", topIDs)
	}

	descendants := asSlice(body["descendants"])
	if len(descendants) != 2 {
		t.Fatalf("descendants 长度 = %d，期望 2", len(descendants))
	}
	// 后序：先子后父
	child := asMap(descendants[0])
	parent := asMap(descendants[1])
	if child["block_id"] != "tmp_2" {
		t.Errorf("descendants[0].block_id = %v，期望 tmp_2（子块先入）", child["block_id"])
	}
	if parent["block_id"] != "tmp_1" {
		t.Errorf("descendants[1].block_id = %v，期望 tmp_1", parent["block_id"])
	}
	if got, _ := toInt(parent["block_type"]); got != 19 {
		t.Errorf("callout block_type = %v，期望 19", parent["block_type"])
	}
	kids := asSlice(parent["children"])
	if len(kids) != 1 || kids[0] != "tmp_2" {
		t.Errorf("callout children = %v，期望 [tmp_2]", kids)
	}
	if got := asMap(child["text"])["elements"]; got == nil {
		t.Error("子块缺少 text.elements")
	}
	// 高亮块背景色走 callout.background_color 数值枚举
	if got, _ := toInt(asMap(parent["callout"])["background_color"]); got != 3 {
		t.Errorf("callout.background_color = %v，期望 3（lightyellow）", asMap(parent["callout"])["background_color"])
	}

	if len(res.IDMap) != 1 || res.IDMap["tmp_1"] != "real-tmp_1" {
		t.Errorf("IDMap = %v，期望 tmp_1 -> real-tmp_1", res.IDMap)
	}
	if len(res.Created) != 1 || res.Created[0].BlockID != "real-tmp_1" {
		t.Errorf("Created = %+v", res.Created)
	}
}

// TestUpdateBlockTextRequest 校验 batch_update 的 update_text_elements 分支。
func TestUpdateBlockTextRequest(t *testing.T) {
	c, env := newWriteEnv(t, flatDoc())
	text := "原地改过 BETA"
	if _, err := c.UpdateBlock(context.Background(), "/docx/doc1", "b1",
		UpdateBlockArgs{Text: &text}); err != nil {
		t.Fatal(err)
	}
	body := env.bodies["PATCH /docx/v1/documents/doc1/blocks/batch_update"]
	if body == nil {
		t.Fatalf("没有打到 batch_update，实际请求：%v", env.methods)
	}
	reqs := asSlice(body["requests"])
	if len(reqs) != 1 {
		t.Fatalf("requests 长度 = %d，期望 1", len(reqs))
	}
	req := asMap(reqs[0])
	if req["block_id"] != "b1" {
		t.Errorf("block_id = %v，期望 b1", req["block_id"])
	}
	ute := asMap(req["update_text_elements"])
	elements := asSlice(ute["elements"])
	if len(elements) != 1 {
		t.Fatalf("elements 长度 = %d，期望 1", len(elements))
	}
	if got := asMap(asMap(elements[0])["text_run"])["content"]; got != text {
		t.Errorf("content = %v，期望 %s", got, text)
	}
	if _, ok := req["update_text_style"]; ok {
		t.Error("只改 text 时不应下发 update_text_style")
	}
}

// TestUpdateBlockStyleRequest 校验 batch_update 的 update_text_style 分支（含 fields 位）。
func TestUpdateBlockStyleRequest(t *testing.T) {
	c, env := newWriteEnv(t, flatDoc())
	done := true
	if _, err := c.UpdateBlock(context.Background(), "/docx/doc1", "b1",
		UpdateBlockArgs{BlockStyle: &BlockStyle{Done: &done, Align: "center"}}); err != nil {
		t.Fatal(err)
	}
	req := asMap(asSlice(env.bodies["PATCH /docx/v1/documents/doc1/blocks/batch_update"]["requests"])[0])
	uts := asMap(req["update_text_style"])
	style := asMap(uts["style"])
	if style["done"] != true {
		t.Errorf("style.done = %v，期望 true", style["done"])
	}
	if got, _ := toInt(style["align"]); got != 2 {
		t.Errorf("style.align = %v，期望 2（center）", style["align"])
	}
	fields := asSlice(uts["fields"])
	want := map[int]bool{1: true, 2: true}
	if len(fields) != 2 {
		t.Fatalf("fields = %v，期望含 1 与 2", fields)
	}
	for _, f := range fields {
		n, _ := toInt(f)
		if !want[n] {
			t.Errorf("意外的 fields 位 %d", n)
		}
	}
	if _, ok := req["update_text_elements"]; ok {
		t.Error("只改块级样式时不应下发 update_text_elements")
	}
}

// TestPatchBlockKeepsInlineStyle 校验段内替换后其余 run 的内联样式仍然保留。
func TestPatchBlockKeepsInlineStyle(t *testing.T) {
	c, env := newWriteEnv(t, flatDoc())
	res, err := c.PatchBlock(context.Background(), "/docx/doc1", "b1", "ALPHA", "ALPHA!", false)
	if err != nil {
		t.Fatal(err)
	}
	if res.Replaced != 1 {
		t.Errorf("Replaced = %d，期望 1", res.Replaced)
	}
	req := asMap(asSlice(env.bodies["PATCH /docx/v1/documents/doc1/blocks/batch_update"]["requests"])[0])
	elements := asSlice(asMap(req["update_text_elements"])["elements"])
	if len(elements) != 1 {
		t.Fatalf("elements 长度 = %d，期望 1（不新建 run）", len(elements))
	}
	tr := asMap(asMap(elements[0])["text_run"])
	if got := tr["content"]; got != "原始文本 ALPHA!" {
		t.Errorf("content = %v，期望 原始文本 ALPHA!", got)
	}
	if asMap(tr["text_element_style"])["bold"] != true {
		t.Error("替换后 text_element_style 丢失")
	}
}

// TestPatchBlockMissDoesNotWrite 没找到时不发写请求。
func TestPatchBlockMissDoesNotWrite(t *testing.T) {
	c, env := newWriteEnv(t, flatDoc())
	res, err := c.PatchBlock(context.Background(), "/docx/doc1", "b1", "不存在", "x", false)
	if err != nil {
		t.Fatal(err)
	}
	if res.Replaced != 0 || res.Note == "" {
		t.Errorf("结果 = %+v", res)
	}
	if _, ok := env.methods["PATCH /docx/v1/documents/doc1/blocks/batch_update"]; ok {
		t.Error("没找到匹配时不应发出 batch_update")
	}
}

// TestDeleteBlockRequest 校验按「父块 + 下标」删除。
func TestDeleteBlockRequest(t *testing.T) {
	items := append(flatDoc(), map[string]any{
		"block_id": "b2", "block_type": 2.0, "parent_id": "doc1",
		"text": map[string]any{"elements": []any{
			map[string]any{"text_run": map[string]any{"content": "二"}},
		}},
	})
	asMap(items[0])["children"] = []any{"b1", "b2"}
	c, env := newWriteEnv(t, items)

	res, err := c.DeleteBlock(context.Background(), "/docx/doc1", "b2")
	if err != nil {
		t.Fatal(err)
	}
	body := env.bodies["DELETE /docx/v1/documents/doc1/blocks/doc1/children/batch_delete"]
	if body == nil {
		t.Fatalf("没有打到 batch_delete，实际请求：%v", env.methods)
	}
	if got, _ := toInt(body["start_index"]); got != 1 {
		t.Errorf("start_index = %v，期望 1", body["start_index"])
	}
	if got, _ := toInt(body["end_index"]); got != 2 {
		t.Errorf("end_index = %v，期望 2", body["end_index"])
	}
	if res.Deleted != "b2" || res.ParentBlockID != "doc1" {
		t.Errorf("结果 = %+v", res)
	}
}

// TestDeleteBlockRejectsUnknownID 目标块不在父块 children 里时必须报错，不能盲删。
func TestDeleteBlockRejectsUnknownID(t *testing.T) {
	items := flatDoc()
	asMap(items[0])["children"] = []any{} // b1 存在但没挂在 root 下
	c, _ := newWriteEnv(t, items)
	if _, err := c.DeleteBlock(context.Background(), "/docx/doc1", "b1"); err == nil {
		t.Fatal("期望报错")
	}
}

// TestReplaceBlockInsertsThenDeletes 校验同位置插新删旧，且删除用的是重新定位后的下标。
func TestReplaceBlockInsertsThenDeletes(t *testing.T) {
	c, env := newWriteEnv(t, flatDoc())
	res, err := c.ReplaceBlock(context.Background(), "/docx/doc1", "b1",
		[]BlockSpec{{Type: "heading2", Text: "改成标题"}})
	if err != nil {
		t.Fatal(err)
	}
	if _, ok := env.methods["POST /docx/v1/documents/doc1/blocks/doc1/children"]; !ok {
		t.Error("没有插入新块")
	}
	body := env.bodies["DELETE /docx/v1/documents/doc1/blocks/doc1/children/batch_delete"]
	if body == nil {
		t.Fatal("没有删旧块")
	}
	if res.ReplacedBlockID != "b1" || res.ParentBlockID != "doc1" {
		t.Errorf("结果 = %+v", res)
	}
	if len(res.Created) == 0 {
		t.Error("Created 不应为空")
	}
}

// TestReplaceBlockEmptyBlocksDeletes 空 blocks 等价删除，结果里带 deleted。
func TestReplaceBlockEmptyBlocksDeletes(t *testing.T) {
	c, _ := newWriteEnv(t, flatDoc())
	res, err := c.ReplaceBlock(context.Background(), "/docx/doc1", "b1", nil)
	if err != nil {
		t.Fatal(err)
	}
	if res.Deleted != "b1" {
		t.Errorf("Deleted = %q，期望 b1", res.Deleted)
	}
}

// TestEditDocumentDryRunDoesNotWrite 校验 dry_run 不产生任何写请求。
func TestEditDocumentDryRunDoesNotWrite(t *testing.T) {
	c, env := newWriteEnv(t, flatDoc())
	text := "dry 不应写"
	res, err := c.EditDocument(context.Background(), "/docx/doc1", []Operation{
		{Op: "update", BlockID: "b1", Text: &text},
		{Op: "insert", Blocks: []BlockSpec{{Type: "text", Text: "x"}}},
	}, true)
	if err != nil {
		t.Fatal(err)
	}
	if !res.DryRun || res.Applied != 2 {
		t.Errorf("结果 = %+v", res)
	}
	for key := range env.methods {
		if key != "GET /docx/v1/documents/doc1/blocks" &&
			key != "GET /docx/v1/documents/doc1/blocks/b1" {
			t.Errorf("dry_run 下不应发出 %s", key)
		}
	}
}

// TestUpdateBlockSplitsTextAndStyle 回归：同一个块不能在一次 batch_update 里同时改文本和样式
// （飞书返回 1770001 invalid param），必须拆成两次请求。
func TestUpdateBlockSplitsTextAndStyle(t *testing.T) {
	c, env := newWriteEnv(t, flatDoc())
	text := "文字加居中"
	if _, err := c.UpdateBlock(context.Background(), "/docx/doc1", "b1", UpdateBlockArgs{
		Text:       &text,
		BlockStyle: &BlockStyle{Align: "center"},
	}); err != nil {
		t.Fatal(err)
	}

	if len(env.patchBodies) != 2 {
		t.Fatalf("batch_update 请求次数 = %d，期望 2（文本与样式必须分开下发）", len(env.patchBodies))
	}
	for i, body := range env.patchBodies {
		reqs := asSlice(body["requests"])
		if len(reqs) != 1 {
			t.Fatalf("第 %d 次请求的 requests 长度 = %d，期望 1", i+1, len(reqs))
		}
		req := asMap(reqs[0])
		_, hasEl := req["update_text_elements"]
		_, hasStyle := req["update_text_style"]
		if hasEl && hasStyle {
			t.Errorf("第 %d 次请求同时带了 update_text_elements 与 update_text_style", i+1)
		}
	}
	if _, ok := asMap(asSlice(env.patchBodies[0]["requests"])[0])["update_text_elements"]; !ok {
		t.Error("第一次请求应该是 update_text_elements")
	}
	if _, ok := asMap(asSlice(env.patchBodies[1]["requests"])[0])["update_text_style"]; !ok {
		t.Error("第二次请求应该是 update_text_style")
	}
}

// TestUpdateBlockFoldedOnPlainTextHints 块类型不支持该样式时，错误里要带可操作提示。
func TestUpdateBlockFoldedOnPlainTextHints(t *testing.T) {
	c := newTestClient(t, func(w http.ResponseWriter, r *http.Request) {
		switch {
		case hasSuffix(r.URL.Path, "/blocks/b1"):
			writeJSON(w, map[string]any{"code": 0, "data": map[string]any{"block": map[string]any{
				"block_id": "b1", "block_type": 2.0,
			}}})
		case hasSuffix(r.URL.Path, "/blocks/batch_update"):
			writeJSON(w, map[string]any{"code": 1770024, "msg": "invalid operation"})
		default:
			writeJSON(w, map[string]any{"code": 0, "data": map[string]any{}})
		}
	})
	folded := true
	_, err := c.UpdateBlock(context.Background(), "/docx/doc1", "b1",
		UpdateBlockArgs{BlockStyle: &BlockStyle{Folded: &folded}})
	if err == nil {
		t.Fatal("期望报错")
	}
	msg := err.Error()
	for _, want := range []string{"1770024", "folded 只对标题", "text"} {
		if !strings.Contains(msg, want) {
			t.Errorf("错误信息缺少 %q：%s", want, msg)
		}
	}
}

// boardKindInBody 判断创建请求里是否是画板块。
func boardKindInBody(body map[string]any) bool {
	for _, c := range asSlice(body["children"]) {
		if n, _ := toInt(asMap(c)["block_type"]); n == 43 {
			return true
		}
	}
	return false
}
