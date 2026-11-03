import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const generatorPath = path.resolve(
  import.meta.dirname,
  "../skills/excalidraw-diagram/scripts/diagram_generator.js",
);
const { DiagramBuilder, PRESETS, PALETTES } = require(generatorPath);

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "excalidraw-test-"));

// 1. Backward compatibility: legacy cards + arrows + configBoxes
{
  const builder = new DiagramBuilder({
    title: "Legacy Architecture",
    subtitle: "Backward compatibility check",
    width: 1000,
    height: 700,
    cards: [
      { title: "Gateway", sub: "pkg/gw", theme: "green", x: 50, y: 120, w: 280, h: 180, items: ["Auth", "Rate limit"] },
      { title: "Core", sub: "pkg/core", theme: "blue", x: 400, y: 120, w: 280, h: 180, items: ["Engine"] },
    ],
    arrows: [
      { startX: 330, startY: 210, points: [[0, 0], [70, 0]], label: "RPC", labelPos: { x: 365, y: 196 } },
    ],
    configBoxes: [
      { title: "Config", theme: "red", x: 50, y: 360, w: 630, h: 150, items: ["**Nacos**: dynamic config"] },
    ],
  });
  const ex = builder.buildExcalidraw();
  const svg = builder.buildSVG();
  assert.equal(ex.type, "excalidraw");
  assert.ok(ex.elements.length >= 6);
  assert.ok(svg.includes("Gateway"));
  assert.ok(svg.includes("Nacos"));
}

// 2. Presets & Custom Styling (dark, blueprint, sketch, uml, minimal)
{
  assert.ok(PRESETS, "PRESETS should be exported");
  for (const presetName of ["pastel", "dark", "blueprint", "sketch", "uml", "minimal"]) {
    assert.ok(PRESETS[presetName], `Missing preset: ${presetName}`);
  }

  const darkBuilder = new DiagramBuilder({
    preset: "dark",
    grid: true,
    title: "Dark Flowchart",
    width: 960,
    height: 540,
    groups: [
      { id: "lane1", label: "Swimlane: Ingestion", x: 40, y: 100, w: 880, h: 380, theme: "indigo", strokeStyle: "dashed" },
    ],
    nodes: [
      { id: "start", shape: "pill", title: "Start", x: 80, y: 220, w: 120, h: 56, theme: "teal" },
      { id: "check", shape: "diamond", title: "Valid?", x: 280, y: 195, w: 150, h: 106, theme: "yellow" },
      { id: "db", shape: "cylinder", title: "Events DB", sub: "PostgreSQL", x: 520, y: 195, w: 160, h: 110, theme: "cyan" },
      { id: "custom", shape: "rect", title: "Custom Hex", x: 740, y: 210, w: 150, h: 76, bg: "#2e1065", stroke: "#c084fc", text: "#f3e8ff", fillStyle: "hachure" },
    ],
    edges: [
      { from: "start", to: "check", label: "input" },
      { from: "check", to: "db", label: "yes", routing: "orthogonal" },
      { from: "db", to: "custom", routing: "curved", strokeStyle: "dashed" },
    ],
  });

  const ex = darkBuilder.buildExcalidraw();
  const svg = darkBuilder.buildSVG();
  assert.equal(ex.appState.viewBackgroundColor, PRESETS.dark.background);
  assert.ok(ex.elements.some((el) => el.type === "diamond"), "Excalidraw should include diamond element");
  assert.ok(ex.elements.some((el) => el.type === "ellipse"), "Excalidraw should include ellipse element");
  assert.ok(svg.includes("Swimlane: Ingestion"), "SVG should render group label");
  assert.ok(svg.includes("Events DB"), "SVG should render cylinder node");
  assert.ok(svg.includes("#2e1065"), "SVG should apply custom hex bg");
}

// 3. UML Class Diagram (compartments + hollow-triangle / composition / aggregation arrowheads + multiplicity)
{
  const umlBuilder = new DiagramBuilder({
    preset: "uml",
    title: "Order Domain Model",
    width: 1000,
    height: 600,
    nodes: [
      {
        id: "repo",
        shape: "class",
        stereotype: "interface",
        title: "OrderRepository",
        x: 80,
        y: 120,
        w: 260,
        attributes: [],
        methods: ["+ FindByID(id: string): Order", "+ Save(order: Order): error"],
      },
      {
        id: "order",
        shape: "class",
        title: "Order",
        x: 440,
        y: 120,
        w: 260,
        attributes: ["- id: UUID", "- status: OrderStatus", "- createdAt: Time"],
        methods: ["+ Pay(): error", "+ Cancel(): void"],
      },
      {
        id: "item",
        shape: "class",
        title: "LineItem",
        x: 440,
        y: 380,
        w: 260,
        attributes: ["- sku: string", "- qty: int"],
        methods: ["+ Subtotal(): Money"],
      },
    ],
    edges: [
      { from: "order", to: "repo", strokeStyle: "dashed", endArrowhead: "hollow-triangle", label: "implements" },
      { from: "order", to: "item", startArrowhead: "filled-diamond", endArrowhead: "none", startLabel: "1", endLabel: "1..*" },
    ],
  });

  const ex = umlBuilder.buildExcalidraw();
  const svg = umlBuilder.buildSVG();
  assert.ok(svg.includes("&lt;&lt;interface&gt;&gt;") || svg.includes("«interface»"), "Should render UML stereotype");
  assert.ok(svg.includes("+ FindByID(id: string): Order"), "Should render UML methods");
  assert.ok(svg.includes("1..*"), "Should render multiplicity endLabel");
  assert.ok(svg.includes("arrow-hollow-triangle"), "Should include hollow-triangle UML marker");
  assert.ok(svg.includes("arrow-filled-diamond"), "Should include filled-diamond UML marker");
  assert.ok(ex.elements.some((e) => e.text && e.text.includes("OrderRepository")));
}

// 4. UML Sequence Diagram (lifelines, activations, fragments, messages)
{
  const seqBuilder = new DiagramBuilder({
    preset: "blueprint",
    title: "Payment Sequence",
    width: 960,
    height: 620,
    lifelines: [
      { id: "client", title: "Client", actor: true, x: 140, activations: [{ startY: 190, endY: 460 }] },
      { id: "api", title: "OrderAPI", x: 440, activations: [{ startY: 200, endY: 440 }] },
      { id: "gateway", title: "PayGateway", x: 740, activations: [{ startY: 250, endY: 360 }] },
    ],
    fragments: [
      { operator: "alt", condition: "balance sufficient", x: 360, y: 230, w: 460, h: 190, dividers: [{ y: 340, condition: "insufficient" }] },
    ],
    messages: [
      { from: "client", to: "api", y: 200, label: "POST /pay" },
      { from: "api", to: "gateway", y: 260, label: "Charge(amount)" },
      { from: "gateway", to: "api", y: 320, label: "200 OK", type: "return" },
      { from: "api", to: "api", y: 380, label: "UpdateStatus(PAID)", type: "self" },
      { from: "api", to: "client", y: 440, label: "Receipt", type: "return" },
    ],
  });

  const out = seqBuilder.generate(tmpDir, "seq-test");
  assert.ok(fs.existsSync(out.excalidrawPath));
  assert.ok(fs.existsSync(out.svgPath));
  const svg = fs.readFileSync(out.svgPath, "utf-8");
  assert.ok(svg.includes("OrderAPI"));
  assert.ok(svg.includes("POST /pay"));
  assert.ok(svg.includes("balance sufficient"));
}

fs.rmSync(tmpDir, { recursive: true, force: true });
console.log("ALL EXCALIDRAW GENERATOR TESTS PASSED");
