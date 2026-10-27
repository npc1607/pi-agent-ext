package feishu

import (
	"reflect"
	"strings"
	"testing"
)

func TestBuildBlockStyle(t *testing.T) {
	t.Run("sequence 不能单独使用", func(t *testing.T) {
		_, _, err := buildBlockStyle(&BlockStyle{Sequence: "auto"})
		if err == nil || err.Error() != "飞书错误 -1：sequence 不能单独修改，请同时指定 align 等其它块级样式" {
			t.Errorf("错误信息不匹配：%v", err)
		}
	})

	t.Run("sequence + align", func(t *testing.T) {
		style, fields, err := buildBlockStyle(&BlockStyle{Sequence: "auto", Align: "left"})
		if err != nil {
			t.Fatal(err)
		}
		if style["align"] != 1 || style["sequence"] != "auto" {
			t.Errorf("style = %#v，期望 align:1 sequence:auto", style)
		}
		if !reflect.DeepEqual(fields, []int{1}) {
			t.Errorf("fields = %v，期望 [1]", fields)
		}
	})

	t.Run("language 数字字符串", func(t *testing.T) {
		style, fields, err := buildBlockStyle(&BlockStyle{Language: "22"})
		if err != nil {
			t.Fatal(err)
		}
		if style["language"] != 22 {
			t.Errorf("style.language = %v，期望 22", style["language"])
		}
		if !reflect.DeepEqual(fields, []int{4}) {
			t.Errorf("fields = %v，期望 [4]", fields)
		}
	})

	t.Run("align 数字字符串按数字透传", func(t *testing.T) {
		style, _, err := buildBlockStyle(&BlockStyle{Align: "2"})
		if err != nil {
			t.Fatal(err)
		}
		if style["align"] != 2 {
			t.Errorf("style.align = %v，期望 2", style["align"])
		}
	})

	t.Run("done", func(t *testing.T) {
		style, fields, err := buildBlockStyle(&BlockStyle{Done: boolPtr(true)})
		if err != nil {
			t.Fatal(err)
		}
		if style["done"] != true {
			t.Errorf("style.done = %v，期望 true", style["done"])
		}
		if !reflect.DeepEqual(fields, []int{2}) {
			t.Errorf("fields = %v，期望 [2]", fields)
		}
	})

	t.Run("空样式", func(t *testing.T) {
		style, fields, err := buildBlockStyle(&BlockStyle{})
		if err != nil {
			t.Fatal(err)
		}
		if len(style) != 0 || len(fields) != 0 {
			t.Errorf("空样式应无 style/fields，得到 %#v / %v", style, fields)
		}
	})
}

func textElements(contents ...string) []map[string]any {
	els := make([]map[string]any, len(contents))
	for i, c := range contents {
		els[i] = map[string]any{"text_run": map[string]any{"content": c}}
	}
	return els
}

func runContents(els []map[string]any) []string {
	out := make([]string, 0, len(els))
	for _, el := range els {
		out = append(out, asMap(el["text_run"])["content"].(string))
	}
	return out
}

func TestReplaceInElements(t *testing.T) {
	cases := []struct {
		name     string
		contents []string
		find     string
		replace  string
		all      bool
		wantN    int
		want     []string
	}{
		{"单次", []string{"abc", "def"}, "cd", "X", false, 1, []string{"abX", "ef"}},
		{"全部", []string{"aXaXa"}, "a", "Z", true, 3, []string{"ZXZXZ"}},
		{"仅第一处", []string{"aXaXa"}, "a", "Z", false, 1, []string{"ZXaXa"}},
		{"跨 run", []string{"ABC", "DEF"}, "CDE", "X", false, 1, []string{"ABX", "F"}},
		{"中文跨 run", []string{"中文测试", "中"}, "文测", "WW", false, 1, []string{"中WW试", "中"}},
		{"中文全部", []string{"中1中"}, "中", "Z", true, 2, []string{"Z1Z"}},
		{"未命中", []string{"abc"}, "zz", "X", false, 0, []string{"abc"}},
		{"删除", []string{"abcdef"}, "cd", "", false, 1, []string{"abef"}},
		{"空 find", []string{"abc"}, "", "X", true, 0, []string{"abc"}},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			els := textElements(tc.contents...)
			if got := replaceInElements(els, tc.find, tc.replace, tc.all); got != tc.wantN {
				t.Errorf("替换次数 = %d，期望 %d", got, tc.wantN)
			}
			if got := runContents(els); !reflect.DeepEqual(got, tc.want) {
				t.Errorf("内容 = %#v，期望 %#v", got, tc.want)
			}
		})
	}

	t.Run("不动非 text_run 元素与未命中的样式", func(t *testing.T) {
		els := []map[string]any{
			{"mention_user": map[string]any{"user_id": "u1"}},
			{"text_run": map[string]any{
				"content":            "abc",
				"text_element_style": map[string]any{"bold": true},
			}},
		}
		if n := replaceInElements(els, "b", "X", false); n != 1 {
			t.Fatalf("替换次数 = %d，期望 1", n)
		}
		if _, ok := els[0]["mention_user"]; !ok {
			t.Error("mention_user 元素被改动了")
		}
		style := asMap(els[1]["text_run"].(map[string]any)["text_element_style"])
		if style["bold"] != true {
			t.Error("原有内联样式丢了")
		}
	})
}

