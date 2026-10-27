package feishu

import (
	"net/url"
	"strconv"
	"strings"
)

// ---------------------------------------------------------------------------
// 块原始结构访问（飞书返回的 block 字段形态因类型而异，统一用 map 处理）
// ---------------------------------------------------------------------------

func blockIDOf(b map[string]any) string {
	s, _ := b["block_id"].(string)
	return s
}

func parentIDOf(b map[string]any) string {
	s, _ := b["parent_id"].(string)
	return s
}

func blockTypeOf(b map[string]any) int {
	n, _ := toInt(b["block_type"])
	return n
}

func blockTypeName(t int) string {
	if name, ok := blockTypeNames[t]; ok {
		return name
	}
	return "unknown_" + strconv.Itoa(t)
}

func childrenIDsOf(b map[string]any) []string {
	var out []string
	for _, c := range asSlice(b["children"]) {
		if s, ok := c.(string); ok {
			out = append(out, s)
		}
	}
	return out
}

// elementsOf 取出块内容字段里的 text elements。
func elementsOf(b map[string]any) []any {
	field, ok := textFieldByType[blockTypeOf(b)]
	if !ok {
		return nil
	}
	return asSlice(asMap(b[field])["elements"])
}

// elementsText 把一个块里的 text_element 列表拼成纯文本。
func elementsText(b map[string]any) string {
	var sb strings.Builder
	for _, el := range elementsOf(b) {
		e := asMap(el)
		switch {
		case e["text_run"] != nil:
			s, _ := asMap(e["text_run"])["content"].(string)
			sb.WriteString(s)
		case e["mention_user"] != nil:
			sb.WriteString("@用户")
		case e["mention_doc"] != nil:
			md := asMap(e["mention_doc"])
			if t, _ := md["title"].(string); t != "" {
				sb.WriteString(t)
			} else if u, _ := md["url"].(string); u != "" {
				sb.WriteString(u)
			} else {
				sb.WriteString("@文档")
			}
		case e["equation"] != nil:
			s, _ := asMap(e["equation"])["content"].(string)
			sb.WriteString(s)
		case e["reminder"] != nil:
			sb.WriteString("[日期提醒]")
		case e["file"] != nil:
			sb.WriteString("[附件]")
		case e["inline_block"] != nil:
			sb.WriteString("[内嵌块]")
		}
	}
	return sb.String()
}

// blockText 从块结构里提取纯文本（无文本的块返回空串）。
func blockText(b map[string]any) string { return elementsText(b) }

// ---------------------------------------------------------------------------
// 构造 text elements
// ---------------------------------------------------------------------------

// quoteLink 复刻 Python 的 urllib.parse.quote(link, safe="")：
// 除 A-Za-z0-9 - . _ ~ 之外全部百分号编码（按 UTF-8 字节），
// 与 spansFromBlock 里的 url.PathUnescape 正反对称。
func quoteLink(s string) string {
	const hex = "0123456789ABCDEF"
	var b strings.Builder
	for i := 0; i < len(s); i++ {
		c := s[i]
		if c >= 'A' && c <= 'Z' || c >= 'a' && c <= 'z' || c >= '0' && c <= '9' ||
			c == '-' || c == '.' || c == '_' || c == '~' {
			b.WriteByte(c)
			continue
		}
		b.WriteByte('%')
		b.WriteByte(hex[c>>4])
		b.WriteByte(hex[c&0x0F])
	}
	return b.String()
}

