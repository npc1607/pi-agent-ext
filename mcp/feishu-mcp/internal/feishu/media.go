package feishu

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"mime/multipart"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"strings"
)

// maxImageBytes 是单张图片的上限（飞书 upload_all 限制 20MB）。
const maxImageBytes = 20 << 20

// InsertImageResult 是插入图片的结果。
type InsertImageResult struct {
	DocumentID    string       `json:"document_id"`
	ParentBlockID string       `json:"parent_block_id"`
	FileToken     string       `json:"file_token" jsonschema:"飞书素材 token（同一个 token 可重复用于插入多张）"`
	Created       CreatedBlock `json:"created"`
}

// InsertImage 上传一张图片并插入 image 块。
//
// source 可以是本地文件路径，也可以是 http(s) URL（会先下载再上传）。
// 需要应用开通 docs:document.media:upload 权限。
func (c *Client) InsertImage(ctx context.Context, ref, source string, index int, parentBlockID, align string) (*InsertImageResult, error) {
	doc, err := c.documentID(ctx, ref)
	if err != nil {
		return nil, err
	}
	docID := doc.DocumentID
	parentID := parentBlockID
	if parentID == "" {
		parentID = docID
	} else if _, err := c.GetBlock(ctx, ref, parentID); err != nil {
		return nil, err
	}
	if index >= 0 {
		existing, err := c.childrenOf(ctx, docID, parentID)
		if err != nil {
			return nil, err
		}
		if index > len(existing) {
			return nil, errf(-1, "index 越界：父块 %s 现有 %d 个子块，index 只能是 0..%d（-1 表示末尾）",
				parentID, len(existing), len(existing))
		}
	}

	name, data, err := c.loadImage(ctx, source)
	if err != nil {
		return nil, err
	}
	token, err := c.uploadMedia(ctx, docID, name, data)
	if err != nil {
		if isErr(err, 99991672) {
			return nil, errf(codeOf(err), "上传图片失败：应用缺少 docs:document.media:upload 权限。原始错误：%s", err.Error())
		}
		return nil, err
	}

	image := map[string]any{"token": token}
	if align != "" {
		key := strings.ToLower(align)
		if v, ok := alignValues[key]; ok {
			image["align"] = v
		} else {
			image["align"] = align
		}
	}

	created, err := c.createChildren(ctx, docID, parentID,
		[]map[string]any{{"block_type": 27, "image": image}}, index)
	if err != nil {
		return nil, err
	}
	out := renderCreated(created)
	first := CreatedBlock{BlockID: "", Type: "image", Text: ""}
	if len(out) > 0 {
		first = out[0]
	}
	return &InsertImageResult{
		DocumentID:    docID,
		ParentBlockID: parentID,
		FileToken:     token,
		Created:       first,
	}, nil
}

// loadImage 读取本地文件或下载远端 URL，返回文件名与内容。
func (c *Client) loadImage(ctx context.Context, source string) (string, []byte, error) {
	source = strings.TrimSpace(source)
	if source == "" {
		return "", nil, errf(-1, "source 不能为空：给本地图片路径或 http(s) URL")
	}
	if strings.HasPrefix(source, "http://") || strings.HasPrefix(source, "https://") {
		req, err := http.NewRequestWithContext(ctx, http.MethodGet, source, nil)
		if err != nil {
			return "", nil, errf(-1, "下载图片失败：%v", err)
		}
		resp, err := c.http.Do(req)
		if err != nil {
			return "", nil, errf(-1, "下载图片失败：%v", err)
		}
		defer resp.Body.Close()
		if resp.StatusCode != http.StatusOK {
			return "", nil, errf(-1, "下载图片失败：HTTP %d", resp.StatusCode)
		}
		data, err := io.ReadAll(io.LimitReader(resp.Body, maxImageBytes+1))
		if err != nil {
			return "", nil, errf(-1, "下载图片失败：%v", err)
		}
		if len(data) > maxImageBytes {
			return "", nil, errf(-1, "图片超过 20MB 上限")
		}
		name := filepath.Base(strings.Split(source, "?")[0])
		if name == "" || name == "." || name == "/" {
			name = "image.png"
		}
		return name, data, nil
	}

	info, err := os.Stat(source)
	if err != nil {
		return "", nil, errf(-1, "读取图片失败：%v", err)
	}
	if info.Size() > maxImageBytes {
		return "", nil, errf(-1, "图片超过 20MB 上限：%d 字节", info.Size())
	}
	data, err := os.ReadFile(source)
	if err != nil {
		return "", nil, errf(-1, "读取图片失败：%v", err)
	}
	return filepath.Base(source), data, nil
}

