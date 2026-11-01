#!/usr/bin/env bun
/**
 * 校验 knowledge/api-test-strategy.md 里的 TypeScript 参考实现是否真能跑。
 *
 * 这是扩展自身的自检脚本（dev-only），不是 API 测试套件本身。
 * 测试套件是 `.pi/api-tests/*.ts`，纯 TypeScript。
 *
 * 做法：抽取知识库里的 ```typescript 代码块 → 落到临时工作区 → 用内置 http 服务当真接口 →
 *      用 bun / node 各跑一遍绿色路径，再验证失败路径与基线（auto 记录 → verify 抓漂移）。
 *
 * 运行：bun scripts/verify-api-test-reference.ts
 *       node scripts/verify-api-test-reference.ts
 */

import * as fs from "node:fs";
import * as http from "node:http";
import * as os from "node:os";
import * as path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "..");
const KNOWLEDGE = path.join(REPO, "extensions/thin-orchestrator/knowledge/api-test-strategy.md");

const PROXY_KEYS = ["http_proxy", "https_proxy", "HTTP_PROXY", "HTTPS_PROXY", "all_proxy", "ALL_PROXY"];

let failed = 0;
const ok = (msg: string) => console.log(`  \x1b[32mPASS\x1b[0m ${msg}`);
const bad = (msg: string) => {
  failed++;
  console.log(`  \x1b[31mFAIL\x1b[0m ${msg}`);
};

function cleanEnv(extra: Record<string, string>): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, ...extra };
  for (const k of PROXY_KEYS) delete env[k];
  return env;
}

// ---------------------------------------------------------------- 假服务
type Mode = "ok" | "broken" | "drift";

function startServer(mode: Mode): Promise<{ port: number; close: () => Promise<void> }> {
  const server = http.createServer((req, res) => {
    const send = (code: number, payload: unknown) => {
      const body = JSON.stringify(payload);
      res.writeHead(code, { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) });
      res.end(body);
    };
    const url = req.url ?? "/";
    if (req.method === "GET") {
      if (url.startsWith("/api/model/v1/list")) {
        return send(200, { data: [{ id: 1001, active_version: mode === "drift" ? 8 : 7 }] });
      }
      if (url.startsWith("/api/job/v1/list")) {
        return send(200, { data: [{ job_id: "J-1", status: mode === "drift" ? 2 : 1, created_at: "2026-01-01" }] });
      }
      return send(404, { message: "not found" });
    }
    if (req.method === "POST") {
      const chunks: Buffer[] = [];
      req.on("data", (c) => chunks.push(c as Buffer));
      req.on("end", () => {
        let body: any = {};
        try {
          body = JSON.parse(Buffer.concat(chunks).toString() || "{}");
        } catch {
          body = {};
        }
        if (url === "/api/job/v1/approve-create") {
          const mv = body?.inference_config?.model_version;
          if (mv === 99) return send(409, { code: 409, message: "stale model version" });
          if (body.job_type === 33 && mode === "broken") return send(500, { message: "boom" });
          return send(200, { job: { job_id: `J-${body.job_type}`, job_name: "", status: 2 } });
        }
        if (url === "/api/job/v1/info") {
          return send(200, {
            job: { job_id: body.job_id, job_name: "x", status: 2 },
            inference_config: { model_version: mode === "drift" ? 5 : 7 },
          });
        }
        if (url === "/api/job/v1/stop-job") return send(200, { ok: true });
        return send(404, { message: "not found" });
      });
      return;
    }
    send(404, { message: "not found" });
  });

  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      resolve({
        port,
        close: () => new Promise<void>((done) => server.close(() => done())),
      });
    });
  });
}

