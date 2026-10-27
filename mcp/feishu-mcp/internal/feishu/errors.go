package feishu

import "fmt"

// Error 是飞书开放平台返回的错误，或本地校验/网络错误（此时 Code 为 -1）。
type Error struct {
	Code   int
	Msg    string
	Status int // HTTP 状态码，0 表示不适用
	Path   string
}

func (e *Error) Error() string {
	return fmt.Sprintf("飞书错误 %d：%s", e.Code, e.Msg)
}

func errf(code int, format string, a ...any) *Error {
	return &Error{Code: code, Msg: fmt.Sprintf(format, a...)}
}
