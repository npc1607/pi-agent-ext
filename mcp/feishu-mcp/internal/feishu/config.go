package feishu

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
)

// LoadCredentials 按以下优先级解析应用凭据：
//
//  1. 环境变量 FEISHU_APP_ID + FEISHU_APP_SECRET
//  2. 环境变量 FEISHU_CONFIG 指向的 JSON 文件
//  3. 可执行文件同目录的 config.json
//  4. 当前工作目录的 config.json
func LoadCredentials() (appID, appSecret string, err error) {
	appID = trimSpace(os.Getenv("FEISHU_APP_ID"))
	appSecret = trimSpace(os.Getenv("FEISHU_APP_SECRET"))
	if appID != "" && appSecret != "" {
		return appID, appSecret, nil
	}

	var candidates []string
	if p := trimSpace(os.Getenv("FEISHU_CONFIG")); p != "" {
		candidates = append(candidates, p)
	}
	if exe, e := os.Executable(); e == nil {
		candidates = append(candidates, filepath.Join(filepath.Dir(exe), "config.json"))
	}
	if wd, e := os.Getwd(); e == nil {
		candidates = append(candidates, filepath.Join(wd, "config.json"))
	}

	for _, p := range candidates {
		raw, e := os.ReadFile(p)
		if e != nil {
			continue
		}
		var cfg struct {
			AppID     string `json:"app_id"`
			AppSecret string `json:"app_secret"`
		}
		if json.Unmarshal(raw, &cfg) != nil {
			continue
		}
		if trimSpace(cfg.AppID) != "" && trimSpace(cfg.AppSecret) != "" {
			return trimSpace(cfg.AppID), trimSpace(cfg.AppSecret), nil
		}
	}

	return "", "", fmt.Errorf("缺少飞书应用凭据。请设置环境变量 FEISHU_APP_ID / FEISHU_APP_SECRET，" +
		"或提供包含 app_id / app_secret 的 config.json（可参考 config.example.json）")
}
