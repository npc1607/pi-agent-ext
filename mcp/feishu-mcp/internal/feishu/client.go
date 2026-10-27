package feishu

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"sync"
	"time"
)

const (
	// BaseURL 是飞书开放平台根地址。
	BaseURL = "https://open.feishu.cn/open-apis"

	// 限频：单应用 3 QPS，单文档并发 3 QPS。
	maxRetries       = 5
	writeMinInterval = 360 * time.Millisecond
)

// retryCodes 命中这些业务错误码时做指数退避重试。
var retryCodes = map[int]bool{99991400: true, 1254290: true, 1061045: true}

// Client 是飞书开放平台的 HTTP 客户端。
//
// 内置限频与重试：
//   - 写请求之间保持最小间隔，避免自己打满 3 QPS
//   - 命中限频（429 / 99991400 / 1254290 / 1061045）时指数退避重试，最多 5 次
//   - 读请求网络异常自动重试
//   - 写请求网络中断不自动重试（结果未知，重试可能建出重复块）
type Client struct {
	appID     string
	appSecret string
	http      *http.Client
	baseURL   string // 默认 BaseURL；测试里指向 httptest，构造后不再改动

	mu          sync.Mutex
	token       string
	tokenExpiry time.Time
	lastWrite   time.Time
}

// NewClient 创建一个飞书客户端。
func NewClient(appID, appSecret string) *Client {
	return &Client{
		appID:     appID,
		appSecret: appSecret,
		http:      &http.Client{Timeout: 30 * time.Second},
		baseURL:   BaseURL,
	}
}

func trimSpace(s string) string { return strings.TrimSpace(s) }

func marshalBody(v any) ([]byte, error) {
	if v == nil {
		return nil, nil
	}
	var buf bytes.Buffer
	enc := json.NewEncoder(&buf)
	enc.SetEscapeHTML(false)
	if err := enc.Encode(v); err != nil {
		return nil, err
	}
	return bytes.TrimRight(buf.Bytes(), "\n"), nil
}

// accessToken 返回缓存的 tenant_access_token，必要时刷新。
func (c *Client) accessToken(ctx context.Context) (string, error) {
	c.mu.Lock()
	if c.token != "" && time.Now().Before(c.tokenExpiry.Add(-time.Minute)) {
		tok := c.token
		c.mu.Unlock()
		return tok, nil
	}
	c.mu.Unlock()

	data, err := c.call(ctx, http.MethodPost, "/auth/v3/tenant_access_token/internal",
		map[string]any{"app_id": c.appID, "app_secret": c.appSecret}, nil, false, false)
	if err != nil {
		return "", err
	}
	tok, _ := data["tenant_access_token"].(string)
	if tok == "" {
		return "", errf(-1, "认证失败，未返回 tenant_access_token")
	}
	expire := 7200
	if v, ok := toInt(data["expire"]); ok {
		expire = v
	}

	c.mu.Lock()
	c.token = tok
	c.tokenExpiry = time.Now().Add(time.Duration(expire) * time.Second)
	c.mu.Unlock()
	return tok, nil
}

// do 发一次业务请求并返回响应里的 data 对象；写方法自动识别。
func (c *Client) do(ctx context.Context, method, path string, body any, query url.Values) (map[string]any, error) {
	write := method == http.MethodPost || method == http.MethodPatch ||
		method == http.MethodPut || method == http.MethodDelete
	return c.call(ctx, method, path, body, query, true, write)
}

