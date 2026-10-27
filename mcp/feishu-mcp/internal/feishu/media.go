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

// InsertFlowchart 插入一个画板块，并把 PlantUML 流程图渲染进去。
//
// 飞书 docx 的 diagram 块无法通过 API 创建（1770029），所以流程图的可行路径是：
// 建一个 board 画板块，再用画板接口把 PlantUML 渲染成节点。
// 需要应用开通 board:whiteboard:node:create 权限。
func (c *Client) InsertFlowchart(ctx context.Context, ref, plantUML string, index int, parentBlockID string) (*InsertFlowchartResult, error) {
	if strings.TrimSpace(plantUML) == "" {
		return nil, errf(-1, "plantuml 不能为空")
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

	if err := c.renderPlantUML(ctx, whiteboardID, plantUML); err != nil {
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

// renderPlantUML 把 PlantUML 代码渲染成画板节点。
func (c *Client) renderPlantUML(ctx context.Context, whiteboardID, code string) error {
	path := "/board/v1/whiteboards/" + whiteboardID + "/nodes/plantuml"
	_, err := c.do(ctx, http.MethodPost, path, map[string]any{"plant_uml_code": code}, nil)
	if err != nil {
		if isErr(err, 99991672) {
			return errf(codeOf(err), "渲染流程图失败：应用缺少 board:whiteboard:node:create 权限。原始错误：%s", err.Error())
		}
		return errf(codeOf(err), "渲染流程图失败：%s", err.Error())
	}
	return nil
}