// textRun 构造一个 text_run，支持可选内联样式。
func textRun(content string, st *InlineStyle) map[string]any {
	run := map[string]any{"content": content}
	if st != nil {
		style := map[string]any{}
		if st.Bold {
			style["bold"] = true
		}
		if st.Italic {
			style["italic"] = true
		}
		if st.Underline {
			style["underline"] = true
		}
		if st.Strikethrough {
			style["strikethrough"] = true
		}
		if st.InlineCode {
			style["inline_code"] = true
		}
		if st.Link != "" {
			style["link"] = map[string]any{"url": quoteLink(st.Link)}
		}
		if st.TextColor != 0 {
			style["text_color"] = st.TextColor
		}
		if st.BgColor != 0 {
			style["background_color"] = st.BgColor
		}
		if len(style) > 0 {
			run["text_element_style"] = style
		}
	}
	return map[string]any{"text_run": run}
}

func hasInlineStyle(s *InlineStyle) bool {
	if s == nil {
		return false
	}
	return s.Bold || s.Italic || s.Underline || s.Strikethrough || s.InlineCode ||
		s.Link != "" || s.TextColor != 0 || s.BgColor != 0
}

func spanStyle(s Span) *InlineStyle {
	st := &InlineStyle{
		Bold: s.Bold, Italic: s.Italic, Underline: s.Underline,
		Strikethrough: s.Strikethrough, InlineCode: s.InlineCode, Link: s.Link,
		TextColor: s.TextColor, BgColor: s.BgColor,
	}
	if !hasInlineStyle(st) {
		return nil
	}
	return st
}

// elementsFromSpec 按 spans / style / text 构造 elements。
func elementsFromSpec(spec BlockSpec) []any {
	if len(spec.Spans) > 0 {
		out := make([]any, 0, len(spec.Spans))
		for _, sp := range spec.Spans {
			out = append(out, textRun(sp.body(), spanStyle(sp)))
		}
		return out
	}
	st := spec.Style
	if !hasInlineStyle(st) {
		st = &InlineStyle{
			Bold: spec.Bold, Italic: spec.Italic, Underline: spec.Underline,
			Strikethrough: spec.Strikethrough, InlineCode: spec.InlineCode, Link: spec.Link,
			TextColor: spec.TextColor, BgColor: spec.BgColor,
		}
		if !hasInlineStyle(st) {
			st = nil
		}
	}
	return []any{textRun(spec.Text, st)}
}

// codeLanguage 把代码块语言解析成枚举值；未知语言回退纯文本(1)。
func codeLanguage(lang string) int {
	key := strings.ToLower(strings.TrimSpace(lang))
	if key == "" {
		return 1
	}
	if n, err := strconv.Atoi(key); err == nil {
		return n
	}
	if v, ok := codeLanguages[key]; ok {
		return v
	}
	return 1
}

// buildBlockStyle 把用户友好的块级样式转成飞书 text_style + fields 位。
func buildBlockStyle(bs *BlockStyle) (map[string]any, []int, error) {
	style := map[string]any{}
	var fields []int
	if bs == nil {
		return style, fields, nil
	}
	if bs.Align != "" {
		raw := string(bs.Align)
		if n, err := strconv.Atoi(strings.TrimSpace(raw)); err == nil {
			// Python 对 int align 原样透传（1/2/3）
			style["align"] = n
		} else if v, ok := alignValues[strings.ToLower(raw)]; ok {
			style["align"] = v
		} else {
			style["align"] = raw
		}
		fields = append(fields, blockStyleFieldBits["align"])
	}
	if bs.Done != nil {
		style["done"] = *bs.Done
		fields = append(fields, blockStyleFieldBits["done"])
	}
	if bs.Folded != nil {
		style["folded"] = *bs.Folded
		fields = append(fields, blockStyleFieldBits["folded"])
	}
	if bs.Language != "" {
		style["language"] = codeLanguage(string(bs.Language))
		fields = append(fields, blockStyleFieldBits["language"])
	}
	if bs.Wrap != nil {
		style["wrap"] = *bs.Wrap
		fields = append(fields, blockStyleFieldBits["wrap"])
	}
	if bs.BackgroundColor != "" {
		key := strings.ToLower(bs.BackgroundColor)
		if v, ok := backgroundColors[key]; ok {
			style["background_color"] = v
		} else {
			style["background_color"] = bs.BackgroundColor
		}
		fields = append(fields, blockStyleFieldBits["background_color"])
	}
	if bs.IndentationLevel != "" {
		key := strings.ToLower(bs.IndentationLevel)
		if v, ok := indentValues[key]; ok {
			style["indentation_level"] = v
		} else {
			style["indentation_level"] = bs.IndentationLevel
		}
		fields = append(fields, blockStyleFieldBits["indentation_level"])
	}
	if bs.Sequence != "" {
		style["sequence"] = string(bs.Sequence)
		// sequence 没有独立的 fields 位，必须和至少一个其它样式字段一起下发
		if len(fields) == 0 {
			return nil, nil, errf(-1, "sequence 不能单独修改，请同时指定 align 等其它块级样式")
		}
	}
	return style, fields, nil
}

