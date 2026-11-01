# Strongly-Typed TypeScript API Test Strategy — 四层验证 / 场景链 DAG / 双服务对比 / 可视化报告

## 0. 核心原则

**强类型（TypeScript）优先，零黑盒转义，契约即类型，语言级生命周期安全。**

测试套件采用强类型 TypeScript 编写，原生支持 `Node.js 20+`（原生 `fetch` 与 `--experimental-strip-types`）、`Bun`（`bun run` 毫秒级零编译执行）或 `npx tsx`，**无需安装沉重庞杂的外部 npm 构建生态**。

| 层级 | 名称 | 何时必须有 | 失败含义 | TypeScript 实现机制 |
| :-- | :--- | :--- | :--- | :--- |
| **L1** | 状态码 (HTTP Status) | 恒有 | 接口不可用 / 路由未注册 / 预期拦截未触发（如 409 冲突） | `assertStatus(res, expectedCode)` |
| **L2** | 契约 (Schema & Type) | **恒有，不可省** | 响应字段缺失、类型突变破坏微服务或前端调用 | 强类型接口泛型校验 / TypeGuard 验证函数 |
| **L3** | 基线 / 双服务对比 (Diff) | 改动影响业务数据、或开启双服务对比时 | 业务数据在无预期变更的情况下漂移 / 新老版本行为不一致 | `assertDiffServices(resBase, resCand, { ignoreKeys })` / `assertBaseline(res, baselineName)` |
| **L4** | 状态机语义与防漂移 | 测试点要求具体值、乐观锁、版本 Pin 绑定 | 业务逻辑不符 / 乐观锁失效 / 下游快照随母本漂移 | 强类型断言 `res.data.inference_config.model_id === ctx.modelId` |

### 核心能力特性

1. **强类型数据模型与智能提示 (Type Safety)**：请求 Payload 和响应 Response 全部定义为 TS Interface，IDE 自动补全，编译/保存期静态检查，彻底告别字符串引号转义地狱。
2. **DAG Scenario Chains (场景链与状态机)**：通过 typed `TestContext` 在 `async/await` 链路中传递变量（`ctx.modelId = res.data.id`），天然规避 Bash 子 Shell 变量丢失隐患。
3. **Dual-Service Diffing & Dataset Matrix (双服务对比与数据矩阵)**：支持基线服务（`API_BASE_URL`）与候选服务（`API_CANDIDATE_URL`）并发/顺序双发，深层对象递归比对，支持字段黑名单遮罩（如 `created_at`, `updated_at`, `trace_id`）。
4. **Deterministic Safe Teardown (确定性安全资源释放)**：基于语言级 `try ... finally`，测试过程中通过 `ctx.registerTeardown(fn)` 注册清理动作。无论中间哪一步断言失败，`finally` 保证逆序精准清理；对不可删除或处于非终态的实体执行安全软释放（`safeDelete`），记录为保留资源而不引发用例崩溃。
5. **Gateway Auth Profile Switching (多维网关鉴权切换)**：原生支持多租户与微服务网关请求头组合（`tenant-id`, `x-xr-auth-uid`, `x-xr-auth-type`），支持在单测内部通过 `client.switchProfile('admin' | 'tenant_b' | 'unauth')` 动态切换身份。
6. **Visual Reporter (可视化结构化报告)**：控制台输出 ANSI 高亮与上下结构 JSON 差异，自动生成 Markdown 汇总表格至 `.pi/api-tests/reports/latest-summary.md`。

---

## 1. 产物标准目录布局

```text
.pi/api-tests/
├── runner.ts               # 唯一入口，自动发现 cases/ 与 scenarios/（禁止手工维护套件清单），退出码即结论
├── lib/
│   ├── client.ts           # 核心强类型 HTTP Client（支持双服务、鉴权切换、超时控制）
│   ├── route-coverage.ts   # 运行时路由覆盖记录器（覆盖事实来自真实请求，不是人肉声明）
│   ├── failure.ts          # 失败三件套 {code, message, diagnostic} 与 AssertionFailure
│   ├── assert.ts           # L1/L2/L3/L4 断言库（状态码、类型契约、基线对比、语义断言）
│   ├── diff.ts             # 对象深层比较器（支持 Key 过滤、路径屏蔽、可视化 ANSI diff）
│   ├── context.ts          # 强类型 DAG 上下文管理与 Safe Teardown 注册池
│   └── reporter.ts         # 结果收集（自动绑定路由与失败码）与 Markdown 报告生成器
├── types/
│   ├── common.ts           # 通用契约 (ApiResponse<T>, FailureDetail, RouteHit, AuthProfile)
│   └── <module>.ts         # 领域接口请求与响应强类型定义
├── prep.ts                 # 运行时依赖数据只读解析（3-level 探活）
├── cases/
│   └── *.test.ts           # 独立接口用例（每个文件导出唯一 run* 函数）
├── scenarios/
│   └── *.test.ts           # 业务场景链用例（DAG Scenario Chains & 状态机闭环）
├── baselines/
│   └── *.json              # L3 黄金基线数据（归一化后）
├── coverage-allowlist.json # 路由覆盖豁免白名单（可选，每条必须写 reason）
└── reports/
    ├── latest-summary.md   # 运行报告输出（Markdown 格式，含通过率与全量结论表格）
    └── route-coverage.json # 实测路由覆盖快照（coverage-check 的判定依据）
.pi/secrets/
├── api.env.local.json      # 凭据与环境变量，chmod 600（只在此处，绝不内联进套件源码）
└── api.env.local.sh        # 同上（bash 侧）
```

---

## 2. 核心基础设施实现（零三方依赖，开箱即用）

以下核心库位于 `.pi/api-tests/lib/`，纯原生 TypeScript 实现，不引入多余的 npm 依赖包。

### 2.1 通用类型定义：`.pi/api-tests/types/common.ts`