// uploadMedia 走 multipart 把图片传到飞书素材库，返回 file_token。
func (c *Client) uploadMedia(ctx context.Context, docID, name string, data []byte) (string, error) {
	var body bytes.Buffer
	mw := multipart.NewWriter(&body)
	fields := [][2]string{
		{"file_name", name},
		{"parent_type", "docx_image"},
		{"parent_node", docID},
		{"size", strconv.Itoa(len(data))},
	}
	for _, kv := range fields {
		if err := mw.WriteField(kv[0], kv[1]); err != nil {
			return "", errf(-1, "构造上传请求失败：%v", err)
		}
	}
	part, err := mw.CreateFormFile("file", name)
	if err != nil {
		return "", errf(-1, "构造上传请求失败：%v", err)
	}
	if _, err := part.Write(data); err != nil {
		return "", errf(-1, "构造上传请求失败：%v", err)
	}
	if err := mw.Close(); err != nil {
		return "", errf(-1, "构造上传请求失败：%v", err)
	}

	tok, err := c.accessToken(ctx)
	if err != nil {
		return "", err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost,
		c.baseURL+"/drive/v1/medias/upload_all", bytes.NewReader(body.Bytes()))
	if err != nil {
		return "", errf(-1, "构造上传请求失败：%v", err)
	}
	req.Header.Set("Content-Type", mw.FormDataContentType())
	req.Header.Set("Authorization", "Bearer "+tok)

	resp, err := c.http.Do(req)
	if err != nil {
		// 上传是写操作，网络中断时结果未知，不自动重试
		return "", &Error{Code: -1, Msg: "上传图片时网络中断，结果未知：" + err.Error(),
			Path: "/drive/v1/medias/upload_all"}
	}
	defer resp.Body.Close()
	raw, _ := io.ReadAll(resp.Body)

	var result map[string]any
	if err := json.Unmarshal(raw, &result); err != nil {
		return "", &Error{Code: resp.StatusCode,
			Msg:    "HTTP " + strconv.Itoa(resp.StatusCode) + "，无 JSON 响应体",
			Status: resp.StatusCode, Path: "/drive/v1/medias/upload_all"}
	}
	code, _ := toInt(result["code"])
	if code != 0 {
		msg, _ := result["msg"].(string)
		return "", &Error{Code: code, Msg: msg, Status: resp.StatusCode, Path: "/drive/v1/medias/upload_all"}
	}
	token, _ := asMap(result["data"])["file_token"].(string)
	if token == "" {
		return "", errf(-1, "上传成功但没有返回 file_token")
	}
	return token, nil
}

// ---------------------------------------------------------------------------
// 画板 / 流程图
// ---------------------------------------------------------------------------

// InsertFlowchartResult 是插入流程图的结果。
type InsertFlowchartResult struct {
	DocumentID    string       `json:"document_id"`
	ParentBlockID string       `json:"parent_block_id"`
	WhiteboardID  string       `json:"whiteboard_id" jsonschema:"画板 ID；后续可用 board 接口继续加节点"`
	Created       CreatedBlock `json:"created"`
}

