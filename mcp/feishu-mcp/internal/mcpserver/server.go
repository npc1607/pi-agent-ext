package mcpserver

import (
	"context"

	"feishu-mcp/internal/feishu"
	"github.com/modelcontextprotocol/go-sdk/mcp"
)

// Server 把飞书客户端暴露成 MCP 工具。
type Server struct {
	c *feishu.Client
}

// New 创建 MCP 服务并注册全部工具。
func New(client *feishu.Client) *mcp.Server {
	s := &Server{c: client}
	srv := mcp.NewServer(&mcp.Implementation{Name: "feishu-mcp", Version: "2.0.0"}, nil)
	s.registerAll(srv)
	return srv
}

func (s *Server) registerAll(srv *mcp.Server) {
	s.registerMessage(srv)
	s.registerResolve(srv)
	s.registerRead(srv)
	s.registerUpdate(srv)
	s.registerPatch(srv)
	s.registerInsert(srv)
	s.registerAppend(srv)
	s.registerDelete(srv)
	s.registerReplace(srv)
	s.registerEditDocument(srv)
	s.registerImage(srv)
	s.registerFlowchart(srv)
}

// handler 适配 feishu 调用，把错误原样上抛给模型。
func handler[In, Out any](fn func(context.Context, In) (Out, error)) mcp.ToolHandlerFor[In, Out] {
	return func(ctx context.Context, _ *mcp.CallToolRequest, in In) (*mcp.CallToolResult, Out, error) {
		out, err := fn(ctx, in)
		if err != nil {
			var zero Out
			return nil, zero, err
		}
		return nil, out, nil
	}
}