// ---------------------------------------------------------------------------
// 段内查找替换（保留内联样式）
// ---------------------------------------------------------------------------

// replaceInElements 在 text_run 列表里做查找替换，跨 run 也能匹配，
// 插入文本继承起始 run 的样式。只改动匹配到的字符，其余 run 原样保留。
func replaceInElements(elements []map[string]any, find, replace string, allMatches bool) int {
	if find == "" {
		// 空串会让 strings.Index 原地打转，直接短路
		return 0
	}
	type run struct {
		idx     int
		content string
	}
	var runs []run
	var sb strings.Builder
	for i, el := range elements {
		tr, ok := el["text_run"].(map[string]any)
		if !ok {
			continue
		}
		content, _ := tr["content"].(string)
		runs = append(runs, run{i, content})
		sb.WriteString(content)
	}
	full := sb.String()
	if !strings.Contains(full, find) {
		return 0
	}

	type spanPos struct{ start, end int }
	var matches []spanPos
	start := 0
	for {
		hit := strings.Index(full[start:], find)
		if hit < 0 {
			break
		}
		hit += start
		matches = append(matches, spanPos{hit, hit + len(find)})
		start = hit + len(find)
		if !allMatches {
			break
		}
	}

	deleted := map[int]bool{}
	inserts := map[int]string{}
	for _, m := range matches {
		for i := m.start; i < m.end; i++ {
			deleted[i] = true
		}
		inserts[m.start] += replace
	}

	pos := 0
	for _, r := range runs {
		var out strings.Builder
		for i, ch := range r.content {
			g := pos + i
			if s, ok := inserts[g]; ok {
				out.WriteString(s)
			}
			if !deleted[g] {
				out.WriteRune(ch)
			}
		}
		pos += len(r.content)
		if out.String() != r.content {
			elements[r.idx]["text_run"].(map[string]any)["content"] = out.String()
		}
	}
	return len(matches)
}

// spansFromBlock 从块里取出逐片内联样式。
func spansFromBlock(b map[string]any) []Span {
	var spans []Span
	for _, el := range elementsOf(b) {
		tr, ok := asMap(el)["text_run"].(map[string]any)
		if !ok {
			continue
		}
		content, _ := tr["content"].(string)
		sp := Span{Text: content}
		st := asMap(tr["text_element_style"])
		sp.Bold, _ = st["bold"].(bool)
		sp.Italic, _ = st["italic"].(bool)
		sp.Underline, _ = st["underline"].(bool)
		sp.Strikethrough, _ = st["strikethrough"].(bool)
		sp.InlineCode, _ = st["inline_code"].(bool)
		sp.TextColor, _ = toInt(st["text_color"])
		sp.BgColor, _ = toInt(st["background_color"])
		if link := asMap(st["link"]); len(link) > 0 {
			if raw, _ := link["url"].(string); raw != "" {
				if un, err := url.PathUnescape(raw); err == nil {
					sp.Link = un
				} else {
					sp.Link = raw
				}
			}
		}
		spans = append(spans, sp)
	}
	return spans
}