// call 是底层请求实现。auth 为 false 时不带 token；write 显式声明是否按写请求限频/重试。
func (c *Client) call(ctx context.Context, method, path string, body any, query url.Values,
	auth, write bool) (map[string]any, error) {

	u := c.baseURL + path
	if clean := cleanQuery(query); clean != "" {
		u += "?" + clean
	}
	payload, err := marshalBody(body)
	if err != nil {
		return nil, errf(-1, "请求体序列化失败：%v", err)
	}

	headers := map[string]string{"Content-Type": "application/json; charset=utf-8"}
	if auth {
		tok, err := c.accessToken(ctx)
		if err != nil {
			return nil, err
		}
		headers["Authorization"] = "Bearer " + tok
	}

	var lastErr *Error
	for attempt := 0; attempt < maxRetries; attempt++ {
		if write {
			c.throttleWrite(ctx)
		}

		var rdr io.Reader
		if payload != nil {
			rdr = bytes.NewReader(payload)
		}
		req, err := http.NewRequestWithContext(ctx, method, u, rdr)
		if err != nil {
			return nil, errf(-1, "构造请求失败：%v", err)
		}
		for k, v := range headers {
			req.Header.Set(k, v)
		}

		resp, err := c.http.Do(req)
		if err != nil {
			// 读请求可安全重试；写请求超时/断连时结果未知，重试可能建出重复块，
			// 所以直接报错，让调用方先读文档确认。
			if !write && attempt < maxRetries-1 {
				lastErr = &Error{Code: -1, Msg: "网络异常：" + err.Error(), Path: path}
				backoff(ctx, attempt)
				continue
			}
			hint := ""
			if write {
				hint = "（写操作网络中断，结果未知；请先 feishu_read_document 确认是否已生效）"
			}
			return nil, &Error{Code: -1, Msg: "网络异常：" + err.Error() + hint, Path: path}
		}

		raw, readErr := io.ReadAll(resp.Body)
		resp.Body.Close()
		if readErr != nil && len(raw) == 0 {
			if !write && attempt < maxRetries-1 {
				lastErr = &Error{Code: -1, Msg: "读取响应失败：" + readErr.Error(), Status: resp.StatusCode, Path: path}
				backoff(ctx, attempt)
				continue
			}
			return nil, &Error{Code: -1, Msg: "读取响应失败：" + readErr.Error(), Status: resp.StatusCode, Path: path}
		}

		var result map[string]any
		if len(raw) == 0 || json.Unmarshal(raw, &result) != nil {
			// 与 Python 一致：非 JSON 响应体不重试，业务码用 HTTP 状态码
			return nil, &Error{
				Code:   resp.StatusCode,
				Msg:    "HTTP " + strconv.Itoa(resp.StatusCode) + "，无 JSON 响应体",
				Status: resp.StatusCode,
				Path:   path,
			}
		}

		code, _ := toInt(result["code"])
		msg, _ := result["msg"].(string)
		if code == 0 && resp.StatusCode < 400 {
			if d, ok := result["data"].(map[string]any); ok {
				return d, nil
			}
			// 认证、部分 GET 接口的响应没有 data 包装（tenant_access_token 就在顶层），
			// 必须原样返回顶层，否则 token 拿不到。
			return result, nil
		}

		retryable := resp.StatusCode == http.StatusTooManyRequests || retryCodes[code]
		lastErr = &Error{Code: code, Msg: msg, Status: resp.StatusCode, Path: path}
		if retryable && attempt < maxRetries-1 {
			backoff(ctx, attempt)
			continue
		}
		return nil, lastErr
	}
	if lastErr != nil {
		return nil, lastErr
	}
	return nil, &Error{Code: -1, Msg: "请求失败：" + path, Path: path}
}

// throttleWrite 保证两次写请求之间至少间隔 writeMinInterval。
func (c *Client) throttleWrite(ctx context.Context) {
	c.mu.Lock()
	now := time.Now()
	wait := writeMinInterval - now.Sub(c.lastWrite)
	if wait > 0 {
		c.lastWrite = now.Add(wait)
	} else {
		c.lastWrite = now
	}
	c.mu.Unlock()
	if wait > 0 {
		t := time.NewTimer(wait)
		defer t.Stop()
		select {
		case <-ctx.Done():
		case <-t.C:
		}
	}
}

func backoff(ctx context.Context, attempt int) {
	d := 600 * time.Millisecond << uint(attempt)
	if d > 8*time.Second {
		d = 8 * time.Second
	}
	t := time.NewTimer(d)
	defer t.Stop()
	select {
	case <-ctx.Done():
	case <-t.C:
	}
}

func cleanQuery(q url.Values) string {
	if len(q) == 0 {
		return ""
	}
	clean := url.Values{}
	for k, vs := range q {
		for _, v := range vs {
			if v != "" {
				clean.Add(k, v)
			}
		}
	}
	return clean.Encode()
}

func toInt(v any) (int, bool) {
	switch n := v.(type) {
	case float64:
		return int(n), true
	case int:
		return n, true
	case int64:
		return int(n), true
	case json.Number:
		i, err := n.Int64()
		return int(i), err == nil
	case string:
		i, err := strconv.Atoi(strings.TrimSpace(n))
		return i, err == nil
	}
	return 0, false
}

// asMap 把任意值当 map[string]any 用，失败时返回空 map。
func asMap(v any) map[string]any {
	if m, ok := v.(map[string]any); ok {
		return m
	}
	return map[string]any{}
}

// asSlice 把任意值当 []any 用，失败时返回 nil。
func asSlice(v any) []any {
	if s, ok := v.([]any); ok {
		return s
	}
	return nil
}

// isErr 判断错误是否带指定业务码。
func isErr(err error, codes ...int) bool {
	var fe *Error
	if !errors.As(err, &fe) {
		return false
	}
	for _, c := range codes {
		if fe.Code == c {
			return true
		}
	}
	return false
}
