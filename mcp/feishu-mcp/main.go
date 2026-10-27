// Command feishu-mcp 是飞书机器人的 stdio MCP 服务。
//
// 核心能力：**原地编辑已有块**，而不是只能“文末追加 / 整段删除”。
// 凭据优先级：环境变量 FEISHU_APP_ID/FEISHU_APP_SECRET > FEISHU_CONFIG 指向的
// JSON 文件 > 可执行文件同目录 config.json > 当前目录 config.json。
package main

import (
	"context"
	"fmt"
	"os"
	"os/signal"
	"syscall"

	"feishu-mcp/internal/feishu"
	"feishu-mcp/internal/mcpserver"
	"github.com/modelcontextprotocol/go-sdk/mcp"
)

func main() {
	if err := run(); err != nil {
		// 注意：stdout 是 MCP 协议通道，日志一律走 stderr。
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}

func run() error {
	appID, appSecret, err := feishu.LoadCredentials()
	if err != nil {
		return err
	}

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	client := feishu.NewClient(appID, appSecret)
	srv := mcpserver.New(client)

	return srv.Run(ctx, &mcp.StdioTransport{})
}
