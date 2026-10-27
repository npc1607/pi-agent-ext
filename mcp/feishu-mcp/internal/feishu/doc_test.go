package feishu

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func docTreeItems() []map[string]any {
	return []map[string]any{
		{
			"block_id": "root", "block_type": 1.0, "children": []any{"a", "ghost", "b"},
			"page": map[string]any{"elements": []any{
				map[string]any{"text_run": map[string]any{"content": "标题"}},
			}},
		},
		{
			"block_id": "a", "block_type": 2.0, "parent_id": "root",
			"text": map[string]any{"elements": []any{
				map[string]any{"text_run": map[string]any{"content": "A"}},
			}},
		},
		{
			"block_id": "b", "block_type": 4.0, "parent_id": "root",
			"children": []any{"b1", "ghost2"},
			"heading2": map[string]any{"elements": []any{
				map[string]any{"text_run": map[string]any{"content": "B"}},
				map[string]any{"mention_user": map[string]any{"user_id": "u1"}},
				map[string]any{"equation": map[string]any{"content": "x=1"}},
			}},
		},
		{
			"block_id": "b1", "block_type": 12.0, "parent_id": "b",
			"bullet": map[string]any{
				"elements": []any{
					map[string]any{"text_run": map[string]any{
						"content": "B1",
						"text_element_style": map[string]any{
							"bold": true,
							"link": map[string]any{"url": quoteLink("https://a.com/x?y=1&z=中")},
						},
					}},
				},
				"style": map[string]any{"align": 1.0},
			},
		},
	}
}

func TestBuildTree(t *testing.T) {
	items := docTreeItems()
	tree, root, err := buildTree(items, true)
	if err != nil {
		t.Fatal(err)
	}
	if blockIDOf(root) != "root" {
		t.Errorf("root = %q，期望 root", blockIDOf(root))
	}
	if got := blockText(root); got != "标题" {
		t.Errorf("root 文本 = %q，期望 标题", got)
	}
	if len(tree) != 2 {
		t.Fatalf("顶层节点数量 = %d，期望 2", len(tree))
	}

	if tree[0].BlockID != "a" || tree[0].Path != "0" || tree[0].Index != 0 || tree[0].Text != "A" {
		t.Errorf("tree[0] = %+v，期望 a/0/0/A", tree[0])
	}

	// ghost 不在 byID 中：跳过但保留下标（固化 D8）
	if tree[1].BlockID != "b" || tree[1].Path != "2" || tree[1].Index != 2 {
		t.Errorf("tree[1] = %+v，期望 b/2/2（跳过缺失子块但保留下标）", tree[1])
	}
	if tree[1].Type != "heading2" {
		t.Errorf("tree[1].Type = %q，期望 heading2", tree[1].Type)
	}
	if want := "B@用户x=1"; tree[1].Text != want {
		t.Errorf("tree[1].Text = %q，期望 %q", tree[1].Text, want)
	}
	if len(tree[1].Children) != 1 {
		t.Fatalf("b 的子块数量 = %d，期望 1", len(tree[1].Children))
	}
	b1 := tree[1].Children[0]
	if b1.Path != "2.0" || b1.Index != 0 || b1.BlockID != "b1" || b1.Text != "B1" {
		t.Errorf("b1 = %+v，期望 b1/2.0/0/B1", b1)
	}
	if b1.Style["align"] != 1.0 && b1.Style["align"] != 1 {
		t.Errorf("b1.Style.align = %v，期望 1", b1.Style["align"])
	}
	if len(b1.Spans) != 1 || !b1.Spans[0].Bold {
		t.Fatalf("b1.Spans = %+v，期望一片加粗", b1.Spans)
	}
	if b1.Spans[0].Link != "https://a.com/x?y=1&z=中" {
		t.Errorf("b1.Spans[0].Link = %q，链接解码不对", b1.Spans[0].Link)
	}
}

func TestBuildTreeWithoutStyle(t *testing.T) {
	tree, _, err := buildTree(docTreeItems(), false)
	if err != nil {
		t.Fatal(err)
	}
	if tree[0].Style != nil || tree[0].Spans != nil {
		t.Errorf("include_style=false 时不应带样式：%+v", tree[0])
	}
	if tree[1].Children[0].Style != nil || tree[1].Children[0].Spans != nil {
		t.Errorf("include_style=false 时子块不应带样式：%+v", tree[1].Children[0])
	}
}