```typescript
export interface ApiResponse<T = any> {
  status: number;
  data: T;
  rawText: string;
  durationMs: number;
  headers: Record<string, string>;
}

export interface ApiErrorResponse {
  code?: number;
  message?: string;
  msg?: string;
  details?: any[];
  [key: string]: any;
}

export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH' | 'HEAD';

/** L3 数据基线对比模式 */
export type BaselineMode = 'auto' | 'verify' | 'record' | 'off';

export interface AuthProfile {
  name: string;
  headers: Record<string, string>;
}

export interface DiffOptions {
  ignoreKeys?: string[];
  ignorePaths?: string[];
}

/** 失败层级：与四层验证一一对应，PREREQ/RUNTIME 为前置解析与运行期崩溃 */
export type FailureLayer = 'PREREQ' | 'L1' | 'L2' | 'L3' | 'L4' | 'RUNTIME';

/** 机器可读错误码：门禁、回环修复与报告按码分派，绝不解析自然语言 */
export type FailureCode =
  | 'PREREQ_UNRESOLVED'
  | 'CONTEXT_MISSING_KEY'
  | 'NETWORK_ERROR'
  | 'L1_STATUS_MISMATCH'
  | 'L2_CONTRACT_VIOLATION'
  | 'L3_DIFF_DRIFT'
  | 'L3_BASELINE_MISSING'
  | 'L3_BASELINE_DRIFT'
  | 'L4_SEMANTIC_MISMATCH'
  | 'SUITE_CRASH'
  | 'UNCLASSIFIED';

/** 失败三件套：code 给机器，message 给人，diagnostic 给定位 */
export interface FailureDetail {
  code: FailureCode;
  message: string;
  diagnostic?: Record<string, unknown>;
}

/** 运行时观测到的一次路由调用（由 client 记录，非人肉声明） */
export interface RouteHit {
  method: HttpMethod | string;
  path: string;
  caseName: string;
  status?: number;
}

export interface TestCaseResult {
  name: string;
  dataset: string;
  status: number;
  expectedStatus: number;
  contractPass: boolean;
  diffPass?: boolean;
  error?: string;
  /** 失败三件套：由 reporter.fail / reporter.suiteCrash 自动填充 */
  failure?: FailureDetail;
  /** 本用例实际打到的路由：由 reporter.addResult 从 RouteCoverage 自动采集 */
  routes?: RouteHit[];
  verdict: 'PASS' | 'FAIL';
}
```

### 2.2 核心客户端：`.pi/api-tests/lib/client.ts`

```typescript
import type { ApiResponse, HttpMethod, AuthProfile } from '../types/common.ts';
import { AssertionFailure } from './failure.ts';
import { RouteCoverage } from './route-coverage.ts';

export class ApiClient {
  public baseUrl: string;
  public candidateUrl?: string;
  private currentHeaders: Record<string, string> = {};
  private authProfiles: Record<string, Record<string, string>> = {};

  constructor(baseUrl: string, candidateUrl?: string) {
    this.baseUrl = baseUrl.replace(/\/+$/, '');
    if (candidateUrl && candidateUrl !== 'none') {
      this.candidateUrl = candidateUrl.replace(/\/+$/, '');
    }
  }

  public registerAuthProfile(name: string, headers: Record<string, string>) {
    this.authProfiles[name] = headers;
  }

  public switchProfile(name: string) {
    if (this.authProfiles[name]) {
      this.currentHeaders = { ...this.authProfiles[name] };
    } else {
      throw new Error(`Auth profile '${name}' not registered`);
    }
  }

  public setHeaders(headers: Record<string, string>) {
    this.currentHeaders = { ...this.currentHeaders, ...headers };
  }

  public async request<T = any>(
    targetBaseUrl: string,
    method: HttpMethod,
    path: string,
    body?: any,
    customHeaders?: Record<string, string>
  ): Promise<ApiResponse<T>> {
    const url = `${targetBaseUrl}${path.startsWith('/') ? path : '/' + path}`;
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      ...this.currentHeaders,
      ...(customHeaders || {}),
    };

    const startTime = Date.now();
    const reqInit: RequestInit = {
      method,
      headers,
    };

    if (body !== undefined && method !== 'GET' && method !== 'HEAD') {
      reqInit.body = typeof body === 'string' ? body : JSON.stringify(body);
    }

    try {
      const res = await fetch(url, reqInit);
      const durationMs = Date.now() - startTime;
      const rawText = await res.text();
      let data: T;
      try {
        data = rawText ? JSON.parse(rawText) : ({} as T);
      } catch {
        data = rawText as any;
      }

      const resHeaders: Record<string, string> = {};
      res.headers.forEach((v, k) => {
        resHeaders[k.toLowerCase()] = v;
      });

      // 覆盖事实：每一次真实发出的请求都被记录，供 coverage-check 实测比对
      RouteCoverage.record(method, path, res.status);

      return {
        status: res.status,
        data,
        rawText,
        durationMs,
        headers: resHeaders,
      };
    } catch (err: any) {
      RouteCoverage.record(method, path, 0);
      throw new AssertionFailure('NETWORK_ERROR', `Network failure calling ${method} ${url}: ${err.message}`, { method, url });
    }
  }

  public async callBase<T = any>(method: HttpMethod, path: string, body?: any, headers?: Record<string, string>): Promise<ApiResponse<T>> {
    return this.request<T>(this.baseUrl, method, path, body, headers);
  }

  /** 未配置 API_CANDIDATE_URL 时退化为单服务（base)，避免"没起第二套服务就全红" */
  public get hasCandidate(): boolean {
    return Boolean(this.candidateUrl);
  }

  public async callCandidate<T = any>(method: HttpMethod, path: string, body?: any, headers?: Record<string, string>): Promise<ApiResponse<T>> {
    return this.request<T>(this.candidateUrl ?? this.baseUrl, method, path, body, headers);
  }
}
```

### 2.2.1 运行时路由覆盖记录：`.pi/api-tests/lib/route-coverage.ts`

覆盖事实必须来自「实际发出的请求」，而不是写测试的人自己填的声明——声明可以撒谎，请求不会。`client` 每次调用都打一条记录，`reporter` 在 `addResult` 时把它绑到当前用例，`runner` 落盘成 `reports/route-coverage.json`。

```typescript
import type { RouteHit } from '../types/common.ts';

/** 数字 / uuid / 长 hash 段统一归一成 :id，便于与生产代码里的路由模板对齐 */
function normalizeSegment(seg: string): string {
  if (/^\d+$/.test(seg)) return ':id';
  if (/^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/.test(seg)) return ':id';
  if (/^[0-9a-fA-F]{16,}$/.test(seg)) return ':id';
  return seg;
}

export function normalizeRoutePath(p: string): string {
  const pathname = p.split('?')[0] ?? '/';
  return pathname.split('/').map((s) => (s === '' ? '' : normalizeSegment(s))).join('/') || '/';
}

/** 进程内单例：接口调用 → 路由记录的唯一点 */
class RouteCoverageStore {
  private hits: RouteHit[] = [];
  private pending: RouteHit[] = [];
  private currentCase = '(prep)';

  public beginCase(name: string) {
    this.currentCase = name;
  }

  public record(method: string, path: string, status?: number) {
    const hit: RouteHit = { method, path: normalizeRoutePath(path), caseName: this.currentCase, status };
    this.hits.push(hit);
    this.pending.push(hit);
  }

  /** 取出自上次 take 以来的调用，供 reporter 绑定到 TestCaseResult */
  public take(): RouteHit[] {
    const taken = this.pending;
    this.pending = [];
    return taken;
  }

  public all(): RouteHit[] {
    return [...this.hits];
  }

  public reset() {
    this.hits = [];
    this.pending = [];
    this.currentCase = '(prep)';
  }
}

export const RouteCoverage = new RouteCoverageStore();
```

