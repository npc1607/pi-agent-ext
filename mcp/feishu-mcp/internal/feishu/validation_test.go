package feishu

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"testing"
)

func requireFeishuError(t *testing.T, function, input string, err error, wantCode int, wantMsg string, wantParts ...string) {
	t.Helper()
	if err == nil {
		t.Fatalf("%s(%s): got error = nil, want Code = %d, msg = %q or containing %q", function, input, wantCode, wantMsg, wantParts)
	}
	var got *Error
	if !errors.As(err, &got) {
		t.Fatalf("%s(%s): got error = %T %v, want *Error with Code = %d", function, input, err, err, wantCode)
	}
	if got.Code != wantCode {
		t.Errorf("%s(%s): got Code = %d (msg = %q), want Code = %d", function, input, got.Code, got.Msg, wantCode)
	}
	if wantMsg != "" && got.Msg != wantMsg {
		t.Errorf("%s(%s): got msg = %q, want %q", function, input, got.Msg, wantMsg)
	}
	for _, want := range wantParts {
		if !strings.Contains(got.Msg, want) {
			t.Errorf("%s(%s): got msg = %q, want it to contain %q", function, input, got.Msg, want)
		}
	}
}

func requireNoWrites(t *testing.T, function, input string, env *writeEnv) {
	t.Helper()
	if got := len(env.methods); got != 0 {
		t.Errorf("%s(%s): got write requests = %d (%v), want 0", function, input, got, env.methods)
	}
}

func TestEditDocumentDryRunRejectsInvalidBlockSpec(t *testing.T) {
	tests := []struct {
		name  string
		input string
		op    Operation
	}{
		{
			name:  "TD-DRY-001 insert",
			input: `op=insert, blocks=[{Type:bogus}], dryRun=true`,
			op:    Operation{Op: "insert", Blocks: []BlockSpec{{Type: "bogus"}}},
		},
		{
			name:  "TD-DRY-002 append",
			input: `op=append, blocks=[{Type:bogus}], dryRun=true`,
			op:    Operation{Op: "append", Blocks: []BlockSpec{{Type: "bogus"}}},
		},
		{
			name:  "TD-DRY-003 replace",
			input: `op=replace, block_id=b1, blocks=[{Type:bogus}], dryRun=true`,
			op:    Operation{Op: "replace", BlockID: "b1", Blocks: []BlockSpec{{Type: "bogus"}}},
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			c, env := newWriteEnv(t, flatDoc())
			_, err := c.EditDocument(context.Background(), "/docx/doc1", []Operation{tt.op}, true)
			requireFeishuError(t, "EditDocument", tt.input, err, -1, "", "不支持的块类型：bogus", "已成功 0 步")
			requireNoWrites(t, "EditDocument", tt.input, env)
		})
	}
}

func TestDeleteRangeValidatesIndexes(t *testing.T) {
	tests := []struct {
		name      string
		start     int
		end       int
		wantMsg   string
		wantParts []string
	}{
		{name: "TD-DR-001 equal indexes", start: 1, end: 1, wantMsg: "end_index 必须大于 start_index"},
		{name: "TD-DR-002 end before start", start: 2, end: 1, wantMsg: "end_index 必须大于 start_index"},
		{name: "TD-DR-003 negative start", start: -1, end: 1, wantParts: []string{"不能为负数", "start_index"}},
		{name: "TD-DR-004 negative end", start: 0, end: -1, wantParts: []string{"不能为负数", "end_index"}},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			c, env := newWriteEnv(t, flatDoc())
			input := fmt.Sprintf("start=%d, end=%d, parentBlockID=", tt.start, tt.end)
			_, err := c.DeleteRange(context.Background(), "/docx/doc1", tt.start, tt.end, "")
			requireFeishuError(t, "DeleteRange", input, err, -1, tt.wantMsg, tt.wantParts...)
			requireNoWrites(t, "DeleteRange", input, env)
		})
	}
}

func TestEditDocumentRequiredParameters(t *testing.T) {
	intPtr := func(v int) *int { return &v }
	tests := []struct {
		name     string
		input    string
		op       Operation
		wantPart string
	}{
		{name: "TD-ED-001 update block_id", input: `op=update, block_id=`, op: Operation{Op: "update"}, wantPart: `缺少参数 "block_id"`},
		{name: "TD-ED-002 patch block_id", input: `op=patch, block_id=`, op: Operation{Op: "patch", Find: "old"}, wantPart: `缺少参数 "block_id"`},
		{name: "TD-ED-003 delete block_id", input: `op=delete, block_id=`, op: Operation{Op: "delete"}, wantPart: `缺少参数 "block_id"`},
		{name: "TD-ED-004 replace block_id", input: `op=replace, block_id=`, op: Operation{Op: "replace"}, wantPart: `缺少参数 "block_id"`},
		{name: "TD-ED-005 patch find", input: `op=patch, block_id=b1, find=`, op: Operation{Op: "patch", BlockID: "b1"}, wantPart: `缺少参数 "find"`},
		{name: "TD-ED-006 delete_range start_index", input: `op=delete_range, start_index=nil, end_index=1`, op: Operation{Op: "delete_range", EndIndex: intPtr(1)}, wantPart: `缺少参数 "start_index"`},
		{name: "TD-ED-007 delete_range end_index", input: `op=delete_range, start_index=0, end_index=nil`, op: Operation{Op: "delete_range", StartIndex: intPtr(0)}, wantPart: `缺少参数 "end_index"`},
		{name: "TD-ED-008 insert blocks", input: `op=insert, blocks=nil`, op: Operation{Op: "insert"}, wantPart: `缺少参数 "blocks"`},
		{name: "TD-ED-009 append blocks", input: `op=append, blocks=nil`, op: Operation{Op: "append"}, wantPart: `缺少参数 "blocks"`},
		{name: "TD-ED-010 update content", input: `op=update, block_id=b1, text=nil, spans=nil, block_style=nil`, op: Operation{Op: "update", BlockID: "b1"}, wantPart: "没有要更新的内容"},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			c, env := newWriteEnv(t, flatDoc())
			_, err := c.EditDocument(context.Background(), "/docx/doc1", []Operation{tt.op}, false)
			requireFeishuError(t, "EditDocument", tt.input, err, -1, "", tt.wantPart, "已成功 0 步")
			requireNoWrites(t, "EditDocument", tt.input, env)
		})
	}
}
