---
name: excalidraw-diagram
description: Generate and render Excalidraw diagrams (.excalidraw, .svg, .png) across diverse diagram types (flowcharts, UML class/sequence/state/ER diagrams, swimlanes, system architecture, data pipelines) with selectable visual presets (pastel, dark, blueprint, sketch, uml, minimal) and custom palettes. Use when the user asks to draw UML, flowcharts, sequence diagrams, state machines, architecture topologies, or Excalidraw diagrams.
---

# Excalidraw 多形态图表生成器

每次生成同步输出三份文件：
1. **`.excalidraw`**：Excalidraw v2 原生 JSON，可拖入 excalidraw.com 或 Obsidian Excalidraw 编辑；
2. **`.svg`**：矢量图，包含对应主题字号、UML 箭头 marker、网格或手绘滤镜；
3. **`.png`**：通过 `rsvg-convert` 导出的高清位图。

---

## 1. 按场景选图型与视觉预设（不要千篇一律用卡片网格）

根据用户画的内容选择最贴切的图型和 `preset`，用户指定了风格或配色时直接按用户要求覆盖：

| 场景 | 推荐图型元素 | 推荐 `preset` | 布局方式 |
|---|---|---|---|
| **流程图 / 审批流 / 算法逻辑** | `nodes`（`pill` 起止、`rect` 步骤、`diamond` 判断、`parallelogram` I/O、`cylinder` 存储）+ `groups` 泳道 | `blueprint` / `sketch` / `pastel` | 自上而下（TB）或自左向右（LR）分支流 |
| **UML 类图 / 领域模型 / ER 图** | `nodes`（`shape: "class"`，含 `stereotype`、`attributes`、`methods`，高度自动计算）+ UML 关系箭头 | `uml` / `minimal` | 按继承层次上下排布，聚合/组合左右关联 |
| **UML 时序图 / 接口调用链** | `lifelines`（含 `actor`、`activations` 激活条）+ `fragments`（`alt`/`loop`/`opt`）+ `messages`（同步/异步/返回/自调用） | `blueprint` / `uml` / `dark` | 横向参与者生命线 + 纵向时间轴 |
| **状态机** | `nodes`（`initial` 实心圆、`final` 牛眼圆、`pill`/`ellipse` 状态）+ `edges`（`routing: "curved"` 或 `"orthogonal"`） | `blueprint` / `minimal` | 状态环路或阶段流转 |
| **系统架构 / 微服务拓扑 / 数据管道** | `groups`（分层边界/VPC/泳道）+ `cards` 或 `nodes`（`cylinder`、`hexagon`、`actor`、`note`）+ `configBoxes` | `pastel` / `dark` / `blueprint` | 分层架构、星型拓扑、S 型流水线或自由拓扑 |

### 内置视觉预设（`spec.preset`）
- `pastel`：柔和浅色卡片风（白底、圆角阴影）
- `dark`：深色模式（`#0f172a` 暗蓝黑底、高对比霓虹描边、点阵网格）
- `blueprint`：工程蓝图风（`#f8fafc` 浅灰蓝底、点阵网格、零手绘抖动、小圆角）
- `sketch`：手绘白板风（`#fffdf8` 暖纸底、`hachure` 斜线填充、手绘笔触滤镜）
- `uml`：标准建模风（纯白底、3px 直角、等宽签名、无多余阴影）
- `minimal`：极简黑白灰社论风

### 自由配色与样式覆盖
- 画布级覆盖：`background`（任意 hex）、`grid: true|false`、`roughness: 0|1|2`、`fillStyle: "solid"|"hachure"|"cross-hatch"`、`shadow: true|false`、`fontFamily: "hand"|"sans"|"mono"`。
- 节点/分组级覆盖：任意节点或 `groups` 既可传内置色名（`gray`, `slate`, `zinc`, `green`, `teal`, `cyan`, `blue`, `indigo`, `purple`, `pink`, `orange`, `yellow`, `red`, `dark`, `mono`），也可直接传 `bg`、`stroke`、`text` 自定义 hex 颜色，以及 `rx`、`strokeStyle: "solid"|"dashed"|"dotted"`、`fillStyle`。

---

## 2. 图元与连线速查

详细字段见 `references/excalidraw-spec.md`。核心能力：

### 节点 `shape`（在 `spec.nodes` 中使用）
- `rect`：普通矩形节点（居中标题 + 可选 `sub`）
- `card`：带分隔线与 `items` 列表的模块卡片（不传 `h` 时按条目数自动算高）
- `pill` / `terminator`：胶囊形（起止节点、状态节点）
- `diamond` / `decision`：菱形判断节点
- `ellipse` / `circle`：椭圆或圆形
- `initial` / `final`：UML 状态机起点（实心黑圆）与终点（双层同心圆）
- `cylinder` / `database`：数据库圆柱体
- `parallelogram` / `io`：平行四边形输入输出
- `hexagon` / `prep`：六边形网关/准备节点
- `actor` / `stickman`：UML 小人角色
- `class` / `interface` / `enum` / `entity`：UML 分栏类框（`stereotype`、`title`、`attributes: []`、`methods: []`，不传 `h` 时自动算高）
- `note` / `callout`：折角注释便签
- `text`：纯文本