要点：`caseName` 默认 `(prep)`（`prep.ts` 的只读探活也计入覆盖）；不想依赖自动切分时，用例开头可显式 `RouteCoverage.beginCase('...')`。

---

### 2.3 断言库、失败码与深层比较器：`.pi/api-tests/lib/assert.ts` & `.pi/api-tests/lib/failure.ts` & `.pi/api-tests/lib/diff.ts`

**`.pi/api-tests/lib/failure.ts`**（失败三件套 + `AssertionFailure`，无任何 import，可被所有层引用）

```typescript
import type { FailureCode, FailureDetail } from '../types/common.ts';

/**
 * 断言失败：带机器可读错误码 + 定位信息。
 * code 供门禁 / 回环修复按类分派，message 供人读，diagnostic 供精确定位（字段路径、期望值、响应片段）。
 */
export class AssertionFailure extends Error {
  code: FailureCode;
  diagnostic: Record<string, unknown>;

  constructor(code: FailureCode, message: string, diagnostic: Record<string, unknown> = {}) {
    super(message);
    this.name = 'AssertionFailure';
    this.code = code;
    this.diagnostic = diagnostic;
  }
}

/** 历史消息前缀 → 错误码：保证任何旧写法/第三方抛错也能落成三件套 */
const LEGACY_PREFIX: Array<[RegExp, FailureCode]> = [
  [/^\[Prerequisite Missing\]/, 'PREREQ_UNRESOLVED'],
  [/^\[Context Error\]/, 'CONTEXT_MISSING_KEY'],
  [/^Network failure calling/, 'NETWORK_ERROR'],
  [/^\[Status Mismatch\]/, 'L1_STATUS_MISMATCH'],
  [/^\[Contract Violation\]/, 'L2_CONTRACT_VIOLATION'],
  [/^\[Dual-Service Diff Drift\]/, 'L3_DIFF_DRIFT'],
  [/^\[Baseline Missing\]/, 'L3_BASELINE_MISSING'],
  [/^\[Baseline Drift\]/, 'L3_BASELINE_DRIFT'],
  [/^\[Semantic Mismatch\]/, 'L4_SEMANTIC_MISMATCH'],
];

/** 任何 throw 都能收敛成三件套：先看类型，再看前缀，最后 UNCLASSIFIED */
export function classifyFailure(err: unknown): FailureDetail {
  if (err instanceof AssertionFailure) {
    return { code: err.code, message: err.message, diagnostic: err.diagnostic };
  }
  const message = err instanceof Error ? err.message : String(err);
  for (const [re, code] of LEGACY_PREFIX) {
    if (re.test(message)) return { code, message };
  }
  return { code: 'UNCLASSIFIED', message };
}
```

**`.pi/api-tests/lib/assert.ts`**（L1/L2/L3/L4 断言，抛出的每一个错误都带错误码）

```typescript
import type { ApiResponse, DiffOptions } from "../types/common.ts";
import { AssertionFailure } from "./failure.ts";
import { deepDiff, normalizeObject } from "./diff.ts";
import * as fs from "node:fs";
import * as path from "node:path";

export class Assertions {
  /** L1 状态码 */
  public static assertStatus(res: ApiResponse, expectedStatus: number, msg?: string) {
    if (res.status !== expectedStatus) {
      throw new AssertionFailure(
        'L1_STATUS_MISMATCH',
        `[Status Mismatch] Expected HTTP ${expectedStatus}, but got ${res.status}. Body: ${res.rawText.slice(0, 300)}${msg ? ' | ' + msg : ''}`,
        { expectedStatus, actualStatus: res.status, bodySnippet: res.rawText.slice(0, 500) },
      );
    }
  }

  /** L2 契约：validator 返回 true 通过，返回 string 作为失败原因 */
  public static assertContract<T>(res: ApiResponse<T>, validator: (data: T) => boolean | string, contractName: string) {
    const verdict = validator(res.data);
    if (verdict !== true) {
      const reason = typeof verdict === 'string' ? verdict : 'Contract condition returned false';
      throw new AssertionFailure('L2_CONTRACT_VIOLATION', `[Contract Violation] ${contractName} failed: ${reason}`, {
        contract: contractName,
        reason,
        bodySnippet: res.rawText.slice(0, 500),
      });
    }
  }

  /** L4 语义断言：具体值、乐观锁、防漂移 */
  public static assertValue(actual: unknown, expected: unknown, field: string) {
    if (actual !== expected) {
      throw new AssertionFailure('L4_SEMANTIC_MISMATCH', `[Semantic Mismatch] ${field}: expected ${String(expected)}, got ${String(actual)}`, {
        field,
        expected,
        actual,
      });
    }
  }

  public static assertDiff(resA: ApiResponse, resB: ApiResponse, options?: DiffOptions, caseName?: string) {
    const { same, diffDesc } = deepDiff(resA.data, resB.data, options);
    if (!same) {
      throw new AssertionFailure('L3_DIFF_DRIFT', `[Dual-Service Diff Drift] ${caseName || 'Case'} responses mismatch:\n${diffDesc}`, {
        caseName: caseName || 'Case',
        diff: diffDesc,
      });
    }
  }

  public static assertBaseline(
    res: ApiResponse,
    baselineName: string,
    baselineDir: string,
    options?: DiffOptions,
    mode: 'verify' | 'record' | 'auto' = 'verify',
  ) {
    if (mode === 'off') return; // 关闭基线对比：不记录、不比较、不报错

    const filePath = path.join(baselineDir, `${baselineName}.json`);
    const normalized = normalizeObject(res.data, options);
    const exists = fs.existsSync(filePath);

    // auto：没有基线则记录；record：强制覆盖；verify：缺基线即失败（CI 语义）
    if (mode === 'record' || (mode === 'auto' && !exists)) {
      fs.mkdirSync(baselineDir, { recursive: true });
      fs.writeFileSync(filePath, JSON.stringify(normalized, null, 2), 'utf-8');
      return;
    }
    if (!exists) {
      throw new AssertionFailure('L3_BASELINE_MISSING', `[Baseline Missing] ${filePath} (mode=${mode})`, { baselineName, filePath, mode });
    }

    const baselineData = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    const { same, diffDesc } = deepDiff(normalized, baselineData);
    if (!same) {
      throw new AssertionFailure('L3_BASELINE_DRIFT', `[Baseline Drift] Response does not match golden baseline ${baselineName}:\n${diffDesc}`, {
        baselineName,
        filePath,
        diff: diffDesc,
      });
    }
  }
}
```

