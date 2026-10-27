package feishu

import (
	"context"
	"mime"
	"mime/multipart"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// pngBytes 返回一张最小的 1x1 PNG（内容不重要，测试只关心上传字段）。
func pngBytes(t *testing.T) []byte {
	t.Helper()
	dir := t.TempDir()
	p := filepath.Join(dir, "shot.png")
	// 用一段可辨识的假字节；上传走 multipart，不做格式校验
	if err := os.WriteFile(p, []byte("\x89PNG\r\n\x1a\nFAKE-IMAGE-BODY"), 0o600); err != nil {
		t.Fatal(err)
	}
	data, err := os.ReadFile(p)
	if err != nil {
		t.Fatal(err)
	}
	return data
}

func TestInsertImageUploadsAndCreatesBlock(t *testing.T) {
	env := &writeEnv{t: t, bodies: map[string]map[string]any{}, methods: map[string]string{},
		items: flatDoc(), docID: "doc1"}

	var uploadFields map[string]string
	var uploadFileSize int
	c := newTestClient(t, func(w http.ResponseWriter, r *http.Request) {
		switch {
		case r.URL.Path == "/drive/v1/medias/upload_all":
			mt, params, err := mime.ParseMediaType(r.Header.Get("Content-Type"))
			if err != nil || !strings.HasPrefix(mt, "multipart/") {
				t.Fatalf("上传请求不是 multipart：%v %q", err, r.Header.Get("Content-Type"))
			}
			mr := multipart.NewReader(r.Body, params["boundary"])
			uploadFields = map[string]string{}
			for {
				part, err := mr.NextPart()
				if err != nil {
					break
				}
				buf := make([]byte, 4096)
				n, _ := part.Read(buf)
				if part.FormName() == "file" {
					uploadFileSize = n
					if got := part.FileName(); got != "shot.png" {
						t.Errorf("上传文件名 = %q，期望 shot.png", got)
					}
					continue
				}
				uploadFields[part.FormName()] = string(buf[:n])
			}
			writeJSON(w, map[string]any{"code": 0, "data": map[string]any{"file_token": "boxcn-token"}})
		default:
			env.handle(w, r)
		}
	})

	dir := t.TempDir()
	src := filepath.Join(dir, "shot.png")
	if err := os.WriteFile(src, pngBytes(t), 0o600); err != nil {
		t.Fatal(err)
	}

	res, err := c.InsertImage(context.Background(), "/docx/doc1", src, -1, "", "center")
	if err != nil {
		t.Fatal(err)
	}
	if res.FileToken != "boxcn-token" {
		t.Errorf("FileToken = %q", res.FileToken)
	}
	if len(uploadFields) == 0 {
		t.Fatal("没有收到 multipart 表单字段")
	}
	want := map[string]string{
		"file_name": "shot.png", "parent_type": "docx_image",
		"parent_node": "doc1", "size": "23",
	}
	for k, v := range want {
		if uploadFields[k] != v {
			t.Errorf("表单字段 %s = %q，期望 %q", k, uploadFields[k], v)
		}
	}
	if uploadFileSize == 0 {
		t.Error("没有收到文件内容")
	}

	body := env.bodies["POST /docx/v1/documents/doc1/blocks/doc1/children"]
	if body == nil {
		t.Fatalf("没有创建 image 块，实际请求：%v", env.methods)
	}
	child := asMap(asSlice(body["children"])[0])
	if got, _ := toInt(child["block_type"]); got != 27 {
		t.Errorf("block_type = %v，期望 27（image）", child["block_type"])
	}
	img := asMap(child["image"])
	if img["token"] != "boxcn-token" {
		t.Errorf("image.token = %v，期望 boxcn-token", img["token"])
	}
	if got, _ := toInt(img["align"]); got != 2 {
		t.Errorf("image.align = %v，期望 2（center）", img["align"])
	}
}

func TestInsertImageEmptySource(t *testing.T) {
	c, _ := newWriteEnv(t, flatDoc())
	if _, err := c.InsertImage(context.Background(), "/docx/doc1", "", -1, "", ""); err == nil {
		t.Fatal("期望报错")
	}
}

func TestInsertFlowchartCreatesBoardThenRenders(t *testing.T) {
	c, env := newWriteEnv(t, flatDoc())
	code := "@startuml\nstart\n:步骤;\nstop\n@enduml"
	res, err := c.InsertFlowchart(context.Background(), "/docx/doc1", code, -1, "")
	if err != nil {
		t.Fatal(err)
	}
	if res.WhiteboardID != "wb-1" {
		t.Errorf("WhiteboardID = %q，期望 wb-1", res.WhiteboardID)
	}
	body := env.bodies["POST /docx/v1/documents/doc1/blocks/doc1/children"]
	if body == nil {
		t.Fatalf("没有创建画板块，实际请求：%v", env.methods)
	}
	child := asMap(asSlice(body["children"])[0])
	if got, _ := toInt(child["block_type"]); got != 43 {
		t.Errorf("block_type = %v，期望 43（board）", child["block_type"])
	}
	pl := env.bodies["POST /board/v1/whiteboards/wb-1/nodes/plantuml"]
	if pl == nil {
		t.Fatalf("没有调用 plantuml 渲染，实际请求：%v", env.methods)
	}
	if pl["plant_uml_code"] != code {
		t.Errorf("plant_uml_code = %v", pl["plant_uml_code"])
	}
}

func TestInsertFlowchartCleansUpOnRenderFailure(t *testing.T) {
	items := flatDoc()
	env := &writeEnv{t: t, bodies: map[string]map[string]any{}, methods: map[string]string{},
		items: items, docID: "doc1"}
	c := newTestClient(t, func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/board/v1/whiteboards/wb-1/nodes/plantuml" {
			writeJSON(w, map[string]any{"code": 2890002, "msg": "invalid arg"})
			return
		}
		env.handle(w, r)
	})

	_, err := c.InsertFlowchart(context.Background(), "/docx/doc1",
		"@startuml\nstop\n@enduml", -1, "")
	if err == nil {
		t.Fatal("渲染失败时期望报错")
	}
	if !strings.Contains(err.Error(), "渲染流程图失败") {
		t.Errorf("错误信息 = %s", err.Error())
	}
	if _, ok := env.bodies["DELETE /docx/v1/documents/doc1/blocks/doc1/children/batch_delete"]; !ok {
		t.Error("渲染失败后应删掉空画板块，实际没有发出 batch_delete")
	}
}