// InsertDiagram 插入一个画板块，支持使用 Mermaid（sequenceDiagram / flowchart 等）或 PlantUML 渲染图表。
//
// 飞书 docx 的 diagram 块无法通过 API 创建（1770029），所以图表的可行路径是：
// 建一个 board 画板块，再用画板语法解析接口把 Mermaid 或 PlantUML 渲染成节点。
// 需要应用开通 board:whiteboard:node:create 权限。
func (c *Client) InsertDiagram(ctx context.Context, ref, code, syntax string, index int, parentBlockID string) (*InsertFlowchartResult, error) {
	if strings.TrimSpace(code) == "" {
		return nil, errf(-1, "图表代码不能为空")
	}
	doc, err := c.documentID(ctx, ref)
	if err != nil {
		return nil, err
	}
	docID := doc.DocumentID
	parentID := parentBlockID
	if parentID == "" {
		parentID = docID
	} else if _, err := c.GetBlock(ctx, ref, parentID); err != nil {
		return nil, err
	}
	if index >= 0 {
		existing, err := c.childrenOf(ctx, docID, parentID)
		if err != nil {
			return nil, err
		}
		if index > len(existing) {
			return nil, errf(-1, "index 越界：父块 %s 现有 %d 个子块，index 只能是 0..%d（-1 表示末尾）",
				parentID, len(existing), len(existing))
		}
	}

	created, err := c.createChildren(ctx, docID, parentID,
		[]map[string]any{{"block_type": 43, "board": map[string]any{}}}, index)
	if err != nil {
		return nil, err
	}
	if len(created) == 0 {
		return nil, errf(-1, "创建画板块失败：没有返回新块")
	}
	boardBlock := created[0]
	blockID := blockIDOf(boardBlock)
	whiteboardID, _ := asMap(boardBlock["board"])["token"].(string)
	if whiteboardID == "" {
		return nil, errf(-1, "创建画板块成功但没有返回 board token（block %s）", blockID)
	}

	if err := c.renderDiagram(ctx, whiteboardID, code, syntax); err != nil {
		// 渲染失败就把空画板删掉，避免文档里留一个空块
		if _, delErr := c.DeleteBlock(ctx, ref, blockID); delErr != nil {
			return nil, errf(codeOf(err), "%s（另外清理空画板块 %s 也失败了：%v，请手动删除）",
				err.Error(), blockID, delErr)
		}
		return nil, err
	}

	out := renderCreated(created)
	return &InsertFlowchartResult{
		DocumentID:    docID,
		ParentBlockID: parentID,
		WhiteboardID:  whiteboardID,
		Created:       out[0],
	}, nil
}

// InsertFlowchart 兼容原有的流程图接口，支持 PlantUML 及 Mermaid。
func (c *Client) InsertFlowchart(ctx context.Context, ref, plantUML string, index int, parentBlockID string) (*InsertFlowchartResult, error) {
	return c.InsertDiagram(ctx, ref, plantUML, "", index, parentBlockID)
}

// DetectDiagramSyntax 探测图表语法类型：1 为 PlantUML，2 为 Mermaid。
func DetectDiagramSyntax(code, syntax string) int {
	s := strings.ToLower(strings.TrimSpace(syntax))
	if s == "mermaid" {
		return 2
	}
	if s == "plantuml" || s == "puml" {
		return 1
	}

	trimmed := strings.TrimSpace(code)
	lower := strings.ToLower(trimmed)

	// 判断 PlantUML 特征
	if strings.HasPrefix(lower, "@startuml") ||
		strings.HasPrefix(lower, "@startmindmap") ||
		strings.HasPrefix(lower, "@startwbs") ||
		strings.HasPrefix(lower, "@startgantt") ||
		strings.HasPrefix(lower, "@start") {
		return 1
	}

	// 判断 Mermaid 特征
	if strings.HasPrefix(lower, "sequencediagram") ||
		strings.HasPrefix(lower, "flowchart") ||
		strings.HasPrefix(lower, "graph") ||
		strings.HasPrefix(lower, "classdiagram") ||
		strings.HasPrefix(lower, "statediagram") ||
		strings.HasPrefix(lower, "erdiagram") ||
		strings.HasPrefix(lower, "gantt") ||
		strings.HasPrefix(lower, "pie") ||
		strings.HasPrefix(lower, "gitgraph") ||
		strings.HasPrefix(lower, "mindmap") ||
		strings.HasPrefix(lower, "timeline") ||
		strings.HasPrefix(lower, "c4context") ||
		strings.Contains(lower, "sequencediagram") ||
		strings.Contains(lower, "flowchart") ||
		strings.Contains(lower, "graph td") ||
		strings.Contains(lower, "graph lr") {
		return 2
	}

	return 1
}

// renderDiagram 把代码（PlantUML / Mermaid 等）渲染成画板节点。
func (c *Client) renderDiagram(ctx context.Context, whiteboardID, code, syntax string) error {
	syntaxType := DetectDiagramSyntax(code, syntax)
	path := "/board/v1/whiteboards/" + whiteboardID + "/nodes/plantuml"
	payload := map[string]any{
		"plant_uml_code": code,
		"syntax_type":    syntaxType,
	}
	_, err := c.do(ctx, http.MethodPost, path, payload, nil)
	if err != nil {
		if isErr(err, 99991672) {
			return errf(codeOf(err), "渲染流程图失败：应用缺少 board:whiteboard:node:create 权限。原始错误：%s", err.Error())
		}
		return errf(codeOf(err), "渲染流程图失败：%s", err.Error())
	}
	return nil
}