func TestBuildTreeNoPage(t *testing.T) {
	_, _, err := buildTree([]map[string]any{
		{"block_id": "x", "block_type": 2.0},
	}, false)
	if err == nil || err.Error() != "飞书错误 -1：文档里找不到 page 根块，可能没有读权限" {
		t.Errorf("错误信息不匹配：%v", err)
	}
}

func newTestClient(t *testing.T, handler http.HandlerFunc) *Client {
	t.Helper()
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		// 所有测试共用一份“无 data 包装”的 token 响应，专注业务路径
		if r.URL.Path == tokenPath {
			writeJSON(w, map[string]any{
				"code": 0, "tenant_access_token": "t-test", "expire": 7200,
			})
			return
		}
		handler(w, r)
	}))
	t.Cleanup(srv.Close)
	c := NewClient("app-id", "app-secret")
	c.baseURL = srv.URL
	return c
}

func writeJSON(w http.ResponseWriter, v any) {
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(v)
}

func TestResolveDoc(t *testing.T) {
	t.Run("docx 链接直接返回，不发请求", func(t *testing.T) {
		c := newTestClient(t, func(w http.ResponseWriter, r *http.Request) {
			t.Errorf("不应发请求，收到 %s", r.URL.Path)
		})
		doc, err := c.ResolveDoc(context.Background(), "https://x.feishu.cn/docx/abc123")
		if err != nil {
			t.Fatal(err)
		}
		if doc.DocumentID != "abc123" || doc.Type != "docx" {
			t.Errorf("解析结果 = %+v，期望 abc123/docx", doc)
		}
	})

	t.Run("wiki 链接", func(t *testing.T) {
		c := newTestClient(t, func(w http.ResponseWriter, r *http.Request) {
			if r.URL.Path != "/wiki/v2/spaces/get_node" {
				t.Errorf("路径 = %s", r.URL.Path)
			}
			if got := r.URL.Query().Get("token"); got != "wk123" {
				t.Errorf("token = %q，期望 wk123", got)
			}
			writeJSON(w, map[string]any{"code": 0, "data": map[string]any{"node": map[string]any{
				"obj_token": "docX", "obj_type": "docx", "title": "标题",
			}}})
		})
		doc, err := c.ResolveDoc(context.Background(), "https://x.feishu.cn/wiki/wk123")
		if err != nil {
			t.Fatal(err)
		}
		if doc.DocumentID != "docX" || doc.Type != "docx" || doc.Title != "标题" {
			t.Errorf("解析结果 = %+v", doc)
		}
	})

	t.Run("纯 token 在 wiki 失败后回退 docx", func(t *testing.T) {
		c := newTestClient(t, func(w http.ResponseWriter, r *http.Request) {
			writeJSON(w, map[string]any{"code": 123, "msg": "not found"})
		})
		doc, err := c.ResolveDoc(context.Background(), "tok123")
		if err != nil {
			t.Fatal(err)
		}
		if doc.DocumentID != "tok123" || doc.Type != "docx" {
			t.Errorf("回退结果 = %+v，期望 tok123/docx", doc)
		}
	})
}

// TestBuildTreeEmptyDocument 空文档要返回 [] 而不是 null（JSON null 会让调用方遍历时报错）。
func TestBuildTreeEmptyDocument(t *testing.T) {
	items := []map[string]any{
		{"block_id": "root", "block_type": 1.0, "children": []any{}},
	}
	tree, root, err := buildTree(items, false)
	if err != nil {
		t.Fatal(err)
	}
	if tree == nil {
		t.Fatal("空文档的 blocks 是 nil，应为空切片（序列化成 [] 而不是 null）")
	}
	if len(tree) != 0 {
		t.Errorf("blocks 长度 = %d，期望 0", len(tree))
	}
	if blockIDOf(root) != "root" {
		t.Errorf("root = %v", blockIDOf(root))
	}
	raw, err := json.Marshal(ReadDocumentResult{Blocks: tree})
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(raw), `"blocks":[]`) {
		t.Errorf("序列化结果里 blocks 不是 []：%s", raw)
	}
}