// ---------------------------------------------------------------- 抽代码块
function extractReference(work: string): string[] {
  const doc = fs.readFileSync(KNOWLEDGE, "utf-8");
  const blocks = [...doc.matchAll(/```typescript\n([\s\S]*?)```/g)];
  if (blocks.length === 0) throw new Error("no ```typescript blocks found in the knowledge file");

  const written: string[] = [];
  for (const m of blocks) {
    const start = m.index ?? 0;
    const pre = doc.slice(Math.max(0, start - 700), start);
    // 只看产物路径（.pi/api-tests/...），忽略 import 里的相对路径
    const paths = [...pre.matchAll(/`([^`]*\.ts)`/g)]
      .map((x) => x[1] as string)
      .filter((p) => !p.startsWith("./") && !p.startsWith("../") && p.includes("/"));
    if (paths.length === 0) throw new Error(`no target .ts path before block at offset ${start}`);

    const rel = (paths[paths.length - 1] as string).replace(/^\//, "");
    const dst = path.join(work, rel);
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    fs.writeFileSync(dst, m[1] as string, "utf-8");
    written.push(rel);
  }

  const required = [
    ".pi/api-tests/runner.ts",
    ".pi/api-tests/prep.ts",
    ".pi/api-tests/lib/client.ts",
    ".pi/api-tests/lib/assert.ts",
    ".pi/api-tests/lib/diff.ts",
    ".pi/api-tests/lib/context.ts",
    ".pi/api-tests/lib/reporter.ts",
    ".pi/api-tests/types/common.ts",
    ".pi/api-tests/coverage-check.ts",
  ];
  const missing = required.filter((r) => !written.includes(r));
  if (missing.length > 0) throw new Error(`missing required files: ${missing.join(", ")}`);
  return written;
}

// ---------------------------------------------------------------- 跑套件
interface RunResult {
  code: number;
  output: string;
}

/**
 * 必须用异步 spawn：spawnSync 会阻塞事件循环，令同进程内的假 HTTP 服务无法响应，
 * 子进程请求永远等不到回复而超时。
 */
function runSuite(opts: {
  runtime: string;
  cwd: string;
  port: number;
  baselineMode: string;
}): Promise<RunResult> {
  const args = opts.runtime === "bun" ? ["run", "runner.ts"] : ["runner.ts"];
  return new Promise((resolve) => {
    const child = spawn(opts.runtime, args, {
      cwd: opts.cwd,
      env: cleanEnv({
        API_BASE_URL: `http://127.0.0.1:${opts.port}`,
        TASK_ID: "1",
        MODEL_ID: "1001",
        MODEL_ACTIVE_VERSION: "7",
        CONFIG_TEMPLATE_ID: "5",
        API_BASELINE_MODE: opts.baselineMode,
        NO_PROXY: "127.0.0.1,localhost",
      }),
    });
    let output = "";
    child.stdout.on("data", (d) => (output += String(d)));
    child.stderr.on("data", (d) => (output += String(d)));
    const timer = setTimeout(() => child.kill("SIGKILL"), 120_000);
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? -1, output });
    });
  });
}

function availableRuntimes(): string[] {
  const out: string[] = [];
  for (const bin of ["bun", "node"]) {
    const r = spawnSync(bin, ["--version"], { encoding: "utf-8" });
    if (r.status === 0) out.push(bin);
  }
  return out;
}


/**
 * 同步门禁（coverage-check.ts）的独立验证：在一个真实 git 沙箱里制造「改了代码没改套件」。
 */
