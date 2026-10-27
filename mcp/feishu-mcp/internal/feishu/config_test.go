package feishu

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func writeConfig(t *testing.T, dir, content string) string {
	t.Helper()
	p := filepath.Join(dir, "config.json")
	if err := os.WriteFile(p, []byte(content), 0o600); err != nil {
		t.Fatal(err)
	}
	return p
}

func clearCredentialEnv(t *testing.T) {
	t.Helper()
	t.Setenv("FEISHU_APP_ID", "")
	t.Setenv("FEISHU_APP_SECRET", "")
	t.Setenv("FEISHU_CONFIG", "")
}

func TestLoadCredentialsEnvWins(t *testing.T) {
	clearCredentialEnv(t)
	t.Setenv("FEISHU_APP_ID", "env-id")
	t.Setenv("FEISHU_APP_SECRET", "env-secret")
	// 即使 FEISHU_CONFIG 指向坏文件，也应该直接用环境变量
	t.Setenv("FEISHU_CONFIG", filepath.Join(t.TempDir(), "missing.json"))

	id, secret, err := LoadCredentials()
	if err != nil {
		t.Fatal(err)
	}
	if id != "env-id" || secret != "env-secret" {
		t.Errorf("凭据 = %q/%q，期望 env-id/env-secret", id, secret)
	}
}

func TestLoadCredentialsPartialEnvFallsBackToFile(t *testing.T) {
	clearCredentialEnv(t)
	t.Setenv("FEISHU_APP_ID", "env-id")
	file := writeConfig(t, t.TempDir(), `{"app_id":"file-id","app_secret":"file-secret"}`)
	t.Setenv("FEISHU_CONFIG", file)

	id, secret, err := LoadCredentials()
	if err != nil {
		t.Fatal(err)
	}
	if id != "file-id" || secret != "file-secret" {
		t.Errorf("凭据 = %q/%q，期望 file-id/file-secret", id, secret)
	}
}

func TestLoadCredentialsConfigEnvBeatsCwd(t *testing.T) {
	clearCredentialEnv(t)
	file := writeConfig(t, t.TempDir(), `{"app_id":"env-file-id","app_secret":"env-file-secret"}`)
	t.Setenv("FEISHU_CONFIG", file)

	cwd := t.TempDir()
	writeConfig(t, cwd, `{"app_id":"cwd-id","app_secret":"cwd-secret"}`)
	t.Chdir(cwd)

	id, secret, err := LoadCredentials()
	if err != nil {
		t.Fatal(err)
	}
	if id != "env-file-id" || secret != "env-file-secret" {
		t.Errorf("凭据 = %q/%q，期望 env-file-id/env-file-secret", id, secret)
	}
}

func TestLoadCredentialsSkipsBadFiles(t *testing.T) {
	clearCredentialEnv(t)
	bad := writeConfig(t, t.TempDir(), `{not json`)
	t.Setenv("FEISHU_CONFIG", bad)

	cwd := t.TempDir()
	writeConfig(t, cwd, `{"app_id":"cwd-id","app_secret":"cwd-secret"}`)
	t.Chdir(cwd)

	id, secret, err := LoadCredentials()
	if err != nil {
		t.Fatal(err)
	}
	if id != "cwd-id" || secret != "cwd-secret" {
		t.Errorf("凭据 = %q/%q，期望 cwd-id/cwd-secret", id, secret)
	}
}

func TestLoadCredentialsSkipsMissingSecret(t *testing.T) {
	clearCredentialEnv(t)
	partial := writeConfig(t, t.TempDir(), `{"app_id":"only-id"}`)
	t.Setenv("FEISHU_CONFIG", partial)

	cwd := t.TempDir()
	writeConfig(t, cwd, `{"app_id":"cwd-id","app_secret":"cwd-secret"}`)
	t.Chdir(cwd)

	id, secret, err := LoadCredentials()
	if err != nil {
		t.Fatal(err)
	}
	if id != "cwd-id" || secret != "cwd-secret" {
		t.Errorf("凭据 = %q/%q，期望 cwd-id/cwd-secret", id, secret)
	}
}

func TestLoadCredentialsMissing(t *testing.T) {
	clearCredentialEnv(t)
	t.Chdir(t.TempDir())

	_, _, err := LoadCredentials()
	if err == nil {
		t.Fatal("期望报错")
	}
	msg := err.Error()
	if !strings.Contains(msg, "FEISHU_APP_ID") || !strings.Contains(msg, "config.example.json") {
		t.Errorf("错误信息应提示 FEISHU_APP_ID 与 config.example.json：%s", msg)
	}
}