func TestInsertFlowchartMissingScopeHint(t *testing.T) {
	items := flatDoc()
	env := &writeEnv{t: t, bodies: map[string]map[string]any{}, methods: map[string]string{},
		items: items, docID: "doc1"}
	c := newTestClient(t, func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/board/v1/whiteboards/wb-1/nodes/plantuml" {
			writeJSON(w, map[string]any{"code": 99991672, "msg": "Access denied"})
			return
		}
		env.handle(w, r)
	})
	_, err := c.InsertFlowchart(context.Background(), "/docx/doc1", "@startuml\nstop\n@enduml", -1, "")
	if err == nil || !strings.Contains(err.Error(), "board:whiteboard:node:create") {
		t.Errorf("缺权限时应提示 scope，实际：%v", err)
	}
}

func TestBlockPayloadImageAndBoard(t *testing.T) {
	if _, err := blockPayload(BlockSpec{Type: "image"}); err == nil {
		t.Error("image 缺 token 时应报错")
	}
	p, err := blockPayload(BlockSpec{Type: "image", Token: "tk", Align: "left"})
	if err != nil {
		t.Fatal(err)
	}
	img := asMap(p["image"])
	if img["token"] != "tk" {
		t.Errorf("token = %v", img["token"])
	}
	if got, _ := toInt(img["align"]); got != 1 {
		t.Errorf("align = %v，期望 1（left）", img["align"])
	}

	p, err = blockPayload(BlockSpec{Type: "board"})
	if err != nil {
		t.Fatal(err)
	}
	if got, _ := toInt(p["block_type"]); got != 43 {
		t.Errorf("board block_type = %v，期望 43", p["block_type"])
	}
	if _, ok := p["board"]; !ok {
		t.Error("缺少 board 字段")
	}
}

func TestInlineColors(t *testing.T) {
	els := elementsFromSpec(BlockSpec{Text: "红底", TextColor: 2, BgColor: 5})
	st := asMap(asMap(asMap(els[0])["text_run"])["text_element_style"])
	if got, _ := toInt(st["text_color"]); got != 2 {
		t.Errorf("text_color = %v，期望 2", st["text_color"])
	}
	if got, _ := toInt(st["background_color"]); got != 5 {
		t.Errorf("background_color = %v，期望 5", st["background_color"])
	}

	// spans 里的颜色同样生效，且能被读回
	els = elementsFromSpec(BlockSpec{Spans: []Span{{Text: "A", BgColor: 3}}})
	if got, _ := toInt(asMap(asMap(asMap(els[0])["text_run"])["text_element_style"])["background_color"]); got != 3 {
		t.Errorf("span background_color = %v，期望 3", got)
	}

	block := map[string]any{
		"block_id": "b1", "block_type": 2.0,
		"text": map[string]any{"elements": []any{
			map[string]any{"text_run": map[string]any{
				"content": "高亮",
				"text_element_style": map[string]any{
					"text_color": 2.0, "background_color": 5.0,
				},
			}},
		}},
	}
	spans := spansFromBlock(block)
	if len(spans) != 1 || spans[0].TextColor != 2 || spans[0].BgColor != 5 {
		t.Errorf("读回的 spans = %+v", spans)
	}
}
