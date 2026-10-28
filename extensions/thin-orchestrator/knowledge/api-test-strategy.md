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
├── runner.ts               # 唯一测试入口，支持 bun run / npx tsx / node，退出码即结论
├── lib/
│   ├── client.ts           # 核心强类型 HTTP Client（支持双服务、鉴权切换、超时控制）
│   ├── assert.ts           # L1/L2/L3/L4 断言库（状态码、类型契约、基线对比）
│   ├── diff.ts             # 对象深层比较器（支持 Key 过滤、路径屏蔽、可视化 ANSI diff）
│   ├── context.ts          # 强类型 DAG 上下文管理与 Safe Teardown 注册池
│   └── reporter.ts         # 测试结果收集器与 Markdown 报告生成器
├── types/
│   ├── common.ts           # 通用契约 (ApiResponse<T>, ErrorResponse, AuthProfile)
│   └── <module>.ts         # 领域接口请求与响应强类型定义
├── prep.ts                 # 运行时依赖数据只读解析（3-level 探活）
├── cases/
│   └── *.test.ts           # 独立接口用例
├── scenarios/
│   └── *.test.ts           # 业务场景链用例（DAG Scenario Chains & 状态机闭环）
├── baselines/
│   └── *.json              # L3 黄金基线数据（归一化后）
└── reports/
    └── latest-summary.md   # 运行报告输出（Markdown 格式，含通过率与全量结论表格）
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

export interface AuthProfile {
  name: string;
  headers: Record<string, string>;
}

export interface DiffOptions {
  ignoreKeys?: string[];
  ignorePaths?: string[];
}

export interface TestCaseResult {
  name: string;
  dataset: string;
  status: number;
  expectedStatus: number;
  contractPass: boolean;
  diffPass?: boolean;
  error?: string;
  verdict: 'PASS' | 'FAIL';
}
```

### 2.2 核心客户端：`.pi/api-tests/lib/client.ts`

```typescript
import { ApiResponse, HttpMethod, AuthProfile } from '../types/common';

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

      return {
        status: res.status,
        data,
        rawText,
        durationMs,
        headers: resHeaders,
      };
    } catch (err: any) {
      throw new Error(`Network failure calling ${method} ${url}: ${err.message}`);
    }
  }

  public async callBase<T = any>(method: HttpMethod, path: string, body?: any, headers?: Record<string, string>): Promise<ApiResponse<T>> {
    return this.request<T>(this.baseUrl, method, path, body, headers);
  }

  public async callCandidate<T = any>(method: HttpMethod, path: string, body?: any, headers?: Record<string, string>): Promise<ApiResponse<T>> {
    if (!this.candidateUrl) {
      throw new Error('API_CANDIDATE_URL is not configured');
    }
    return this.request<T>(this.candidateUrl, method, path, body, headers);
  }
}
```

### 2.3 断言库与深层比较器：`.pi/api-tests/lib/assert.ts` & `.pi/api-tests/lib/diff.ts`

```typescript
import { ApiResponse, DiffOptions } from '../types/common';
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

export class Assertions {
  public static assertStatus(res: ApiResponse, expectedStatus: number, msg?: string) {
    if (res.status !== expectedStatus) {
      throw new Error(`[Status Mismatch] Expected HTTP ${expectedStatus}, but got ${res.status}. Body: ${res.rawText.slice(0, 300)}`);
    }
  }

  public static assertContract<T>(res: ApiResponse<T>, validator: (data: T) => boolean | string, contractName: string) {
    const verdict = validator(res.data);
    if (verdict !== true) {
      const reason = typeof verdict === 'string' ? verdict : 'Contract condition returned false';
      throw new Error(`[Contract Violation] ${contractName} failed: ${reason}`);
    }
  }

  public static assertDiff(resA: ApiResponse, resB: ApiResponse, options?: DiffOptions, caseName?: string) {
    const { same, diffDesc } = deepDiff(resA.data, resB.data, options);
    if (!same) {
      throw new Error(`[Dual-Service Diff Drift] ${caseName || 'Case'} responses mismatch:\n${diffDesc}`);
    }
  }

  public static assertBaseline(res: ApiResponse, baselineName: string, baselineDir: string, options?: DiffOptions, mode: 'verify' | 'record' = 'verify') {
    const filePath = path.join(baselineDir, `${baselineName}.json`);
    const normalized = normalizeObject(res.data, options);

    if (mode === 'record' || !fs.existsSync(filePath)) {
      fs.mkdirSync(baselineDir, { recursive: true });
      fs.writeFileSync(filePath, JSON.stringify(normalized, null, 2), 'utf-8');
      return;
    }

    const baselineData = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    const { same, diffDesc } = deepDiff(normalized, baselineData);
    if (!same) {
      throw new Error(`[Baseline Drift] Response does not match golden baseline ${baselineName}:\n${diffDesc}`);
    }
  }
}
```

### 2.4 上下文管理与确定性安全清理：`.pi/api-tests/lib/context.ts`

```typescript
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
      throw new Error(`[Context Error] Required variable '${key}' was not set in TestContext`);
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
import { TestCaseResult } from '../types/common';
import * as fs from 'node:fs';
import * as path from 'node:path';

export class Reporter {
  private results: TestCaseResult[] = [];
  private reportDir: string;

  constructor(reportDir: string) {
    this.reportDir = reportDir;
  }

