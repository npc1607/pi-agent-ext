package mcpserver

import (
	"context"
	"encoding/json"
	"sort"
	"strings"
	"testing"

	"feishu-mcp/internal/feishu"
	"github.com/modelcontextprotocol/go-sdk/mcp"
)

// pythonToolNames 是 Python 版（legacy/server.py）声明的 10 个工具，
// 加上 Go 版新增的 2 个（图片上传、流程图）。Python 版这 10 个必须全部保留。
var pythonToolNames = []string{
	"feishu_append_document",
	"feishu_delete_block",
	"feishu_edit_document",
	"feishu_insert_blocks",
	"feishu_insert_flowchart",
	"feishu_insert_image",
	"feishu_patch_block",
	"feishu_read_document",
	"feishu_replace_block",
	"feishu_resolve_doc",
	"feishu_send_message",
	"feishu_update_block",
}

func newTestSession(t *testing.T) *mcp.ClientSession {
	t.Helper()
	// New 内部会调用 mcp.AddTool；schema 不合法会 panic，所以这一行本身就是 B1 回归
	srv := New(feishu.NewClient("id", "secret"))

	ct, st := mcp.NewInMemoryTransports()
	ss, err := srv.Connect(context.Background(), st, nil)
	if err != nil {
		t.Fatalf("服务端连接失败：%v", err)
	}
	t.Cleanup(func() { _ = ss.Close() })

	cs, err := mcp.NewClient(&mcp.Implementation{Name: "test", Version: "0"}, nil).
		Connect(context.Background(), ct, nil)
	if err != nil {
		t.Fatalf("客户端连接失败：%v", err)
	}
	t.Cleanup(func() { _ = cs.Close() })
	return cs
}

func TestListTools(t *testing.T) {
	cs := newTestSession(t)
	res, err := cs.ListTools(context.Background(), nil)
	if err != nil {
		t.Fatal(err)
	}

	got := make([]string, 0, len(res.Tools))
	byName := map[string]*mcp.Tool{}
	for _, tool := range res.Tools {
		got = append(got, tool.Name)
		byName[tool.Name] = tool
	}
	sort.Strings(got)
	if !equalStrings(got, pythonToolNames) {
		t.Fatalf("工具列表与 Python 版不一致\n得到：%v\n期望：%v", got, pythonToolNames)
	}

	// read_document 的返回是递归树，Out=any，因此不应生成 outputSchema
	if tool := byName["feishu_read_document"]; tool.OutputSchema != nil {
		t.Errorf("feishu_read_document 不应有 outputSchema：%#v", tool.OutputSchema)
	}

	// 含 blocks 的工具必须有 $defs/block
	for _, name := range []string{
		"feishu_insert_blocks", "feishu_append_document",
		"feishu_replace_block", "feishu_edit_document",
	} {
		raw, err := json.Marshal(byName[name].InputSchema)
		if err != nil {
			t.Fatalf("%s schema 序列化失败：%v", name, err)
		}
		if !strings.Contains(string(raw), `"$defs"`) ||
			!strings.Contains(string(raw), `#/$defs/block`) {
			t.Errorf("%s 的 inputSchema 缺少 $defs/block：%s", name, raw)
		}
	}

	// send_message 的两个枚举字段应带可选值
	raw, err := json.Marshal(byName["feishu_send_message"].InputSchema)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(raw), `"chat_id"`) || !strings.Contains(string(raw), `"text_card"`) {
		t.Errorf("send_message 的枚举没挂上：%s", raw)
	}
}

func callError(t *testing.T, cs *mcp.ClientSession, name string, args map[string]any) string {
	t.Helper()
	res, err := cs.CallTool(context.Background(), &mcp.CallToolParams{Name: name, Arguments: args})
	if err != nil {
		t.Fatalf("CallTool(%s) 协议错误：%v", name, err)
	}
	if !res.IsError {
		t.Fatalf("CallTool(%s) 期望 isError=true，得到 %+v", name, res)
	}
	if len(res.Content) == 0 {
		t.Fatalf("CallTool(%s) 没有 content", name)
	}
	text, ok := res.Content[0].(*mcp.TextContent)
	if !ok {
		t.Fatalf("CallTool(%s) content 不是文本：%T", name, res.Content[0])
	}
	return text.Text
}

func TestNestedBlockValidation(t *testing.T) {
	cs := newTestSession(t)
	msg := callError(t, cs, "feishu_insert_blocks", map[string]any{
		"ref": "doxcn-not-used",
		"blocks": []any{
			map[string]any{"type": "text", "children": []any{
				map[string]any{"bogus": 1},
			}},
		},
	})
	if !strings.Contains(msg, "additional properties") {
		t.Errorf("错误信息应含 additional properties：%s", msg)
	}
}

func TestMissingRequiredFields(t *testing.T) {
	cs := newTestSession(t)
	msg := callError(t, cs, "feishu_send_message", map[string]any{})
	if !strings.Contains(msg, "receive_id") || !strings.Contains(msg, "content") {
		t.Errorf("错误信息应提示缺少 receive_id/content：%s", msg)
	}
}

func TestSchemaEnumRejectsUnknown(t *testing.T) {
	cs := newTestSession(t)
	msg := callError(t, cs, "feishu_send_message", map[string]any{
		"receive_id": "x",
		"content":    "y",
		"msg_type":   "voice",
	})
	if !strings.Contains(msg, "voice") {
		t.Errorf("错误信息应指出非法的 msg_type：%s", msg)
	}
}

func equalStrings(a, b []string) bool {
	if len(a) != len(b) {
		return false
	}
	for i := range a {
		if a[i] != b[i] {
			return false
		}
	}
	return true
}
