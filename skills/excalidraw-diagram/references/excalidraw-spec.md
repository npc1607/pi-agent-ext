# Excalidraw 生成器字段参考 (`diagram_generator.js`)

## 1. 顶层 `spec` 字段

```javascript
{
  preset: "pastel" | "dark" | "blueprint" | "sketch" | "uml" | "minimal",
  background: "#ffffff",          // 可选，覆盖画布背景色
  grid: true,                     // 可选，是否绘制点阵背景网格
  roughness: 0 | 1 | 2,           // 0 平滑矢量，1 轻手绘，2 强手绘（SVG 开启笔触抖动滤镜）
  fillStyle: "solid" | "hachure", // "hachure" 开启 45° 斜线手绘填充
  shadow: true | false,           // 是否开启卡片投影
  fontFamily: "hand" | "sans" | "mono",
  title: "主标题",                 // 传 "" 可不画标题
  subtitle: "副标题",
  width: 1100,
  height: 720,
  groups: [...],                  // 泳道 / 容器分组框
  nodes: [...],                   // 通用多形态节点（流程图、UML 类、状态机、数据库等）
  cards: [...],                   // 模块要点卡片（与 nodes 兼容）
  edges: [...],                   // 连线（支持 from/to 自动算锚点，也兼容 arrows）
  lifelines: [...],               // 时序图参与者生命线
  fragments: [...],               // 时序图组合片段（alt / loop / opt / par）
  messages: [...],                // 时序图消息
  configBoxes: [...],             // 底部或侧边横幅框
  rawElements: [...]              // 原生 Excalidraw 图元直通
}
```

## 2. 内置主题色名（`theme`）与自定义颜色

- 内置 `theme`：`gray`, `slate`, `zinc`, `green`, `teal`, `cyan`, `blue`, `indigo`, `purple`, `pink`, `orange`, `yellow`, `red`, `dark`, `mono`（在 `preset: "dark"` 下自动切换为深色高对比调色盘）。
- 自定义覆盖：任何节点、分组、横幅都可以直接指定 `bg`、`stroke`、`text`、`lightText`、`line`（hex 颜色值）。

## 3. 节点形态（`nodes[].shape`）

| `shape` | 用途 | 关键字段 |
|---|---|---|
| `rect` | 流程步骤 / 普通组件框 | `id, title, sub, x, y, w, h` |
| `card` | 带虚线分隔与要点列表的模块卡片 | `id, title, sub, items: [], x, y, w, h?`（`h` 可省） |
| `pill` / `terminator` | 流程起止 / 状态节点 | `id, title, x, y, w, h` |
| `diamond` / `decision` | 条件分支判断 | `id, title, sub?, x, y, w, h` |
| `ellipse` / `circle` | 椭圆 / 圆形状态 | `id, title, x, y, w, h` |
| `initial` / `final` | 状态机起点（实心圆）/ 终点（同心圆） | `id, x, y, w` |
| `cylinder` / `database` | 数据库 / 持久化存储 | `id, title, sub?, x, y, w, h` |
| `parallelogram` / `io` | 数据输入 / 输出 | `id, title, x, y, w, h` |
| `hexagon` / `prep` | 网关 / 前置准备节点 | `id, title, x, y, w, h` |
| `actor` / `stickman` | 用例图 / 架构图外部角色 | `id, title, x, y, w` |
| `class` / `interface` / `enum` / `entity` | UML 类框 / ER 实体框 | `id, stereotype?, title, attributes: [], methods: [], x, y, w, h?`（`h` 可省） |
| `note` / `callout` | 折角注释便签 | `id, title/items, x, y, w, h` |
| `text` | 纯文本标签 | `title/text, x, y, fontSize?` |

## 4. 连线与 UML 箭头（`edges` / `arrows`）

- **按节点 ID 自动连线**：`{ from: "nodeA", to: "nodeB", fromSide?: "top"|"bottom"|"left"|"right"|"auto", toSide?: "auto", routing?: "straight"|"orthogonal"|"curved" }`
- **按坐标手动连线**：`{ startX, startY, points: [[0,0], [dx,dy], ...] }`
- **箭头样式（`startArrowhead` / `endArrowhead`）**：
  - `"arrow"`：实心三角箭头（默认终点）
  - `"open"`：开放 V 型箭头（异步调用 / 依赖）
  - `"hollow-triangle"`（别名 `"inherit"`）：空心三角（UML 继承 `extends` / 实现 `implements`）
  - `"filled-diamond"`（别名 `"composition"`）：实心菱形（UML 组合）
  - `"hollow-diamond"`（别名 `"aggregation"`）：空心菱形（UML 聚合）
  - `"circle"`：圆点
  - `"none"`：无箭头
- **多重性与标签**：`label`（连线中部胶囊标签）、`startLabel`（起点侧文本，如 `"1"`）、`endLabel`（终点侧文本，如 `"0..*"`）。

## 5. 时序图专用字段（`lifelines` / `fragments` / `messages`）

- `lifelines`: `{ id, title, x, y?: 115, endY?, actor?: boolean, theme?, activations?: [{ startY, endY }] }`
- `fragments`: `{ operator: "alt"|"opt"|"loop"|"par", condition?: string, x, y, w, h, dividers?: [{ y, condition }] }`
- `messages`: `{ from: "lifelineId", to: "lifelineId", y, label, type?: "sync"|"async"|"return"|"self" }`