async function verifyCoverageGate(suiteDir: string, runtime: string): Promise<void> {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "coverage-gate-"));
  const checker = path.join(suiteDir, "coverage-check.ts");
  const run = (): { code: number; output: string } => {
    const args = runtime === "bun" ? [".pi/api-tests/coverage-check.ts"] : [".pi/api-tests/coverage-check.ts"];
    const r = spawnSync(runtime, args, { cwd: repo, encoding: "utf-8", env: cleanEnv({}) });
    return { code: r.status ?? -1, output: `${r.stdout ?? ""}${r.stderr ?? ""}` };
  };
  const git = (...a: string[]) => spawnSync("git", a, { cwd: repo, encoding: "utf-8" });

  try {
    fs.mkdirSync(path.join(repo, ".pi/api-tests/cases"), { recursive: true });
    fs.mkdirSync(path.join(repo, "internal/handler"), { recursive: true });
    fs.copyFileSync(checker, path.join(repo, ".pi/api-tests/coverage-check.ts"));
    fs.writeFileSync(
      path.join(repo, "internal/handler/job.go"),
      'package handler\nconst InfoPath = "/api/job/v1/info"\n',
    );
    fs.writeFileSync(path.join(repo, ".pi/api-tests/cases/job.test.ts"), 'const a = "/api/job/v1/info";\n');
    git("init", "-q", ".");
    git("add", "-A");
    git("-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "init");

    // a) 无改动 → 放行
    let r = run();
    r.code === 0 ? ok("无改动时放行") : bad(`无改动时应放行，实际 ${r.code}\n${r.output}`);

    // b) 只改生产代码 → 必须失败
    fs.appendFileSync(path.join(repo, "internal/handler/job.go"), '\nconst StopPath = "/api/job/v1/stop-job"\n');
    r = run();
    r.code === 1 ? ok("改了生产代码但没改套件 → 门禁失败") : bad(`应失败，实际 ${r.code}\n${r.output}`);
    r.output.includes("/api/job/v1/stop-job") ? ok("缺口清单指出了未覆盖的路由") : bad("缺口清单未指出未覆盖路由");

    // c) 生产代码 + 套件同时改 → 放行（此时无快照 → 退化为字符串启发式）
    fs.appendFileSync(path.join(repo, ".pi/api-tests/cases/job.test.ts"), 'const b = "/api/job/v1/stop-job";\n');
    r = run();
    r.code === 0 ? ok("生产代码与套件同步改动 → 放行") : bad(`应放行，实际 ${r.code}\n${r.output}`);

    // d) 有实测快照，但改动路由在快照里没有真实调用 → 必须失败（规则 4）
    const snapshot = path.join(repo, ".pi/api-tests/reports/route-coverage.json");
    fs.mkdirSync(path.dirname(snapshot), { recursive: true });
    const writeSnapshot = (paths: string[]) =>
      fs.writeFileSync(snapshot, JSON.stringify({ total: paths.length, routes: paths.map((p) => ({ method: "GET", path: p })) }));
    writeSnapshot(["/api/job/v1/info"]);
    r = run();
    r.code === 1 ? ok("实测快照缺失该路由 → 门禁失败") : bad(`应失败，实际 ${r.code}\n${r.output}`);
    r.output.includes("/api/job/v1/stop-job") ? ok("实测缺口清单指出了未覆盖路由") : bad("实测缺口清单未指出未覆盖路由");

    // e) 快照里包含该路由 → 放行
    writeSnapshot(["/api/job/v1/info", "/api/job/v1/stop-job"]);
    r = run();
    r.code === 0 ? ok("实测快照已覆盖改动路由 → 放行") : bad(`应放行，实际 ${r.code}\n${r.output}`);
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------- main
async function main() {
  if (!fs.existsSync(KNOWLEDGE)) throw new Error(`missing ${KNOWLEDGE}`);
  const work = fs.mkdtempSync(path.join(os.tmpdir(), "verify-api-ref-"));
  const suiteDir = path.join(work, ".pi/api-tests");
  const runtimes = availableRuntimes();
  if (runtimes.length === 0) throw new Error("需要 bun 或 node>=22.18（原生类型剥离）");

  try {
    console.log("== 1/5 从知识库抽取参考实现");
    const files = extractReference(work);
    ok(`抽取完成：${files.length} 个 TS 文件`);

    console.log(`== 2/5 绿色路径（完整跑通）`);
    let ok1 = await startServer("ok");
    try {
      for (const runtime of runtimes) {
        const r = await runSuite({ runtime, cwd: suiteDir, port: ok1.port, baselineMode: "off" });
        r.code === 0 ? ok(`${runtime} 退出码 0`) : bad(`${runtime} 期望退出码 0，实际 ${r.code}\n${r.output}`);
      }
    } finally {
      await ok1.close();
    }

    console.log("== 3/5 失败路径：一条用例失败不得中断整轮，报表必须生成");
    const broken = await startServer("broken");
    try {
      const r = await runSuite({ runtime: runtimes[0] as string, cwd: suiteDir, port: broken.port, baselineMode: "off" });
      r.code === 1 ? ok("失败时退出码为 1") : bad(`失败时退出码应为 1，实际 ${r.code}`);
      r.output.includes("Total: 6") && r.output.includes("Failed: 1")
        ? ok("其余用例继续执行（6 条全部跑完，仅 1 条失败）")
        : bad("失败后没有继续执行其余用例");
      fs.existsSync(path.join(suiteDir, "reports/latest-summary.md")) ? ok("报表已生成") : bad("报表未生成");
      // C：失败必须带机器可读错误码，而不是只有自然语言
      r.output.includes("L1_STATUS_MISMATCH")
        ? ok("失败结果带机器可读错误码（L1_STATUS_MISMATCH）")
        : bad(`失败结果缺少错误码\n${r.output}`);
    } finally {
      await broken.close();
    }

    // A：实测路由覆盖快照必须由 runner 落盘，并包含真实调用过的路由
    {
      const okSrv = await startServer("ok");
      try {
        await runSuite({ runtime: runtimes[0] as string, cwd: suiteDir, port: okSrv.port, baselineMode: "off" });
      } finally {
        await okSrv.close();
      }
      const snapPath = path.join(suiteDir, "reports/route-coverage.json");
      if (!fs.existsSync(snapPath)) {
        bad("runner 未落盘 reports/route-coverage.json");
      } else {
        const routes: string[] = (JSON.parse(fs.readFileSync(snapPath, "utf-8")).routes ?? []).map((x: any) => x.path);
        ["/api/job/v1/list", "/api/job/v1/approve-create", "/api/job/v1/info", "/api/job/v1/stop-job"].every((p) =>
          routes.includes(p),
        )
          ? ok("实测路由快照记录了真实调用过的路由")
          : bad(`快照缺少预期路由：${JSON.stringify(routes)}`);

        // 路径参数归一化：/detail/12345 -> /detail/:id（否则生产代码里的模板永远匹配不上）
        const probe = path.join(suiteDir, "norm-probe.ts");
        fs.writeFileSync(
          probe,
          "import { normalizeRoutePath } from './lib/route-coverage.ts';\n" +
            "console.log(normalizeRoutePath('/api/job/v1/detail/12345?x=1'));\n" +
            "console.log(normalizeRoutePath('/api/job/v1/info'));\n",
        );
        const pr = spawnSync(runtimes[0] as string, [probe], { encoding: "utf-8", env: cleanEnv({}) });
        const lines = String(pr.stdout ?? "").trim().split("\n");
        lines[0] === "/api/job/v1/detail/:id"
          ? ok("路径参数已归一为 :id")
          : bad(`路径参数未归一：${JSON.stringify(lines)} ${pr.stderr ?? ""}`);
        lines[1] === "/api/job/v1/info" ? ok("静态路径保持不变") : bad(`静态路径被改写：${JSON.stringify(lines[1])}`);
        fs.rmSync(probe, { force: true });
        fs.readFileSync(path.join(suiteDir, "reports/latest-summary.md"), "utf-8").includes("Route Coverage")
          ? ok("报表含实测路由覆盖表")
          : bad("报表缺少实测路由覆盖表");
      }
    }

    console.log("== 4/5 基线：auto 记录 → verify 抓漂移");
    fs.rmSync(path.join(suiteDir, "baselines"), { recursive: true, force: true });
    const okSrv = await startServer("ok");
    try {
      await runSuite({ runtime: runtimes[0] as string, cwd: suiteDir, port: okSrv.port, baselineMode: "auto" });
      fs.existsSync(path.join(suiteDir, "baselines/job-list.json"))
        ? ok("auto 模式已记录基线")
        : bad("auto 模式未记录基线");
    } finally {
      await okSrv.close();
    }
    const driftSrv = await startServer("drift");
    try {
      const r = await runSuite({ runtime: runtimes[0] as string, cwd: suiteDir, port: driftSrv.port, baselineMode: "verify" });
      r.output.includes("Baseline Drift") ? ok("verify 模式捕获基线漂移") : bad("verify 模式未捕获基线漂移");
      r.code === 1 ? ok("漂移时退出码为 1") : bad(`漂移时退出码应为 1，实际 ${r.code}`);
    } finally {
      await driftSrv.close();
    }
    console.log("== 5/5 同步门禁：改了生产代码但不改套件必须失败");
    await verifyCoverageGate(suiteDir, runtimes[0] as string);
  } finally {
    if (process.env.VERIFY_KEEP === "1") console.log(`\n保留工作区：${work}`);
    else fs.rmSync(work, { recursive: true, force: true });
  }

  console.log("");
  if (failed === 0) {
    console.log("✅ 知识库参考实现可运行（绿色路径 / 失败路径 / 基线对比 / 同步门禁均符合预期）");
    process.exit(0);
  }
  console.log(`❌ 有 ${failed} 项不符合预期，见上方 FAIL 项`);
  process.exit(1);
}

main().catch((err) => {
  console.error(err?.message ?? err);
  process.exit(1);
});
