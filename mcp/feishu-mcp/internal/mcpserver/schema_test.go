package mcpserver

import (
	"encoding/json"
	"reflect"
	"sort"
	"strings"
	"testing"

	"feishu-mcp/internal/feishu"
)

func jsonFieldNames(t *testing.T, v any) []string {
	t.Helper()
	typ := reflect.TypeOf(v)
	if typ.Kind() == reflect.Pointer {
		typ = typ.Elem()
	}
	var names []string
	for _, f := range reflect.VisibleFields(typ) {
		tag := f.Tag.Get("json")
		name := strings.Split(tag, ",")[0]
		if name == "" || name == "-" {
			t.Fatalf("字段 %s 没有可用的 json tag：%q", f.Name, tag)
		}
		names = append(names, name)
	}
	sort.Strings(names)
	return names
}

func TestBlockDefMatchesBlockSpec(t *testing.T) {
	want := jsonFieldNames(t, feishu.BlockSpec{})

	props := blockDef().Properties
	got := make([]string, 0, len(props))
	for name := range props {
		got = append(got, name)
	}
	sort.Strings(got)

	if !reflect.DeepEqual(got, want) {
		t.Fatalf("$defs/block 与 BlockSpec 的 json 字段不一致\nschema：%v\n结构体：%v", got, want)
	}
}

func TestBlockDefShape(t *testing.T) {
	def := blockDef()
	if def.Type != "object" {
		t.Errorf("Type = %q，期望 object", def.Type)
	}
	if !reflect.DeepEqual(def.Required, []string{"type"}) {
		t.Errorf("Required = %v，期望 [type]", def.Required)
	}
	if def.AdditionalProperties == nil {
		t.Error("$defs/block 必须禁止未知字段（additionalProperties:false）")
	}
	children := def.Properties["children"]
	if children == nil || children.Items == nil || children.Items.Ref != "#/$defs/block" {
		t.Errorf("children.items 必须是 $ref #/$defs/block：%+v", children)
	}
	if len(def.Properties["type"].Enum) != 0 {
		t.Error("type 不能加 enum，否则 h2 / paragraph 等别名会被拒")
	}
	bs := def.Properties["block_style"]
	if bs == nil || bs.Properties["language"] == nil || len(bs.Properties["language"].Types) != 2 {
		t.Errorf("block_style.language 应同时接受字符串与整数：%+v", bs)
	}
}

func schemaJSON(t *testing.T, s any) string {
	t.Helper()
	raw, err := json.Marshal(s)
	if err != nil {
		t.Fatal(err)
	}
	return string(raw)
}

func TestInputSchemaBlockToolsHaveDefs(t *testing.T) {
	cases := map[string]any{
		"insert":  inputSchema[InsertBlocksArgs](nil),
		"append":  inputSchema[AppendDocumentArgs](nil),
		"replace": inputSchema[ReplaceBlockArgs](nil),
		"edit":    inputSchema[EditDocumentArgs](nil),
	}
	for name, s := range cases {
		t.Run(name, func(t *testing.T) {
			if !strings.Contains(schemaJSON(t, s), `"#/$defs/block"`) {
				t.Error("schema 里应包含 $ref #/$defs/block")
			}
			if !strings.Contains(schemaJSON(t, s), `"$defs"`) {
				t.Error("schema 里应包含 $defs")
			}
		})
	}
}

func TestInputSchemaUpdateBlockAllowsNumericLanguage(t *testing.T) {
	s := inputSchema[UpdateBlockArgs](nil)
	lang := s.Properties["block_style"].Properties["language"]
	if lang == nil || len(lang.Types) != 2 {
		t.Errorf("update_block 的 block_style.language 应接受字符串或整数：%+v", lang)
	}
	if s.Defs != nil {
		t.Error("update_block 不含递归类型，不应带 $defs")
	}
}

func TestInputSchemaSendMessageHasEnums(t *testing.T) {
	s := sendMessageInputSchema()
	if s.Defs != nil {
		t.Error("send_message 不应带 $defs/block")
	}
	rid := s.Properties["receive_id_type"]
	if rid == nil || len(rid.Enum) != 4 {
		t.Errorf("receive_id_type enum = %+v", rid)
	}
	mt := s.Properties["msg_type"]
	if mt == nil || len(mt.Enum) != 5 {
		t.Errorf("msg_type enum = %+v", mt)
	}
}