  public addResult(result: TestCaseResult) {
    this.results.push(result);
    const passSymbol = result.verdict === 'PASS' ? '\x1b[32mPASS\x1b[0m' : '\x1b[31mFAIL\x1b[0m';
    console.log(`[${passSymbol}] ${result.name} (HTTP ${result.status})`);
    if (result.error) {
      console.error(`       \x1b[31m${result.error}\x1b[0m`);
    }
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
      '| Case Name | Dataset | Status | Contract | Diff | Verdict |',
      '| :--- | :--- | :--- | :--- | :--- | :--- |',
    ];

    for (const r of this.results) {
      const contractCol = r.contractPass ? 'PASS' : 'FAIL';
      const diffCol = r.diffPass === undefined ? 'N/A' : (r.diffPass ? 'PASS' : 'FAIL');
      const verdictCol = r.verdict === 'PASS' ? '**PASS**' : '**FAIL**';
      mdLines.push(`| ${r.name} | ${r.dataset} | ${r.status} | ${contractCol} | ${diffCol} | ${verdictCol} |`);
    }

    fs.mkdirSync(this.reportDir, { recursive: true });
    const reportPath = path.join(this.reportDir, 'latest-summary.md');
    fs.writeFileSync(reportPath, mdLines.join('\n'), 'utf-8');

    console.log('\n========================================================================================');
    console.log(`API Test Summary: Total: ${total}, Passed: ${passed}, Failed: ${failed}`);
    console.log(`Report written to: ${reportPath}`);
    console.log('========================================================================================\n');

    return failed === 0;
  }
}
```

---

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
import { ApiClient } from '../lib/client';
import { Assertions } from '../lib/assert';
import { TestContext } from '../lib/context';
import { Reporter } from '../lib/reporter';
import { CreateJobRequest, JobDetailResponse } from '../types/job';

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
      reporter.addResult({
        name: 'S01-stale-model-version-409',
        dataset: 'new_feature',
        status: res409.status,
        expectedStatus: 409,
        contractPass: true,
        verdict: 'PASS',
      });
    } catch (err: any) {
      reporter.addResult({
        name: 'S01-stale-model-version-409',
        dataset: 'new_feature',
        status: res409.status,
        expectedStatus: 409,
        contractPass: false,
        error: err.message,
        verdict: 'FAIL',
      });
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

    reporter.addResult({
      name: 'S02-create-job-pinned',
      dataset: 'new_feature',
      status: resCreate.status,
      expectedStatus: 200,
      contractPass: true,
      verdict: 'PASS',
    });

    // S03: 母本升级为下一版本后，防漂移验证
    // （在主模型修改名称/升级后查询该任务详情）
    const resInfo = await client.callCandidate<JobDetailResponse>('POST', '/api/job/v1/info', { job_id: createdJobId });
    Assertions.assertStatus(resInfo, 200);
    const pinnedVersion = resInfo.data.inference_config?.model_version;
    const expectedVersion = ctx.require<number>('MODEL_ACTIVE_VERSION');

    if (pinnedVersion === expectedVersion) {
      reporter.addResult({
        name: 'S03-anti-drift-verification',
        dataset: 'new_feature',
        status: resInfo.status,
        expectedStatus: 200,
        contractPass: true,
        verdict: 'PASS',
      });
    } else {
      reporter.addResult({
        name: 'S03-anti-drift-verification',
        dataset: 'new_feature',
        status: resInfo.status,
        expectedStatus: 200,
        contractPass: false,
        error: `Job snapshot drifted! expected version ${expectedVersion}, got ${pinnedVersion}`,
        verdict: 'FAIL',
      });
    }

  } finally {
    // 语言级保证：无论是成功还是断言抛错，安全清理绝对执行
    await ctx.teardownAll();
  }
}
```

---

## 4. 运行入口：`.pi/api-tests/runner.ts`

```typescript
import { ApiClient } from './lib/client';
import { TestContext } from './lib/context';
import { Reporter } from './lib/reporter';
import { resolvePrerequisites } from './prep';
import { runLegacyDiffCases } from './cases/legacy_diff.test';
import { runJobTypesMatrix } from './cases/matrix.test';
import { runJobPinScenario } from './scenarios/job_pin.test';
import * as fs from 'node:fs';
import * as path from 'node:path';

async function main() {
  const baseUrl = process.env.API_BASE_URL || 'http://127.0.0.1:18001';
  const candidateUrl = process.env.API_CANDIDATE_URL || 'http://127.0.0.1:18002';

  const client = new ApiClient(baseUrl, candidateUrl);
  const ctx = new TestContext();
  const reporter = new Reporter(path.join(__dirname, 'reports'));

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

  // 2. 运行时只读探活收集
  await resolvePrerequisites(client, ctx);

  // 3. 执行单用例与双服务回归对比
  await runLegacyDiffCases(client, ctx, reporter);

  // 4. 执行多任务类型矩阵校验
  await runJobTypesMatrix(client, ctx, reporter);

  // 5. 执行端到端状态机防漂移场景链
  await runJobPinScenario(client, ctx, reporter);

  // 6. 输出汇总报表，决定进程退出码
  const allPass = reporter.generateSummary(baseUrl, candidateUrl);
  if (!allPass) {
    process.exit(1);
  }
}

main().catch(err => {
  console.error('[Fatal Execution Error]', err);
  process.exit(1);
});
```

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
