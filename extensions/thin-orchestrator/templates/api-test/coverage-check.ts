/**
 * 套件-代码同步门禁（v2）：把「漏测」从正则猜测升级为实测比对。
 *
 * 判定链（确定性，无 LLM）：
 *   1. git diff --name-only HEAD + 未跟踪文件 → 改动集合（排除套件自身/测试/vendor/文档/锁文件）
 *   2. 生产代码无改动 → 放行
 *   3. 生产代码有改动 且 套件无改动 → FAIL（旧规则，仍然有效）
 *   4. 生产代码有改动 且 有 reports/route-coverage.json（runner 实测快照）：
 *      改动行里新增/修改的路由，若在实测快照里没有任何真实调用 → FAIL
 *   5. 无快照 → 退回字符串启发式（信息，不参与判定）
 *   6. coverage-allowlist.json 显式豁免（必须写 reason）
 *
 * 退出码：0 = 已同步/无需同步；1 = 需要补套件（会被 verify 的 onGateFail 回环到 author）
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url)); // .pi/api-tests
const REPO = path.resolve(HERE, "../..");
const SNAPSHOT = path.join(HERE, "reports", "route-coverage.json");
const ALLOWLIST = path.join(HERE, "coverage-allowlist.json");

const IGNORE = [
  /^\.git\//,
  /^\.pi\/api-tests\//, // 套件自身
  /(^|\/)node_modules\//,
  /(^|\/)vendor\//,
  /(^|\/)generated\//,
  /_test\.go$/,
  /\.test\.(ts|tsx|js)$/,
  /\.spec\.(ts|tsx|js)$/,
  /(^|\/)tests?\//,
  /\.(md|mdx|txt|lock|sum|png|jpg|jpeg|gif|svg|ico|pdf)$/,
  /\.go\.mod$|^go\.sum$/,
];

function git(args: string[]): string[] {
  try {
    return execFileSync("git", args, { cwd: REPO, encoding: "utf-8" })
      .split("\n")
      .map((s) => s.trim())
      .filter(Boolean);
  } catch {
    return [];
  }
}

function changedFiles(): string[] {
  return [...new Set([...git(["diff", "--name-only", "HEAD"]), ...git(["ls-files", "-o", "--exclude-standard"])])];
}

const isSuite = (f: string) => f.startsWith(".pi/api-tests/");
const isIgnored = (f: string) => IGNORE.some((re) => re.test(f));

/** 从源码文本里提取形似路由的字符串字面量 */
function routesIn(source: string): string[] {
  const found = new Set<string>();
  for (const m of source.matchAll(/["'`](\/[A-Za-z0-9_\-./{}:]*\/[A-Za-z0-9_\-./{}:]*)["'`]/g)) {
    const p = m[1] as string;
    const segs = p.split("/").filter(Boolean);
    if (segs.length < 2) continue;
    if (!/(api|v\d+|handler|route|controller|endpoint)/i.test(p)) continue;
    found.add(p);
  }
  return [...found];
}

function readSafe(f: string): string {
  try {
    return fs.readFileSync(path.join(REPO, f), "utf-8");
  } catch {
    return "";
  }
}

/** 路由段归一：参数段与纯数字段视为通配，两侧对称处理 */
const isWild = (s: string) => /^[:{*]/.test(s);
const normSeg = (s: string) => (/^\d+$/.test(s) ? ":id" : s);

function sameRoute(a: string, b: string): boolean {
  const segs = (p: string) => (p.split("?")[0] ?? "").split("/").filter(Boolean);
  const x = segs(a);
  const y = segs(b);
  if (x.length !== y.length) return false;
  return x.every((seg, i) => isWild(seg) || isWild(y[i] as string) || normSeg(seg) === normSeg(y[i] as string));
}

/**
 * 只认「本次 diff 真正新增的行」里的路由。
 * 整个人文件扫一遍会把未改动的路由也算成改动，导致门禁噪声与伪失败。
 */
function changedRoutes(prodChanged: string[]): Array<{ file: string; route: string }> {
  const out: Array<{ file: string; route: string }> = [];
  const untracked = new Set(git(["ls-files", "-o", "--exclude-standard"]));

  // 未跟踪文件不在 git diff 里：整文件纳入
  for (const f of prodChanged) {
    if (!untracked.has(f)) continue;
    for (const route of routesIn(readSafe(f))) out.push({ file: f, route });
  }

  const tracked = prodChanged.filter((f) => !untracked.has(f));
  if (tracked.length === 0) return out;

  let raw = "";
  try {
    raw = execFileSync("git", ["diff", "-U0", "HEAD", "--", ...tracked], {
      cwd: REPO,
      encoding: "utf-8",
      maxBuffer: 32 * 1024 * 1024,
    });
  } catch {
    return out;
  }

  let file = "";
  for (const line of raw.split("\n")) {
    if (line.startsWith("+++ b/")) {
      file = line.slice("+++ b/".length);
      continue;
    }
    if (!line.startsWith("+") || line.startsWith("+++")) continue;
    const text = line.slice(1);
    if (/^\s*(\/\/|#|\*|\/\*)/.test(text)) continue; // 注释里的 URL 不算
    for (const route of routesIn(text)) out.push({ file, route });
  }
  return out;
}

/** 实测快照：null = 套件还没跑过（无快照），[] = 跑过但一条路由都没记录 */
function observedRoutes(): string[] | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(SNAPSHOT, "utf-8"));
    const routes = Array.isArray(parsed?.routes) ? parsed.routes : [];
    return routes.map((r: any) => r?.path).filter((p: any) => typeof p === "string") as string[];
  } catch {
    return null;
  }
}

/** 豁免白名单：每条必须有 reason，空 reason 视为未豁免 */
function allowlistPatterns(): string[] {
  try {
    const parsed = JSON.parse(fs.readFileSync(ALLOWLIST, "utf-8"));
    const routes = Array.isArray(parsed?.routes) ? parsed.routes : [];
    return routes
      .filter((r: any) => typeof r?.pattern === "string" && typeof r?.reason === "string" && r.reason.trim().length > 0)
      .map((r: any) => r.pattern as string);
  } catch {
    return [];
  }
}

function main(): number {
  const changed = changedFiles();
  const prodChanged = changed.filter((f) => !isSuite(f) && !isIgnored(f));
  const suiteChanged = changed.filter(isSuite);

  console.log(`[coverage] 改动文件 ${changed.length} 个：生产代码 ${prodChanged.length}，套件 ${suiteChanged.length}`);

  if (prodChanged.length === 0) {
    console.log("[coverage] 生产代码无改动，跳过同步检查");
    return 0;
  }

  const touched = changedRoutes(prodChanged);

  // 规则 3：改代码不改套件 → 直接失败（pass/fail 发现不了「漏」）
  if (suiteChanged.length === 0) {
    console.error("[coverage] 生产代码有改动，但测试套件（.pi/api-tests/）没有任何改动。");
    console.error("[coverage] 需要按下面的改动补齐/更新用例（pass/fail 无法发现「漏测」）：");
    for (const f of prodChanged.slice(0, 40)) console.error(`  - 改动: ${f}`);
    if (touched.length > 0) {
      console.error("[coverage] 改动涉及的路由：");
      for (const t of touched.slice(0, 40)) console.error(`  - ${t.route}  ← ${t.file}`);
    }
    console.error("[coverage] 补齐后可重跑；若确认无需新增用例，请在 review 里写明理由并更新受影响的断言。");
    return 1;
  }

  // 规则 5：无快照 → 只能给提示
  const observed = observedRoutes();
  if (observed === null) {
    console.log("[coverage] 未找到 .pi/api-tests/reports/route-coverage.json（套件未跑过），跳过实测覆盖比对");
    if (touched.length > 0) {
      console.log("[coverage] 提示：本次改动涉及以下路由（供参考）");
      for (const t of touched.slice(0, 20)) console.log(`  - ${t.route}  ← ${t.file}`);
    }
    return 0;
  }

  // 规则 4：实测覆盖比对 —— 改动的路由必须真的被某条用例调用过
  const allow = allowlistPatterns();
  const uncovered = touched.filter((t) => !observed.some((o) => sameRoute(t.route, o)) && !allow.some((a) => sameRoute(a, t.route)));

  if (uncovered.length === 0) {
    const exempted = touched.filter((t) => !observed.some((o) => sameRoute(t.route, o))).length;
    console.log(
      `[coverage] 改动涉及路由 ${touched.length} 条：实测覆盖 ${touched.length - exempted} 条，白名单豁免 ${exempted} 条（观测到 ${observed.length} 次调用）`,
    );
    return 0;
  }

  const seen = new Set<string>();
  console.error("[coverage] 以下改动路由在实测覆盖快照里没有任何真实调用（漏测，pass/fail 发现不了）：");
  for (const u of uncovered) {
    if (seen.has(u.route)) continue;
    seen.add(u.route);
    if (seen.size > 40) break;
    console.error(`  - ${u.route}  ← ${u.file}`);
  }
  console.error("[coverage] 补一条真实调用该路由的用例后重跑；");
  console.error("[coverage] 若确属无需测试（内部接口/后门/已下线），在 .pi/api-tests/coverage-allowlist.json 写明 {pattern, reason}。");
  return 1;
}

process.exit(main());