func elementsFromSpecAny(t *testing.T, els []any) map[string]any {
	t.Helper()
	if len(els) == 0 {
		t.Fatal("elements 为空")
	}
	return asMap(els[0])
}

func TestElementsFromSpec(t *testing.T) {
	t.Run("纯文本", func(t *testing.T) {
		els := elementsFromSpec(BlockSpec{Text: "hi"})
		run := asMap(elementsFromSpecAny(t, els)["text_run"])
		if run["content"] != "hi" {
			t.Errorf("content = %v，期望 hi", run["content"])
		}
		if _, ok := run["text_element_style"]; ok {
			t.Error("无样式时不应带 text_element_style")
		}
	})

	t.Run("spans 优先于 text", func(t *testing.T) {
		els := elementsFromSpec(BlockSpec{
			Text:  "ignored",
			Spans: []Span{{Text: "a", Bold: true}},
		})
		if len(els) != 1 {
			t.Fatalf("elements 数量 = %d，期望 1", len(els))
		}
		run := asMap(asMap(els[0])["text_run"])
		if run["content"] != "a" {
			t.Errorf("content = %v，期望 a（应忽略 text）", run["content"])
		}
		if asMap(run["text_element_style"])["bold"] != true {
			t.Error("span 的 bold 丢了")
		}
	})

	t.Run("空 spans 回退 text", func(t *testing.T) {
		els := elementsFromSpec(BlockSpec{Text: "t", Spans: []Span{}})
		run := asMap(asMap(els[0])["text_run"])
		if run["content"] != "t" {
			t.Errorf("content = %v，期望 t", run["content"])
		}
	})

	t.Run("link 百分号编码对齐 Python", func(t *testing.T) {
		els := elementsFromSpec(BlockSpec{
			Text:  "x",
			Style: &InlineStyle{Link: "https://a.com/x?y=1&z=中"},
		})
		run := asMap(asMap(els[0])["text_run"])
		link := asMap(asMap(run["text_element_style"])["link"])
		want := "https%3A%2F%2Fa.com%2Fx%3Fy%3D1%26z%3D%E4%B8%AD"
		if link["url"] != want {
			t.Errorf("link.url = %v，期望 %s", link["url"], want)
		}
	})

	t.Run("顶层快捷方式", func(t *testing.T) {
		els := elementsFromSpec(BlockSpec{Text: "x", Italic: true})
		run := asMap(asMap(els[0])["text_run"])
		if asMap(run["text_element_style"])["italic"] != true {
			t.Error("顶层 italic 快捷方式没生效")
		}
	})

	t.Run("span 的 content 别名与 Python 兼容", func(t *testing.T) {
		// Python 是 sp.get("text", sp.get("content", ""))，两种写法都要吃
		els := elementsFromSpec(BlockSpec{Spans: []Span{{Content: "别名", Bold: true}}})
		run := asMap(asMap(els[0])["text_run"])
		if run["content"] != "别名" {
			t.Errorf("content = %v，期望 别名", run["content"])
		}
		// text 优先于 content
		els = elementsFromSpec(BlockSpec{Spans: []Span{{Text: "正牌", Content: "别名"}}})
		if got := asMap(asMap(els[0])["text_run"])["content"]; got != "正牌" {
			t.Errorf("content = %v，期望 正牌（text 优先）", got)
		}
	})
}

func TestQuoteLinkRoundTrip(t *testing.T) {
	links := []string{
		"https://a.com/x?y=1&z=中",
		"https://example.com/a b/c#d",
		"plain",
		"",
	}
	for _, link := range links {
		block := map[string]any{
			"block_type": 2,
			"text": map[string]any{
				"elements": []any{
					map[string]any{"text_run": map[string]any{
						"content": "x",
						"text_element_style": map[string]any{
							"link": map[string]any{"url": quoteLink(link)},
						},
					}},
				},
			},
		}
		spans := spansFromBlock(block)
		if len(spans) != 1 {
			t.Fatalf("spans 数量 = %d，期望 1", len(spans))
		}
		if spans[0].Link != link {
			t.Errorf("quoteLink/PathUnescape 往返不一致：%q -> %q", link, spans[0].Link)
		}
	}
}

func TestQuoteLinkEncodesReserved(t *testing.T) {
	got := quoteLink("a/b:c?d=e&f+g@h")
	want := "a%2Fb%3Ac%3Fd%3De%26f%2Bg%40h"
	if got != want {
		t.Errorf("quoteLink = %s，期望 %s", got, want)
	}
	if strings.Contains(quoteLink("http://x"), "://") {
		t.Error("quoteLink 不应保留 ://")
	}
}