**`.pi/api-tests/lib/diff.ts`**（归一化 + 深层比较，`Assertions` 不在此文件）

```typescript
import type { ApiResponse, DiffOptions } from '../types/common.ts';
import * as fs from 'node:fs';
import * as path from 'node:path';

export function normalizeObject(obj: any, options?: DiffOptions): any {
  if (obj === null || obj === undefined) return obj;
  if (typeof obj !== 'object') return obj;

  const ignoreKeys = new Set([
    'created_at', 'updated_at', 'create_time', 'update_time',
    'createdAt', 'updatedAt', 'timestamp', 'sign', 'nonce',
    'duration_ms', 'trace_id', 'span_id',
    ...(options?.ignoreKeys || [])
  ]);

  if (Array.isArray(obj)) {
    return obj.map(item => normalizeObject(item, options));
  }

  const sorted: Record<string, any> = {};
  const keys = Object.keys(obj).sort();
  for (const k of keys) {
    if (ignoreKeys.has(k)) continue;
    sorted[k] = normalizeObject(obj[k], options);
  }
  return sorted;
}

export function deepDiff(a: any, b: any, options?: DiffOptions): { same: boolean; diffDesc?: string } {
  const normA = normalizeObject(a, options);
  const normB = normalizeObject(b, options);
  const strA = JSON.stringify(normA, null, 2);
  const strB = JSON.stringify(normB, null, 2);

  if (strA === strB) {
    return { same: true };
  }
  return {
    same: false,
    diffDesc: `Baseline:\n${strA}\nCandidate:\n${strB}`
  };
}
```

### 2.4 上下文管理与确定性安全清理：`.pi/api-tests/lib/context.ts`

```typescript
import { AssertionFailure } from './failure.ts';

export class TestContext {
  private store: Map<string, any> = new Map();
  private teardownHandlers: Array<{ name: string; fn: () => Promise<void> }> = [];
  public retainedResources: Array<{ type: string; id: string; reason: string }> = [];

  public set<T>(key: string, value: T) {
    this.store.set(key, value);
  }

  public get<T>(key: string, defaultValue?: T): T {
    return this.store.get(key) ?? defaultValue;
  }

  public require<T>(key: string): T {
    const val = this.store.get(key);
    if (val === undefined || val === null || val === '') {
      throw new AssertionFailure('CONTEXT_MISSING_KEY', `[Context Error] Required variable '${key}' was not set in TestContext`, {
        key,
        knownKeys: [...this.store.keys()],
      });
    }
    return val;
  }

  public registerTeardown(name: string, fn: () => Promise<void>) {
    this.teardownHandlers.push({ name, fn });
  }

  public recordRetained(type: string, id: string, reason: string) {
    this.retainedResources.push({ type, id, reason });
  }

  public async teardownAll() {
    // 逆序执行清理动作
    const handlers = [...this.teardownHandlers].reverse();
    for (const h of handlers) {
      try {
        await h.fn();
      } catch (err: any) {
        console.warn(`[Teardown Warning] Handler '${h.name}' failed (non-blocking): ${err.message}`);
      }
    }
    this.teardownHandlers = [];
  }
}
```

### 2.5 测试汇总与 Markdown 可视化报告器：`.pi/api-tests/lib/reporter.ts`

