# Thin Orchestrator (`thin-orchestrator`)

A deterministic multi-agent orchestration extension for [Pi](https://github.com/earendil-works/pi), implementing **Meta's Thin Orchestrator Pattern** (*The Thin Orchestrator: How We Made Our AI Agents More Reliable by Giving the Router Less to Do*, Oct 2026) and **Google's Harness²** on-demand component isolation principles.

## Why a Thin Orchestrator?

Loading all domain knowledge, schemas, and workflow rules into a single "all-knowing" main agent causes context interference and cross-contamination past a context threshold.

`thin-orchestrator` splits orchestration into two layers:
1. **A deterministic TypeScript router (`index.ts` + `runner.ts` + `discovery.ts`)** that performs **zero domain reasoning**. It owns intent routing, pre-flight checks, field gathering, workspace auto-discovery, and post-stage reliability gates.
2. **Isolated Specialist Subagents (`agents/*.md`)**, each running in its own `pi --mode json -p --no-session` subprocess with restricted `--tools` and runtime-mounted domain knowledge files (`knowledge/*.md`).

## Fixed 7-Step Protocol

Every request through `thin_orchestrator` executes Meta's 7-step protocol:

| Step | Name | Type | Responsibility |
| :---: | :--- | :---: | :--- |
| **1** | **Read** | Deterministic | Load workflow state machine (`workflows/*.json`) & specialist definitions (`agents/*.md`) |
| **2** | **Check** | Deterministic | Execute pre-flight shell checks (`preChecks` / `pre_check`) before spending any LLM tokens |
| **3** | **Gather** | Deterministic | Verify `requiredFields` (`required_fields`); prompt interactively via `ctx.ui.select` / `ctx.ui.input` if missing |
| **4** | **Auto-discover** | Deterministic | Infer git repo root, branch, dirty files, language stack, and `go.mod` module path |
| **5** | **Reliability Gate** | Deterministic | Verify project trust and pre-execution safety constraints |
| **6** | **Delegate** | **LLM (Isolated)** | Spawn isolated `pi` subprocesses per stage with runtime-injected `knowledge/*.md` |
| **7** | **Handle** | Deterministic | Run post-stage `gateCmd` (e.g., `git diff --check`), auto-retry on gate failure, and aggregate telemetry |

## Directory Structure

```text
thin-orchestrator/
├── index.ts                 # Extension entry point (registers `thin_orchestrator` tool & `/orchestrate` command)
├── runner.ts                # 7-step protocol engine & isolated subprocess executor
├── discovery.ts             # Specialist, workflow, runtime knowledge, and workspace auto-discovery
├── types.ts                 # TypeScript contracts
├── agents/                  # Standardized 5-section Specialist Subagents
│   ├── scout.md             # Read-only codebase recon & dependency boundary discovery
│   ├── api-fixture-scout.md # Resolves every endpoint input from code / read-only APIs (dependency table + runtime resolution plan)
│   ├── planner.md           # Technical blueprint & step-by-step execution planning
│   ├── implementer.md       # Scoped code implementation with `git diff --check` post-gate
│   ├── api-test-author.md   # Strongly-typed TypeScript HTTP API test authoring & in-loop repair specialist
│   ├── verifier.md          # Deterministic build, test, and static analysis verification
│   └── reviewer.md          # Diff & regression review specialist
├── knowledge/               # Runtime domain knowledge (loaded on demand at Step 6, 0 main-context cost)
│   ├── code-search.md       # Hybrid `rg` + `sgrep` search patterns
│   ├── architecture-rules.md
│   ├── implementation-conventions.md
│   ├── api-test-strategy.md # Four-layer assertions, DAG scenarios, dual-service diffing, safe teardown, secret hygiene
│   ├── verification-checklist.md
│   └── review-checklist.md
└── workflows/               # Deterministic Workflow Templates (reuse specialists without new agent code)
    ├── bugfix.json          # scout -> planner -> implementer -> verifier -> reviewer
    ├── feature.json         # scout -> planner -> implementer -> verifier -> reviewer
    ├── api-test.json        # scout -> inputs -> planner -> api-test-author -> verifier (repair loop) -> reviewer
    ├── scout-and-plan.json  # scout -> planner
    └── review-and-fix.json  # reviewer -> implementer -> verifier
```

## Installation

Symlink or copy the directory into `~/.pi/agent/extensions/`:

```bash
# from repo root:
ln -s "$(pwd)/extensions/thin-orchestrator" ~/.pi/agent/extensions/thin-orchestrator
# or from this directory:
# ln -s "$(pwd)" ~/.pi/agent/extensions/thin-orchestrator
```

Then run `/reload` inside Pi (or test directly with `pi -e ./index.ts`).

## Usage

### 1. Slash Command (`/orchestrate`)

```text
/orchestrate list
/orchestrate bugfix Fix DispatchJob state sync failure after restart
/orchestrate api-test Add regression tests for model versioning and job pin
/orchestrate scout-and-plan Trace how episode duration is calculated in data-service
/orchestrate
```

Running `/orchestrate` without arguments opens an interactive TUI selector to choose a workflow template and enter the task.

### 2. Model-Callable Tool (`thin_orchestrator`)

The model can invoke `thin_orchestrator` in three modes:
- **Workflow Mode**: `{ workflow: "bugfix", task: "..." }`
- **Single Specialist Mode**: `{ agent: "scout", task: "..." }`
- **Parallel Specialist Mode**: `{ tasks: [{ agent: "scout", task: "..." }, { agent: "reviewer", task: "..." }], task: "..." }`

Press `Ctrl+O` on any `thin_orchestrator` result block in Pi's TUI to expand the full 7-step protocol audit, runtime knowledge badges, tool calls, and per-specialist token/cost telemetry.

## 强类型接口测试与全量回归 (`api-test`)

`api-test` 在 Step 3（Gather）**用选择器向用户提问**，把「鉴权方式」「回归范围」「基线对比模式」变成显式输入，而不是让 LLM 猜。生成纯 TypeScript（强类型）测试工程，原生兼容 Node 20+、Bun、tsx，零繁琐构建配置。

```text
recon(scout) -> inputs(api-fixture-scout) -> plan(planner) -> author(api-test-author) -> verify(verifier) -> review(reviewer)
                                                                  ^                          |
                                                                  +------ onGateFail --------+
```

| 产物 | 作用 |
| :--- | :--- |
| `.pi/api-tests/runner.ts` | 唯一入口，执行套件并统计退出码（`bun run .pi/api-tests/runner.ts` 或 `npx tsx .pi/api-tests/runner.ts`） |
| `.pi/api-tests/lib/client.ts` | 强类型 HTTP Client（支持双服务并发、Profile 鉴权切换） |
| `.pi/api-tests/lib/assert.ts` | 四层断言（L1 Status, L2 Type Contract, L3 Deep Diff, L4 Semantic） |
| `.pi/api-tests/lib/diff.ts` | 对象深层结构比较器（支持 Key 过滤与路径屏蔽） |
| `.pi/api-tests/lib/context.ts` | Typed DAG Context 状态机变量传递与 Safe Teardown 逆序清理 |
| `.pi/api-tests/lib/reporter.ts` | 收集结果，控制台输出 ANSI 高亮，自动生成 Markdown 汇总报表 |
| `.pi/api-tests/types/*.ts` | 领域强类型定义（Request DTO & Response 契约） |
| `.pi/api-tests/prep.ts` | **运行时**依赖探活收集（只读请求），在用例前就绪 |
| `.pi/api-tests/cases/*.test.ts` | 独立接口与多状态矩阵用例 |
| `.pi/api-tests/scenarios/*.test.ts` | 完整业务生命周期 DAG 场景链（状态机流转与防漂移闭环） |
| `.pi/api-tests/baselines/*.json` | L3 数据基线（归一化后的黄金数据） |
| `.pi/secrets/api.env.local.json` | 凭据与环境变量，`chmod 600` |

> 名称分层：`.pi/api-tests/` 是**测试套件**（代码产物），`.pi/secrets/` 是**凭据与环境变量**（运行时输入）。唯一硬约束：凭据只能落在 `.pi/secrets/`，绝不能内联进套件源码。

### 前置依赖解析（参数 / 前置调用）

要调用一个接口，可能需要另一个接口先返回的 id、需要枚举常量、或需要前一个用例创建的资源。`api-test` 用两个机制解决，**都不依赖人猜**：

**1. `inputs` stage（`api-fixture-scout`）**

在写用例之前，逐个端点回答「这个接口要什么输入，这些输入从哪来」，并且**真的跑一遍只读请求验证**：

```text
endpoint | 必需输入 | 来源类型 | 来源 | 已验证值 | 备注
POST /v1/orders | product_id | 既有实体 | GET /v1/products?limit=1 → .data[0].id | P-77 | 只读
POST /v1/orders | currency   | 枚举常量 | pkg/order/const.go:22 | CNY     | 代码
POST /v1/orders | sku        | 前序用例 | create-sku case             | S-9     | 用例内创建并清理
POST /v1/orders | account    | 人工提供 | —                           | —       | 需人填
```

来源优先级：**代码**（DTO/validator/枚举/seed）→ **只读接口** → **同套件前序用例** → **人工**。写入类请求在侦察阶段一律禁止。

**2. `.pi/api-tests/prep.ts`（运行时收集）**

环境相关的 id 绝不写进用例，统一在 `prep.ts` 里运行时解析后写入 typed context：

```typescript
// .pi/api-tests/prep.ts — Level 1 只读查询 -> Level 2 即时创建 -> Level 3 降级历史种子
await resolvePrerequisites(client, ctx);

const products = await client.callBase<ApiResponse<Product[]>>('GET', '/v1/products?limit=1');
const productId = products.data?.[0]?.id;
if (!productId) throw new Error('MISSING prerequisite PRODUCT_ID');
ctx.set('productId', productId);
```

用例用 `ctx.require('productId')` 取用（缺失直接抛出并以非 0 退出）。`prep.ts` 拿不到前置数据时**在用例阶段之前整体中止**，不会静默跳过或假装通过。

### 分层验证（按测试点与场景阶段取用）

| 层 | 内容 | 何时必须有 |
| :-- | :--- | :--- |
| L1 | HTTP 状态码（含预期 409/403 业务拦截） | 恒有 |
| L2 | **契约（字段名 + 类型，TypeScript Interface / TypeGuard）** | **恒有，不可省** |
| L3 | 数据基线 diff / 双服务比对（Baseline vs Candidate） | 改动影响业务数据、或启用双服务对比时 |
| L4 | 语义断言与状态机防漂移（Pin 快照防漂移、乐观锁） | 测试点要求具体值、业务状态机流转时 |

### 核心能力升级

1. **DAG 业务场景链与状态机测试（Scenario Chains & Pipeline Journeys）**：
   - 依赖传递：通过 typed context 从上一步响应中提取字段（如 `ctx.set('modelId', res.data.id)`、`ctx.set('version', res.data.version)`），后续步骤直接 `ctx.require('modelId')` 取用，`async/await` 链路内天然共享，无子 shell 变量丢失风险。
   - 三级前置依赖解析（`prep.ts`）：支持「Level 1 动态查 -> Level 2 查不到即时创建 -> Level 3 降级回退历史数据种子」三级自适应探测，确保复杂前置依赖在任何环境稳定就绪。
   - 动作-查询交替门禁（Interleaved Action-Query State Gates）：每个业务写动作之后交替插入对应查询 API，将查询作为状态机流转的校验门禁（如：创建 -> 查详情断言待处理 -> 分发 -> 查列表断言可领 -> 领取 -> 查执行单 -> 上报 -> 查进度断言递增 -> 终止清理）。
   - 优雅安全清理（`ctx.recordRetained` + soft-terminate）：遇到业务设计不可物理删除（无 DELETE 端点）、或状态机已流转阻断删除的资源，执行软终止（stop/close）并记录为保留资源，在报告中汇总保留实体清单，绝不误报测试失败。
   - 状态机闭环与防漂移：覆盖「创建主资源 -> 查详情 -> 并发乐观锁冲突 409（`assertStatus(res, 409)` 视为预期 Pass）-> 正常自增与归档 -> 下游实体 Pin 绑定 -> 防漂移验证（母本升级，下游快照不漂移）-> 逆序安全清理（`try ... finally { await ctx.teardownAll() }`）」。
2. **双服务对比与数据矩阵（Dual-Service Diffing & Dataset Matrix）**：
   - 协议支持：`client.callBase<T>()` 请求基线服务（`API_BASE_URL`），`client.callCandidate<T>()` 请求候选服务（`API_CANDIDATE_URL`），通过 `Assertions.assertDiff(resBase, resCand, { ignoreKeys })` 校验归一化 payload diff。
   - 数据矩阵：支持按 `DATASET=legacy`（存量老数据兼容性）与 `DATASET=new_feature`（新数据特性）矩阵循环对比。
3. **多维鉴权与微服务网关上下文（Auth Profile）**：
   - 支持 `client.switchProfile('admin' | 'tenant_a' | 'tenant_b' | 'unauth')` 在单测内部动态切换调用方身份。
   - 支持注入微服务网关请求头：`tenant-id`、`x-xr-auth-uid`、`x-xr-auth-type`、`x-xr-auth-aut`。
   - 需要动态刷新 Token 时，在 `registerAuthProfile` 的回调里获取后注入即可。
4. **防超时与架构解耦（Anti-Timeout Decoupling）**：
   - 严禁在 scout/inputs/plan 中 dump 大段 Protobuf/Go 源码，统一规范为高密度 Markdown 紧凑表格（< 60–80 行）。
   - Author stage 提示词与 Recon raw dump 解耦，仅接收结构化 Plan 与 Inputs，防止大接口用例生成超时。
5. **规范化可视化报告（Visual Reporter）**：
   - 控制台输出上下结构 JSON 对比（Top: Baseline, Bottom: Candidate）并带 ANSI 语法着色（绿通过、红拦截/差异、青变量提取）。
   - 自动在 `.pi/api-tests/reports/latest-summary.md` 生成规范的 Markdown 汇总表格。

### 数据基线对比（L3）

Gather 阶段收集的 `baseline_mode` 决定行为，`normalizeObject()` 先递归剔除易变字段（`created_at` / `updated_at` / `trace_id` / `sign` / `nonce` 等）再深比较：

| 模式 | 缺基线 | 有基线 | 用途 |
| :--- | :--- | :--- | :--- |
| 自动（默认） | 记录并通过 | diff 对比 | 本地首次建立基线 |
| 强制对比（CI） | **判失败** | diff 对比 | **CI 必须用这个** |
| 重新记录 | 覆盖记录 | 覆盖记录 | 有意的响应变更 |
| 不做对比 | 跳过 | 跳过 | 只跑 L1/L2 |

实现上对应 `Assertions.assertBaseline(res, name, baselineDir, { ignoreKeys }, mode)`；默认忽略列表只覆盖**已知易变键名**，嵌套或领域特有的易变字段通过 `ignoreKeys` 显式追加（如 `['id', 'createdAt', 'pagination.total']`）。

### 执行（本机 / CI 同一条命令）

```bash
cd <repo>
API_BASE_URL=https://api-baseline.internal \
API_CANDIDATE_URL=https://api-candidate.internal \
API_TOKEN="$API_TOKEN" \
API_NO_PROXY='*' \
bun run .pi/api-tests/runner.ts   # 或 npx tsx .pi/api-tests/runner.ts
```

- 退出码 `0` 全绿 / `1` 有回归（契约违约、基线漂移、状态码不符、双服务 payload 差异）。
- 依赖只有 `bun`（或 `node` 20+ / `tsx`）；纯 TypeScript，无构建步骤、无 TTY、无交互、无 LLM、无第三方 npm 包。
- 报告落在 `.pi/api-tests/reports/latest-summary.md`。
- `runner.ts` 无 TTY、无交互、零 token 依赖，退出码即结论：只要 CI 里能拿到套件文件（怎么拿到由仓库自行决定），就能直接当门禁跑。

### Gather 弹窗

```text
1. INPUT   接口 Base URL (基线服务 Baseline)
2. INPUT   候选服务 URL (Candidate，可选对比)
3. SELECT  接口鉴权方式      无鉴权 | 必要请求头 | JWT Token | 两者都要 | 多维网关上下文(Tenant/User/Role)
4. INPUT   鉴权凭据值[secret]  JWT 粘 token / "X-Api-Key: abc" / "tenant_id=t1;user_id=u1" / none
5. SELECT  测试范围          业务全流程状态机链路 | 业务场景链测试 | 双服务对比与数据矩阵 | 仅新增接口用例 | 全量业务场景与接口回归
6. SELECT  基线对比          自动 | 强制对比(CI) | 重新记录 | 不做对比
```

无 UI（`print`/`json`）时除 Base URL 外都走 `default`，因此**无头调用必须显式给 `api_base_url`**。

### 用 `fieldPrompts` 声明式定义 Gather 弹窗

工作流 JSON 里通过 `fieldPrompts` 描述每个必填字段怎么问，引擎（`runner.ts` Step 3）确定性执行：

```json
{
  "requiredFields": [
    "task",
    "api_base_url",
    "api_candidate_url",
    "api_auth",
    "api_auth_value",
    "test_scope",
    "baseline_mode"
  ],
  "fieldPrompts": {
    "api_base_url":      { "title": "[Thin Orchestrator] 接口 Base URL (基线服务 Baseline)", "placeholder": "如 http://127.0.0.1:8080" },
    "api_candidate_url": { "title": "[Thin Orchestrator] 候选服务 URL (Candidate，可选对比)", "default": "none" },
    "api_auth":          { "title": "[Thin Orchestrator] 接口鉴权方式", "options": ["无鉴权", "必要请求头", "JWT Token", "两者都要", "多维网关上下文(Tenant/User/Role)"], "default": "无鉴权" },
    "api_auth_value":    { "title": "[Thin Orchestrator] 鉴权凭据值", "secret": true, "default": "none" },
    "test_scope":        { "title": "[Thin Orchestrator] 测试范围", "options": ["业务全流程状态机链路(Pipeline Journey: Create->Approve->Claim->Execute->Report)", "业务场景链测试(DAG Scenario Chains)", "双服务对比与数据矩阵(Dual-Service Diffing)", "仅新增接口用例", "全量业务场景与接口回归"], "default": "业务全流程状态机链路(Pipeline Journey: Create->Approve->Claim->Execute->Report)" },
    "baseline_mode":     { "title": "[Thin Orchestrator] 数据基线对比（回归对比）", "options": ["自动：无基线则记录，有则对比", "强制对比：缺基线即失败（CI）", "重新记录基线", "不做数据基线对比"], "default": "自动：无基线则记录，有则对比" }
  }
}
```

| 键 | 作用 |
| :--- | :--- |
| `title` | 弹窗标题 |
| `options` | 有值 → `ctx.ui.select` 选择器；无值 → `ctx.ui.input` 文本输入 |
| `placeholder` | 文本输入的提示语 |
| `default` | 无 UI（`print` / `json` / 隔离子进程）时的兜底值 |
| `secret` | `true` 时该值在审计区、进度流、下游 stage 提示词、工具返回结果中一律打码为 `***`（真实值仍传给需要它的那一个 stage） |

字段值通过 `{field:<name>}` 注入 stage 提示词。值缺失且无 `default` 时，Step 3 阻断并列出 `Allowed values`，不消耗任何 LLM token。

### 凭据与安全

- 凭据只落在 `.pi/secrets/api.env.local.json`（`chmod 600`），`runner.ts` 启动时读取它，或直接用环境变量；凭据绝不内联进套件源码。
- `author` 步的确定性 gate 会拦截：`.pi/api-tests/runner.ts` 未生成；`Bearer <长串>` / `API_TOKEN=<值>` 之类的凭据字面量被写进 `.pi/api-tests/` 下的套件源码或仓库的 git diff 中。
- 注意：允许明文输入意味着 token 会进入 `author` 子进程上下文（审计副本已打码），落地文件在仓库工作区内。

### Behaviour change for existing workflows

Because `GATE_STATUS: FAIL` now aborts a stage, `bugfix` / `feature` / `review-and-fix` stop at the verifier instead of continuing to the reviewer when verification fails. That is intentional: a silently-passing verification gate was the previous failure mode. Add an `onGateFail` block to any workflow that should repair instead of abort.
