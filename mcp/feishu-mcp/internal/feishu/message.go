package feishu

import (
	"context"
	"net/http"
	"net/url"
	"strings"
)

// ReceiveIDType 是 receive_id 的类型；空串取默认值 email。
// 用具名类型是为了在 MCP 工具 schema 里暴露可选值。
type ReceiveIDType string

// MsgType 是消息类型；空串取默认值 text。
type MsgType string

// receiveIDTypes / msgTypes 是飞书支持的可选值（与 Python 版的 Literal 一致）。
var receiveIDTypes = map[string]bool{
	"email": true, "open_id": true, "user_id": true, "chat_id": true,
}

var msgTypes = map[string]bool{
	"text": true, "post": true, "text_card": true, "image": true, "interactive": true,
}

// SendMessageResult 是发消息的结果。
type SendMessageResult struct {
	MessageID string `json:"message_id"`
}

// SendMessage 以机器人身份发送飞书消息（私聊或群聊）。
//
// msgType=text 时 content 按纯文本处理；其它类型 content 必须是已序列化好的 JSON 字符串。
func (c *Client) SendMessage(ctx context.Context, receiveID, content string, receiveIDType ReceiveIDType, msgType MsgType) (*SendMessageResult, error) {
	ridType := string(receiveIDType)
	if ridType == "" {
		ridType = "email"
	}
	if !receiveIDTypes[ridType] {
		return nil, errf(-1, "不支持的 receive_id_type：%s（可用：chat_id, email, open_id, user_id）", ridType)
	}
	mt := string(msgType)
	if mt == "" {
		mt = "text"
	}
	if !msgTypes[mt] {
		return nil, errf(-1, "不支持的 msg_type：%s（可用：image, interactive, post, text, text_card）", mt)
	}
	if mt == "text" {
		raw, err := marshalBody(map[string]any{"text": content})
		if err != nil {
			return nil, errf(-1, "消息内容序列化失败：%v", err)
		}
		content = string(raw)
	}
	data, err := c.do(ctx, http.MethodPost, "/im/v1/messages", map[string]any{
		"receive_id": receiveID,
		"msg_type":   mt,
		"content":    content,
	}, url.Values{"receive_id_type": {ridType}})
	if err != nil {
		return nil, err
	}
	id, _ := data["message_id"].(string)
	return &SendMessageResult{MessageID: id}, nil
}

func lower(s string) string { return strings.ToLower(s) }