```typescript
import type { BaselineMode, TestCaseResult } from '../types/common.ts';
import { classifyFailure } from './failure.ts';
import { RouteCoverage } from './route-coverage.ts';
import * as fs from 'node:fs';
import * as path from 'node:path';

export class Reporter {
  private results: TestCaseResult[] = [];
  private reportDir: string;
  /** L3 基线目录与模式：由 runner 统一注入，用例只声明基线名 */
  public readonly baselineDir: string;
  public readonly baselineMode: BaselineMode;

  constructor(reportDir: string, baselineDir?: string, baselineMode: BaselineMode = 'off') {
    this.reportDir = reportDir;
    this.baselineDir = baselineDir ?? path.join(reportDir, '..', 'baselines');
    this.baselineMode = baselineMode;
  }

  /** PASS 快捷记录：自动绑定本用例实际打到的路由 */
  public pass(name: string, dataset: string, meta: { status: number; expectedStatus: number; contractPass?: boolean; diffPass?: boolean }) {
    this.addResult({
      name,
      dataset,
      status: meta.status,
      expectedStatus: meta.expectedStatus,
      contractPass: meta.contractPass ?? true,
      diffPass: meta.diffPass,
      verdict: 'PASS',
    });
  }

  /** FAIL 快捷记录：把任意 throw 收敛成 {code, message, diagnostic} 三件套 */
  public fail(
    name: string,
    dataset: string,
    err: unknown,
    meta: { status?: number; expectedStatus?: number; contractPass?: boolean; diffPass?: boolean } = {},
  ) {
    const failure = classifyFailure(err);
    this.addResult({
      name,
      dataset,
      status: meta.status ?? 0,
      expectedStatus: meta.expectedStatus ?? 0,
      contractPass: meta.contractPass ?? false,
      diffPass: meta.diffPass,
      error: failure.message,
      failure,
      verdict: 'FAIL',
    });
  }

  /** 整个套件文件崩溃：import 失败 / 未导出 run* 函数 / 顶层 throw */
  public suiteCrash(suite: string, err: unknown) {
    const failure = classifyFailure(err);
    this.addResult({
      name: `suite:${suite}`,
      dataset: '-',
      status: 0,
      expectedStatus: 0,
      contractPass: false,
      error: failure.message,
      failure: { ...failure, code: failure.code === 'UNCLASSIFIED' ? 'SUITE_CRASH' : failure.code },
      verdict: 'FAIL',
    });
  }

  public addResult(result: TestCaseResult) {
    // 路由覆盖由 client 侧实测采集，这里只做「本次用例」归属绑定
    const withRoutes: TestCaseResult = { ...result, routes: result.routes ?? RouteCoverage.take() };
    this.results.push(withRoutes);

    const passSymbol = withRoutes.verdict === 'PASS' ? '\x1b[32mPASS\x1b[0m' : '\x1b[31mFAIL\x1b[0m';
    const codeTag = withRoutes.failure ? ` \x1b[90m[${withRoutes.failure.code}]\x1b[0m` : '';
    console.log(`[${passSymbol}] ${withRoutes.name} (HTTP ${withRoutes.status})${codeTag}`);
    if (withRoutes.error) {
      console.error(`       \x1b[31m${withRoutes.error}\x1b[0m`);
      const diag = withRoutes.failure?.diagnostic;
      if (diag && Object.keys(diag).length > 0) {
        console.error(`       \x1b[90m${JSON.stringify(diag).slice(0, 400)}\x1b[0m`);
      }
    }
  }

  /** 落盘实测路由覆盖快照：coverage-check 的判定依据 */
  public writeRouteCoverage(): string {
    fs.mkdirSync(this.reportDir, { recursive: true });
    const routes = RouteCoverage.all().map((h) => ({
      method: h.method,
      path: h.path,
      case: h.caseName,
      status: h.status ?? 0,
    }));
    const file = path.join(this.reportDir, 'route-coverage.json');
    fs.writeFileSync(file, JSON.stringify({ generatedAt: new Date().toISOString(), total: routes.length, routes }, null, 2), 'utf-8');
    return file;
  }

  public generateSummary(baseUrl: string, candidateUrl?: string): boolean {
    const total = this.results.length;
    const passed = this.results.filter(r => r.verdict === 'PASS').length;
    const failed = total - passed;

    const mdLines = [
      '# API Test Execution Summary',
      '',
      `- Execution Date: ${new Date().toISOString()}`,
      `- Base URL: \`${baseUrl}\``,
      `- Candidate URL: \`${candidateUrl || 'none'}\``,
      `- Total Cases: ${total} | Passed: ${passed} | Failed: ${failed}`,
      '',
      '| Case Name | Dataset | Status | Contract | Diff | Failure Code | Verdict |',
      '| :--- | :--- | :--- | :--- | :--- | :--- | :--- |',
    ];

    for (const r of this.results) {
      const contractCol = r.contractPass ? 'PASS' : 'FAIL';
      const diffCol = r.diffPass === undefined ? 'N/A' : (r.diffPass ? 'PASS' : 'FAIL');
      const codeCol = r.failure ? `\`${r.failure.code}\`` : '-';
      const verdictCol = r.verdict === 'PASS' ? '**PASS**' : '**FAIL**';
      mdLines.push(`| ${r.name} | ${r.dataset} | ${r.status} | ${contractCol} | ${diffCol} | ${codeCol} | ${verdictCol} |`);
    }

    // 实测路由覆盖：按 method+path 聚合，失败用例也计入（它确实打到了这个路由）
    const byRoute = new Map<string, { method: string; path: string; cases: Set<string>; calls: number }>();
    for (const r of this.results) {
      for (const hit of r.routes ?? []) {
        const key = `${hit.method} ${hit.path}`;
        const row = byRoute.get(key) ?? { method: String(hit.method), path: hit.path, cases: new Set<string>(), calls: 0 };
        row.cases.add(r.name);
        row.calls += 1;
        byRoute.set(key, row);
      }
    }
    if (byRoute.size > 0) {
      mdLines.push('', '## Route Coverage (runtime observed)', '', '| Method | Route | Cases | Calls |', '| :--- | :--- | :--- | :--- |');
      const sorted = [...byRoute.values()].sort((a, b) => `${a.method} ${a.path}`.localeCompare(`${b.method} ${b.path}`));
      for (const row of sorted) {
        mdLines.push(`| ${row.method} | \`${row.path}\` | ${[...row.cases].join(', ')} | ${row.calls} |`);
      }
    }

    fs.mkdirSync(this.reportDir, { recursive: true });
    const reportPath = path.join(this.reportDir, 'latest-summary.md');
    fs.writeFileSync(reportPath, mdLines.join('\n'), 'utf-8');

    console.log('\n========================================================================================');
    console.log(`API Test Summary: Total: ${total}, Passed: ${passed}, Failed: ${failed}`);
    console.log(`Route coverage: ${byRoute.size} distinct routes observed`);
    console.log(`Report written to: ${reportPath}`);
    console.log('========================================================================================\n');

    return failed === 0;
  }
}
```

---

### 2.6 运行时依赖收集：`.pi/api-tests/prep.ts`

```typescript
import { ApiClient } from './lib/client.ts';
import { TestContext } from './lib/context.ts';
import { AssertionFailure } from './lib/failure.ts';

/** 场景链需要的前置变量（按被测领域增删） */
const REQUIRED_KEYS = ['TASK_ID', 'MODEL_ID', 'MODEL_ACTIVE_VERSION', 'CONFIG_TEMPLATE_ID'] as const;

/** 数字型 id/version 转 number，其余保持字符串 */
function coerce(key: string, raw: string): any {
  return /^\d+$/.test(raw) && /(_ID|_VERSION)$/.test(key) ? Number(raw) : raw;
}

/**
 * 运行时依赖收集（只读）：环境变量 -> 只读接口 -> 明确失败。
 * 绝不写死、绝不编造；拿不到就让套件在用例之前整体失败。
 */
export async function resolvePrerequisites(client: ApiClient, ctx: TestContext): Promise<void> {
  for (const key of REQUIRED_KEYS) {
    const raw = process.env[key]?.trim();
    if (raw) ctx.set(key, coerce(key, raw));
  }

  // 缺模型相关变量时，用只读列表接口补齐
  if (!ctx.get('MODEL_ID')) {
    const res = await client.callBase<any>('GET', '/api/model/v1/list?limit=1');
    const first = res.data?.data?.[0] ?? res.data?.[0];
    if (first?.id !== undefined) {
      ctx.set('MODEL_ID', first.id);
      if (first.active_version !== undefined) ctx.set('MODEL_ACTIVE_VERSION', first.active_version);
      else if (first.version !== undefined) ctx.set('MODEL_ACTIVE_VERSION', first.version);
    }
  }

  const missing = REQUIRED_KEYS.filter((k) => ctx.get(k) === undefined);
  if (missing.length > 0) {
    throw new AssertionFailure(
      'PREREQ_UNRESOLVED',
      `[Prerequisite Missing] ${missing.join(', ')} 无法从环境变量或只读接口解析。` +
        `请通过环境变量或 .pi/secrets/api.env.local.json 提供，禁止写死在用例里。`,
      { missingKeys: missing },
    );
  }
}
```

要点：环境变量优先 → 只读接口补齐 → **仍缺则抛 `[Prerequisite Missing]`**，让套件在用例之前整体失败；绝不写死或编造 id。

### 2.7 套件-代码同步门禁：`.pi/api-tests/coverage-check.ts`

为什么需要它：`verify` 的 pass/fail 只能发现「错」（契约/状态码/基线失配），**发现不了「漏」**。改了接口、加了必填参数、放宽了断言时，旧套件仍然全绿 —— 套件就这样悄悄腐化。

判定链（确定性，无 LLM）：

1. `git diff HEAD` + 未跟踪文件 → 改动集合（排除套件自身、`tests/`、`vendor/`、文档与锁文件）。
2. 生产代码无改动 → 放行。
3. 生产代码有改动、但 `.pi/api-tests/` 无任何改动 → 失败（pass/fail 抓不到「没同步」）。
4. 生产代码有改动、且存在 `reports/route-coverage.json`（`runner` 落盘的实测快照）→ **改动行里新增/修改的路由，若在实测快照里没有任何真实调用，失败**。覆盖事实来自真实请求，不来自人肉声明，也无法靠改测试文件“冒充”已覆盖。
5. 无快照（套件没跑过）→ 退回字符串启发式，仅提示不判定。
6. `coverage-allowlist.json` 显式豁免（每条必须写 `reason`），否则不允许静默放行。

**执行顺序是硬约束**：先 `runner`（产出快照）后 `coverage-check`（消费快照）。反了就只能退化成字符串启发式。

```typescript
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
```

要点：脚本不得依赖任何 npm 包；`git diff --name-only HEAD` + 未跟踪文件构成改动集合；排除套件自身、`tests/`、`vendor/`、`node_modules/`、文档与锁文件；**路由覆盖只认实测快照，不认套件源码里的字符串**（那是声明，不是事实）。

## 3. 标准业务测试用例编写范式

### 3.1 领域契约定义（`.pi/api-tests/types/job.ts`）

```typescript
export interface InferenceConfig {
  model_id: string;
  model_version: number;
  model_name?: string;
  robot_type?: string;
}

export interface CreateJobRequest {
  job_name: string;
  job_type: number;
  flow_type: number;
  task_id?: string;
  config_template_id?: string;
  inference_config?: InferenceConfig;
}

export interface JobDetailResponse {
  job: {
    job_id: string;
    job_name: string;
    status: number;
  };
  inference_config?: InferenceConfig;
}
```

### 3.2 场景链与全生命周期防漂移测试（`.pi/api-tests/scenarios/job_pin.test.ts`）

```typescript
import { ApiClient } from '../lib/client.ts';
import { Assertions } from '../lib/assert.ts';
import { TestContext } from '../lib/context.ts';
import { Reporter } from '../lib/reporter.ts';
import type { CreateJobRequest, JobDetailResponse } from '../types/job.ts';

export async function runJobPinScenario(client: ApiClient, ctx: TestContext, reporter: Reporter) {
  const ts = Date.now();
  let createdJobId = '';

  try {
    // S01: 校验模型过期版本乐观锁拦截 (409)
    const staleReq: CreateJobRequest = {
      job_name: `stale_job_${ts}`,
      job_type: 32,
      flow_type: 1,
      task_id: ctx.require('TASK_ID'),
      inference_config: {
        model_id: ctx.require('MODEL_ID'),
        model_version: 99, // 故意传入不存在/过期版本
      },
    };

    const res409 = await client.callCandidate('POST', '/api/job/v1/approve-create', staleReq);
    try {
      Assertions.assertStatus(res409, 409);
      reporter.pass('S01-stale-model-version-409', 'new_feature', { status: res409.status, expectedStatus: 409 });
    } catch (err) {
      reporter.fail('S01-stale-model-version-409', 'new_feature', err, { status: res409.status, expectedStatus: 409 });
    }

    // S02: 正常建单并固化 Pin 绑定 (200)
    const validReq: CreateJobRequest = {
      job_name: `pin_job_${ts}`,
      job_type: 32,
      flow_type: 1,
      task_id: ctx.require('TASK_ID'),
      config_template_id: ctx.require('CONFIG_TEMPLATE_ID'),
      inference_config: {
        model_id: ctx.require('MODEL_ID'),
        model_version: ctx.require('MODEL_ACTIVE_VERSION'),
      },
    };

    const resCreate = await client.callCandidate<JobDetailResponse>('POST', '/api/job/v1/approve-create', validReq);
    Assertions.assertStatus(resCreate, 200);
    Assertions.assertContract(resCreate, d => Boolean(d.job?.job_id), 'JobCreateContract');
    createdJobId = resCreate.data.job.job_id;
    ctx.set('TEST_JOB_ID', createdJobId);

    // 注册安全清理：测试异常退出也能得到释放
    ctx.registerTeardown('StopCreatedJob', async () => {
      if (createdJobId) {
        await client.callCandidate('POST', '/api/job/v1/stop-job', { job_id: createdJobId });
      }
    });

    reporter.pass('S02-create-job-pinned', 'new_feature', { status: resCreate.status, expectedStatus: 200 });

    // S03: 母本升级为下一版本后，防漂移验证
    // （在主模型修改名称/升级后查询该任务详情）
    const resInfo = await client.callCandidate<JobDetailResponse>('POST', '/api/job/v1/info', { job_id: createdJobId });
    Assertions.assertStatus(resInfo, 200);
    try {
      // L4 语义断言：pin 住的版本必须等于创建时的活跃版本，不得随母本漂移
      Assertions.assertValue(
        resInfo.data.inference_config?.model_version,
        ctx.require<number>('MODEL_ACTIVE_VERSION'),
        'inference_config.model_version',
      );
      reporter.pass('S03-anti-drift-verification', 'new_feature', { status: resInfo.status, expectedStatus: 200 });
    } catch (err) {
      reporter.fail('S03-anti-drift-verification', 'new_feature', err, { status: resInfo.status, expectedStatus: 200 });
    }

  } finally {
    // 语言级保证：无论是成功还是断言抛错，安全清理绝对执行
    await ctx.teardownAll();
  }
}
```

---

### 3.3 单接口回归（契约 + 基线）：`.pi/api-tests/cases/legacy_diff.test.ts`

```typescript
import { ApiClient } from '../lib/client.ts';
import { Assertions } from '../lib/assert.ts';
import { TestContext } from '../lib/context.ts';
import { Reporter } from '../lib/reporter.ts';

/**
 * 单接口回归：契约（L2）+ 数据基线（L3）。
 * 基线模式由 reporter.baselineMode 统一控制，用例只声明基线名。
 */
export async function runLegacyDiffCases(client: ApiClient, _ctx: TestContext, reporter: Reporter) {
  const name = 'job-list-regression';
  let status = 0;
  try {
    const res = await client.callCandidate<any>('GET', '/api/job/v1/list?limit=5');
    status = res.status;
    Assertions.assertStatus(res, 200);
    Assertions.assertContract(res, (d: any) => (Array.isArray(d?.data) ? true : 'data must be an array'), name);
    Assertions.assertBaseline(res, 'job-list', reporter.baselineDir, undefined, reporter.baselineMode);
    reporter.pass(name, 'legacy', {
      status: res.status,
      expectedStatus: 200,
      diffPass: reporter.baselineMode === 'off' ? undefined : true,
    });
  } catch (err) {
    reporter.fail(name, 'legacy', err, { status, expectedStatus: 200, diffPass: false });
  }
}
```

### 3.4 数据集矩阵：`.pi/api-tests/cases/matrix.test.ts`

```typescript
import { ApiClient } from '../lib/client.ts';
import { Assertions } from '../lib/assert.ts';
import { TestContext } from '../lib/context.ts';
import { Reporter } from '../lib/reporter.ts';

/** 数据集矩阵：同一接口在不同 job_type 下契约一致 */
export async function runJobTypesMatrix(client: ApiClient, ctx: TestContext, reporter: Reporter) {
  for (const jobType of [32, 33]) {
    const name = `job_create_type_${jobType}`;
    const dataset = `job_type=${jobType}`;
    const ts = Date.now();
    let status = 0;
    try {
      const res = await client.callCandidate<any>('POST', '/api/job/v1/approve-create', {
        job_name: `matrix_${jobType}_${ts}`,
        job_type: jobType,
        flow_type: 1,
        task_id: ctx.require('TASK_ID'),
        config_template_id: ctx.require('CONFIG_TEMPLATE_ID'),
        inference_config: {
          model_id: ctx.require('MODEL_ID'),
          model_version: ctx.require('MODEL_ACTIVE_VERSION'),
        },
      });
      status = res.status;
      Assertions.assertStatus(res, 200);
      Assertions.assertContract(res, (d: any) => Boolean(d?.job?.job_id) || 'missing job.job_id', name);

      const jobId = res.data?.job?.job_id;
      if (jobId) {
        ctx.registerTeardown(`stop-${name}`, async () => {
          await client.callCandidate('POST', '/api/job/v1/stop-job', { job_id: jobId });
        });
      }

      reporter.pass(name, dataset, { status: res.status, expectedStatus: 200 });
    } catch (err) {
      reporter.fail(name, dataset, err, { status, expectedStatus: 200 });
    }
  }
}
```

要点：用例统一用 `reporter.pass(...)` / `reporter.fail(name, dataset, err, meta)`（**不要**手搓 `addResult` 对象）——只有前者会从 `AssertionFailure` 自动沉淀 `{code, message, diagnostic}` 三件套并绑定实测路由。断言失败只记 FAIL 并继续，**绝不中断整轮、绝不丢报表**。

## 4. 运行入口：`.pi/api-tests/runner.ts`

runner 只做四件事：**自动发现套件** → 跑 `prep` → 逐个跑套件（崩溃只记 FAIL）→ 落盘实测路由快照 + 汇总报表。

**禁止**手工维护套件清单：漏登记一个新 `*.test.ts` 会让报告全绿但实际零覆盖，这是唯一「绿灯是假的」的失败模式，必须由目录扫描从结构上消除。

```typescript
import { ApiClient } from './lib/client.ts';
import { TestContext } from './lib/context.ts';
import { Reporter } from './lib/reporter.ts';
import { resolvePrerequisites } from './prep.ts';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { BaselineMode } from './types/common.ts';

const HERE = path.dirname(fileURLToPath(import.meta.url)); // .pi/api-tests

/** 目录顺序即执行顺序：cases/ 先于 scenarios/，目录内按文件名排序 */
const SUITE_DIRS = ['cases', 'scenarios'];

type SuiteRunner = (client: ApiClient, ctx: TestContext, reporter: Reporter) => Promise<void>;

/** 自动发现：新增用例只要落到 cases/ 或 scenarios/ 就会被执行，无需改任何清单 */
function discoverSuites(): Array<{ name: string; file: string }> {
  const suites: Array<{ name: string; file: string }> = [];
  for (const dir of SUITE_DIRS) {
    const abs = path.join(HERE, dir);
    if (!fs.existsSync(abs)) continue;
    for (const entry of fs.readdirSync(abs).sort()) {
      if (!/\.test\.ts$/.test(entry)) continue;
      suites.push({ name: `${dir}/${entry}`, file: path.join(abs, entry) });
    }
  }
  return suites;
}

/**
 * 套件入口约定：每个 *.test.ts 必须导出且只导出一个 run* 函数。
 * 多个时优先取与文件名对应（job_pin.test.ts -> *JobPin*）的那个，仍歧义则拒绝执行——
 * 静默挑一个比直接失败更危险。
 */
function pickRunFunction(mod: Record<string, unknown>, suiteName: string): SuiteRunner {
  const names = Object.keys(mod).filter((k) => typeof mod[k] === 'function' && /^run[A-Z]/.test(k));
  if (names.length === 0) {
    throw new Error(
      `[Suite Contract] ${suiteName} 未导出 run* 用例函数（当前导出：${Object.keys(mod).join(', ') || '无'}）`,
    );
  }
  if (names.length === 1) return mod[names[0] as string] as SuiteRunner;

  const stem = path
    .basename(suiteName)
    .replace(/\.test\.ts$/, '')
    .split(/[_\-.]/)
    .map((s) => s.charAt(0).toUpperCase() + s.slice(1))
    .join('');
  const matched = names.filter((n) => n.includes(stem));
  if (matched.length === 1) return mod[matched[0] as string] as SuiteRunner;

  throw new Error(
    `[Suite Contract] ${suiteName} 导出了多个 run* 函数（${names.join(', ')}），无法确定入口；请只导出唯一一个 run* 函数`,
  );
}

/** 兼容 Gather 的中文选项、英文枚举与环境变量 */
function normalizeBaselineMode(raw?: string): BaselineMode {
  const v = (raw ?? '').trim();
  if (!v) return 'off';
  if (/verify|强制|缺基线/i.test(v)) return 'verify';
  if (/record|重新记录|重录/i.test(v)) return 'record';
  if (/off|不做|跳过|不对比/i.test(v)) return 'off';
  return 'auto';
}

/** 环境变量 > .pi/secrets/api.env.local.json */
function loadSecrets(): Record<string, string> {
  const file = process.env.API_ENV_FILE || '.pi/secrets/api.env.local.json';
  try {
    return JSON.parse(fs.readFileSync(file, 'utf-8'));
  } catch {
    return {};
  }
}

async function main() {
  const secrets = loadSecrets();
  const cfg = (key: string, fallback?: string) => process.env[key] ?? secrets[key] ?? fallback;

  const baseUrl = cfg('API_BASE_URL');
  if (!baseUrl) throw new Error('[Config] API_BASE_URL is required (env or .pi/secrets/api.env.local.json)');
  const candidateUrl = cfg('API_CANDIDATE_URL', 'none');
  const baselineMode = normalizeBaselineMode(cfg('API_BASELINE_MODE'));

  const client = new ApiClient(baseUrl, candidateUrl);
  const ctx = new TestContext();
  const reporter = new Reporter(path.join(HERE, 'reports'), path.join(HERE, 'baselines'), baselineMode);

  // 1. 加载鉴权配置
  client.registerAuthProfile('admin', {
    'tenant-id': process.env.API_TENANT_ID || '888888',
    'x-xr-auth-uid': process.env.API_UID || '563',
    'x-xr-auth-type': 'jwt',
    'x-xr-auth-sub': 'admin@system',
    'x-xr-auth-aut': 'SYS_ADMIN',
  });
  client.registerAuthProfile('tenant_b', {
    'tenant-id': '999999',
    'x-xr-auth-uid': '99999',
    'x-xr-auth-type': 'jwt',
  });
  client.registerAuthProfile('unauth', {});
  client.switchProfile('admin');

  const suites = discoverSuites();
  console.log(`[Discovery] ${suites.length} 个套件：${suites.map((s) => s.name).join(', ') || '（无）'}`);

  let allPass = false;
  try {
    // 2. 前置依赖解析：只读探活，失败即整体失败（PREREQ_UNRESOLVED）
    await resolvePrerequisites(client, ctx);

    // 3. 逐个套件执行：单套件崩溃只记 FAIL，不拖垮整体
    for (const suite of suites) {
      try {
        const mod = (await import(pathToFileURL(suite.file).href)) as Record<string, unknown>;
        const run = pickRunFunction(mod, suite.name);
        await run(client, ctx, reporter);
      } catch (err) {
        reporter.suiteCrash(suite.name, err);
      }
    }
  } catch (err) {
    reporter.suiteCrash('prep.ts', err);
  } finally {
    // 4. 无论成功/失败都安全清理、落盘实测覆盖快照并输出汇总，退出码即结论
    await ctx.teardownAll();
    reporter.writeRouteCoverage();
    allPass = reporter.generateSummary(baseUrl, client.hasCandidate ? candidateUrl : undefined);
  }

  if (!allPass) process.exit(1);
}

main().catch(err => {
  console.error('[Fatal Execution Error]', err?.message ?? err);
  process.exit(1);
});
```

要点：`discoverSuites()` 是唯一的套件登记处（**不要**在 runner 里写死 `import` + 数组）；`pickRunFunction` 找不到唯一入口时直接失败并列出实际导出名，绝不静默跳过；`reporter.writeRouteCoverage()` 必须在 `finally` 里，失败运行也要留下实测快照，否则 `coverage-check` 无判定依据。

---


## 5. 执行与运行命令

无需配置繁琐的 package.json 或构建脚本，支持现代运行时毫秒级执行：

```bash
# 推荐 1：使用 Bun 运行（毫秒级原生支持 TS）
bun run .pi/api-tests/runner.ts

# 推荐 2：使用 tsx / node 运行
npx tsx .pi/api-tests/runner.ts

# 推荐 3：Node.js 22+ 原生类型剥离运行
node --experimental-strip-types .pi/api-tests/runner.ts
```

### 5.1 运行期硬性约束（已实测）

1. **相对 import 必须带 `.ts` 扩展名**（`from '../lib/client.ts'`），Node 原生类型剥离不做无扩展名补全。
2. **仅类型的 import 必须写 `import type`**，否则 Node 报 `does not provide an export named 'ApiResponse'`。
3. **不要使用构造器参数属性 / `enum` / `namespace`**：类型剥离只擦除类型，会报 `ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX`。
4. **不要使用 `__dirname`**：用 `path.dirname(fileURLToPath(import.meta.url))`。
5. **系统代理会让本机接口全 502**：`http_proxy` 存在时 fetch 打到 `127.0.0.1` 会被代理接收。运行时 `NO_PROXY=127.0.0.1,localhost`，或 `env -u http_proxy -u https_proxy -u HTTP_PROXY -u HTTPS_PROXY`。
6. **`API_BASELINE_MODE`**（`off`/`auto`/`verify`/`record`，也接受 Gather 的中文标签）由 `runner` 统一注入 `Reporter`，用例只声明基线名；`verify` 下基线缺失即失败（CI 语义）。
7. **未配置 `API_CANDIDATE_URL` 时 `callCandidate` 退化为 base**，不会因为"没起第二套服务"而整片全红。
8. **套件必须随代码改动更新**：`verify` 的 gate 先跑 `runner.ts`、再跑 `coverage-check.ts`——生产代码改了而套件没改、或者改动路由没有任何用例真实调用过，都会直接失败并回环到 `author`。
9. **`coverage-check.ts` 必须按知识文件逐字落地**，缺文件同样判定失败（不允许静默跳过门禁）。
10. **套件入口约定**：每个 `cases/*.test.ts` / `scenarios/*.test.ts` **必须导出且只导出一个 `run*` 函数**；runner 自动发现，**禁止**在 runner 里手工维护 `import` + 套件数组。
11. **结果记录只走 `reporter.pass` / `reporter.fail`**（套件崩溃自动走 `reporter.suiteCrash`），不要手搋 `addResult` 对象：只有前者会沉淀 `{code, message, diagnostic}` 三件套并绑定实测路由。
12. **覆盖事实来自真实请求**：`lib/client.ts` 每发一次请求就 `RouteCoverage.record(...)`，`runner` 在 `finally` 里落盘 `reports/route-coverage.json`。不要用“在套件里写一行路由字符串”冒充覆盖。
13. **覆盖豁免必须落到白名单**：确属无需测试的路由，写进 `.pi/api-tests/coverage-allowlist.json` 的 `{pattern, reason}`（空 reason 不算豁免），不允许静默放行。
