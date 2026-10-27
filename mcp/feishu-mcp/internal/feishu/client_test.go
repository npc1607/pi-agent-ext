package feishu

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"sync/atomic"
	"testing"
)

const tokenPath = "/auth/v3/tenant_access_token/internal"

func TestClientTokenWithoutDataWrapper(t *testing.T) {
	var tokenHits, apiHits int64
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case tokenPath:
			atomic.AddInt64(&tokenHits, 1)
			// 真实响应没有 data 包装
			writeJSON(w, map[string]any{
				"code": 0, "tenant_access_token": "t-1", "expire": 7200,
			})
		default:
			atomic.AddInt64(&apiHits, 1)
			if got := r.Header.Get("Authorization"); got != "Bearer t-1" {
				t.Errorf("Authorization = %q，期望 Bearer t-1", got)
			}
			writeJSON(w, map[string]any{"code": 0, "data": map[string]any{
				"block": map[string]any{
					"block_id": "b1", "block_type": 2.0,
					"text": map[string]any{"elements": []any{
						map[string]any{"text_run": map[string]any{"content": "hi"}},
					}},
				},
			}})
		}
	}))
	t.Cleanup(srv.Close)
	c := NewClient("app-id", "app-secret")
	c.baseURL = srv.URL

	for i := 0; i < 2; i++ {
		block, err := c.GetBlock(context.Background(), "/docx/doc1", "b1")
		if err != nil {
			t.Fatalf("第 %d 次 GetBlock 失败：%v", i+1, err)
		}
		if got := blockText(block); got != "hi" {
			t.Errorf("block 文本 = %q，期望 hi", got)
		}
	}
	if tokenHits != 1 {
		t.Errorf("token 请求次数 = %d，期望 1（应复用缓存）", tokenHits)
	}
	if apiHits != 2 {
		t.Errorf("业务请求次数 = %d，期望 2", apiHits)
	}
}

func TestSendMessageBody(t *testing.T) {
	type captured struct {
		query string
		body  map[string]any
	}
	var got []captured
	c := newTestClient(t, func(w http.ResponseWriter, r *http.Request) {
		raw, _ := io.ReadAll(r.Body)
		var body map[string]any
		if err := json.Unmarshal(raw, &body); err != nil {
			t.Errorf("请求体不是 JSON：%v", err)
		}
		got = append(got, captured{query: r.URL.Query().Get("receive_id_type"), body: body})
		writeJSON(w, map[string]any{"code": 0, "data": map[string]any{"message_id": "m1"}})
	})

	if _, err := c.SendMessage(context.Background(), "chat1", "hi", "chat_id", "text"); err != nil {
		t.Fatal(err)
	}
	if _, err := c.SendMessage(context.Background(), "u1", `{"k":1}`, "open_id", "interactive"); err != nil {
		t.Fatal(err)
	}

	if len(got) != 2 {
		t.Fatalf("请求次数 = %d，期望 2", len(got))
	}
	if got[0].body["content"] != `{"text":"hi"}` {
		t.Errorf("text 模式 content = %v，期望 {\"text\":\"hi\"}", got[0].body["content"])
	}
	if got[0].body["msg_type"] != "text" || got[0].query != "chat_id" {
		t.Errorf("第一次请求 = %+v", got[0])
	}
	if got[1].body["content"] != `{"k":1}` {
		t.Errorf("非 text 模式 content 应原样透传，得到 %v", got[1].body["content"])
	}
	if got[1].body["msg_type"] != "interactive" || got[1].query != "open_id" {
		t.Errorf("第二次请求 = %+v", got[1])
	}
}