### 连线 `spec.edges`（支持按节点 `id` 自动算锚点，也兼容旧版 `arrows` 坐标）
```javascript
{
  from: "order",          // 起点节点 id
  to: "repo",             // 终点节点 id
  fromSide: "auto",       // "top" | "bottom" | "left" | "right" | "auto"
  toSide: "auto",
  routing: "orthogonal",  // "straight" | "orthogonal"（折线） | "curved"（贝塞尔曲线）
  strokeStyle: "dashed",  // "solid" | "dashed" | "dotted"
  startArrowhead: "none", // "none" | "arrow" | "open" | "hollow-triangle" | "filled-diamond" | "hollow-diamond" | "circle"
  endArrowhead: "hollow-triangle",
  label: "implements",
  startLabel: "1",        // 起点多重性（UML/ER）
  endLabel: "1..*"        // 终点多重性
}
```

---

## 3. 示例

### 示例 A：UML 类图（`preset: "uml"`）
```javascript
const { DiagramBuilder } = require('/Users/pcong/.pi/agent/skills/excalidraw-diagram/scripts/diagram_generator.js');

new DiagramBuilder({
  preset: "uml",
  title: "订单领域模型 (UML Class Diagram)",
  width: 960,
  height: 540,
  nodes: [
    {
      id: "repo", shape: "class", stereotype: "interface", title: "OrderRepository",
      x: 80, y: 110, w: 260,
      methods: ["+ FindByID(id: string): Order", "+ Save(order: Order): error"]
    },
    {
      id: "order", shape: "class", title: "Order", theme: "blue",
      x: 440, y: 110, w: 260,
      attributes: ["- id: UUID", "- status: OrderStatus"],
      methods: ["+ Pay(): error", "+ Cancel(): void"]
    },
    {
      id: "item", shape: "class", title: "LineItem",
      x: 440, y: 340, w: 260,
      attributes: ["- sku: string", "- qty: int"],
      methods: ["+ Subtotal(): Money"]
    }
  ],
  edges: [
    { from: "order", to: "repo", strokeStyle: "dashed", endArrowhead: "hollow-triangle", label: "implements" },
    { from: "order", to: "item", startArrowhead: "filled-diamond", endArrowhead: "none", startLabel: "1", endLabel: "1..*" }
  ]
}).generate('./docs', 'domain-uml');
```

### 示例 B：UML 时序图（`preset: "blueprint"`）
```javascript
new DiagramBuilder({
  preset: "blueprint",
  title: "支付鉴权与扣款时序图",
  width: 960,
  height: 580,
  lifelines: [
    { id: "user", title: "Client", actor: true, x: 140, activations: [{ startY: 190, endY: 460 }] },
    { id: "api", title: "OrderService", theme: "blue", x: 440, activations: [{ startY: 200, endY: 440 }] },
    { id: "pay", title: "PayGateway", theme: "teal", x: 740, activations: [{ startY: 250, endY: 350 }] }
  ],
  fragments: [
    { operator: "alt", condition: "余额充足", x: 360, y: 225, w: 450, h: 190, dividers: [{ y: 340, condition: "余额不足" }] }
  ],
  messages: [
    { from: "user", to: "api", y: 200, label: "POST /v1/orders/pay" },
    { from: "api", to: "pay", y: 260, label: "Charge(orderId, amount)" },
    { from: "pay", to: "api", y: 315, label: "200 OK (txId)", type: "return" },
    { from: "api", to: "api", y: 370, label: "MarkFailed()", type: "self" },
    { from: "api", to: "user", y: 440, label: "PayResponse", type: "return" }
  ]
}).generate('./docs', 'payment-sequence');
```

### 示例 C：深色泳道流程图（`preset: "dark"` + 自定义配色）
```javascript
new DiagramBuilder({
  preset: "dark",
  title: "异步任务调度流程",
  width: 980,
  height: 520,
  groups: [
    { label: "Worker 泳道", x: 40, y: 100, w: 900, h: 370, theme: "indigo" }
  ],
  nodes: [
    { id: "s", shape: "pill", title: "拉取任务", x: 80, y: 240, w: 130, h: 54, theme: "teal" },
    { id: "chk", shape: "diamond", title: "租约有效?", x: 280, y: 215, w: 150, h: 104, theme: "yellow" },
    { id: "exec", shape: "rect", title: "执行算子", sub: "runner.Run()", x: 510, y: 230, w: 160, h: 74, bg: "#311042", stroke: "#f472b6", text: "#fdf2f8" },
    { id: "db", shape: "cylinder", title: "状态库", sub: "MySQL", x: 750, y: 215, w: 150, h: 104, theme: "cyan" }
  ],
  edges: [
    { from: "s", to: "chk" },
    { from: "chk", to: "exec", label: "是" },
    { from: "exec", to: "db", routing: "orthogonal", label: "落盘" }
  ]
}).generate('./docs', 'worker-flow');
```