func TestSendMessageRejectsUnknownTypes(t *testing.T) {
	var hits int64
	c := newTestClient(t, func(w http.ResponseWriter, r *http.Request) {
		atomic.AddInt64(&hits, 1)
		t.Errorf("不应发请求：%s", r.URL.Path)
	})
	if _, err := c.SendMessage(context.Background(), "x", "y", "wechat", ""); err == nil {
		t.Error("非法 receive_id_type 应报错")
	}
	if _, err := c.SendMessage(context.Background(), "x", "y", "", "voice"); err == nil {
		t.Error("非法 msg_type 应报错")
	}
	if hits != 0 {
		t.Errorf("请求次数 = %d，期望 0", hits)
	}
}

func TestNonJSONResponseNotRetried(t *testing.T) {
	var hits int64
	c := newTestClient(t, func(w http.ResponseWriter, r *http.Request) {
		atomic.AddInt64(&hits, 1)
		http.Error(w, "boom", http.StatusInternalServerError)
	})
	_, err := c.GetBlock(context.Background(), "/docx/doc1", "b1")
	if err == nil {
		t.Fatal("期望报错")
	}
	var fe *Error
	if !errors.As(err, &fe) {
		t.Fatalf("错误类型不是 *Error：%T", err)
	}
	if fe.Code != 500 || fe.Status != 500 {
		t.Errorf("Code/Status = %d/%d，期望 500/500", fe.Code, fe.Status)
	}
	if hits != 1 {
		t.Errorf("请求次数 = %d，期望 1（非 JSON 响应体不重试）", hits)
	}
}

func TestGetBlockNotFoundWrapped(t *testing.T) {
	c := newTestClient(t, func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, map[string]any{"code": 1770001, "msg": "block not found"})
	})
	_, err := c.GetBlock(context.Background(), "/docx/doc1", "b1")
	want := "飞书错误 1770001：块 b1 不存在或已删除，请重新调用 feishu_read_document 取最新 block_id"
	if err == nil || err.Error() != want {
		t.Errorf("错误信息 = %v\n期望 %s", err, want)
	}
}

func TestReadDocument(t *testing.T) {
	c := newTestClient(t, func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/docx/v1/documents/doc1":
			writeJSON(w, map[string]any{"code": 0, "data": map[string]any{
				"document": map[string]any{"title": "标题", "revision_id": 7},
			}})
		case "/docx/v1/documents/doc1/blocks":
			if got := r.URL.Query().Get("page_size"); got != "500" {
				t.Errorf("page_size = %q，期望 500", got)
			}
			writeJSON(w, map[string]any{"code": 0, "data": map[string]any{
				"has_more": false,
				"items": []any{
					map[string]any{"block_id": "root", "block_type": 1.0, "children": []any{"b1", "b2"}},
					map[string]any{"block_id": "b1", "block_type": 2.0, "parent_id": "root",
						"text": map[string]any{"elements": []any{
							map[string]any{"text_run": map[string]any{"content": "一"}},
						}}},
					map[string]any{"block_id": "b2", "block_type": 2.0, "parent_id": "root",
						"text": map[string]any{"elements": []any{
							map[string]any{"text_run": map[string]any{"content": "二"}},
						}}},
				},
			}})
		default:
			t.Errorf("未预期的路径：%s", r.URL.Path)
			writeJSON(w, map[string]any{"code": 0, "data": map[string]any{}})
		}
	})

	res, err := c.ReadDocument(context.Background(), "/docx/doc1", false)
	if err != nil {
		t.Fatal(err)
	}
	if res.DocumentID != "doc1" || res.Title != "标题" || res.TitleBlockID != "root" {
		t.Errorf("结果 = %+v", res)
	}
	if res.RevisionID != 7 {
		t.Errorf("RevisionID = %d，期望 7", res.RevisionID)
	}
	if res.Count != 2 {
		t.Errorf("Count = %d，期望 2（块总数减根块）", res.Count)
	}
	if len(res.Blocks) != 2 || res.Blocks[0].Text != "一" || res.Blocks[1].Text != "二" {
		t.Errorf("Blocks = %+v", res.Blocks)
	}
}
