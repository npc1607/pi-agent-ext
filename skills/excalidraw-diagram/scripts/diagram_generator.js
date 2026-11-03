#!/usr/bin/env node

/**
 * Universal Excalidraw Diagram Generator
 *
 * Supports:
 * - System architecture & data pipelines (cards, containers/groups, config banners)
 * - Flowcharts & state machines (rect, pill, diamond, parallelogram, hexagon, cylinder, state initial/final)
 * - UML Class / Interface / ER diagrams (compartment boxes, stereotypes, inheritance/composition/aggregation arrows, multiplicity)
 * - UML Sequence diagrams (lifelines, actors, activation bars, alt/loop/opt fragments, sync/async/return/self messages)
 * - Freeform visual presets (pastel, dark, blueprint, sketch, uml, minimal) + arbitrary custom hex colors & fill styles
 *
 * Generates:
 * 1. <name>.excalidraw (Official Excalidraw JSON v2)
 * 2. <name>.svg (Vector graphic with preset-aware typography, markers, hachure/sketch patterns)
 * 3. <name>.png (High-resolution bitmap via rsvg-convert if available)
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const PALETTES = {
  gray:   { bg: '#f8f9fa', stroke: '#868e96', text: '#212529', lightText: '#6c757d', line: '#dee2e6' },
  slate:  { bg: '#f1f5f9', stroke: '#475569', text: '#0f172a', lightText: '#64748b', line: '#cbd5e1' },
  zinc:   { bg: '#f4f4f5', stroke: '#52525b', text: '#18181b', lightText: '#71717a', line: '#d4d4d8' },
  green:  { bg: '#ebfbee', stroke: '#0ca678', text: '#087f5b', lightText: '#495057', line: '#b2f2bb' },
  teal:   { bg: '#e6fcf5', stroke: '#099268', text: '#087f5b', lightText: '#495057', line: '#96f2d7' },
  cyan:   { bg: '#e3fafc', stroke: '#0c8599', text: '#0b7285', lightText: '#495057', line: '#99e9f2' },
  blue:   { bg: '#e7f5ff', stroke: '#1971c2', text: '#1864ab', lightText: '#495057', line: '#a5d8ff' },
  indigo: { bg: '#edf2ff', stroke: '#4263eb', text: '#364fc7', lightText: '#495057', line: '#bac8ff' },
  purple: { bg: '#f3f0ff', stroke: '#7048e8', text: '#5f3dc4', lightText: '#495057', line: '#d0bfff' },
  pink:   { bg: '#fff0f6', stroke: '#d6336c', text: '#a61e4d', lightText: '#495057', line: '#fcc2d7' },
  orange: { bg: '#fff4e6', stroke: '#e8590c', text: '#d9480f', lightText: '#495057', line: '#ffc078' },
  yellow: { bg: '#fff9db', stroke: '#f08c00', text: '#e67700', lightText: '#495057', line: '#ffec99' },
  red:    { bg: '#fff5f5', stroke: '#e03131', text: '#c92a2a', lightText: '#495057', line: '#ffc9c9' },
  dark:   { bg: '#f1f3f5', stroke: '#343a40', text: '#212529', lightText: '#495057', line: '#ced4da' },
  mono:   { bg: '#ffffff', stroke: '#18181b', text: '#09090b', lightText: '#52525b', line: '#e4e4e7' }
};

const DARK_PALETTES = {
  gray:   { bg: '#1e293b', stroke: '#94a3b8', text: '#f1f5f9', lightText: '#94a3b8', line: '#334155' },
  slate:  { bg: '#1e293b', stroke: '#64748b', text: '#f8fafc', lightText: '#94a3b8', line: '#334155' },
  zinc:   { bg: '#27272a', stroke: '#a1a1aa', text: '#fafafa', lightText: '#a1a1aa', line: '#3f3f46' },
  green:  { bg: '#064e3b', stroke: '#34d399', text: '#ecfdf5', lightText: '#a7f3d0', line: '#065f46' },
  teal:   { bg: '#134e4a', stroke: '#2dd4bf', text: '#f0fdfa', lightText: '#99f6e4', line: '#115e59' },
  cyan:   { bg: '#164e63', stroke: '#22d3ee', text: '#ecfeff', lightText: '#a5f3fc', line: '#155e75' },
  blue:   { bg: '#1e3a8a', stroke: '#60a5fa', text: '#eff6ff', lightText: '#bfdbfe', line: '#1d4ed8' },
  indigo: { bg: '#312e81', stroke: '#818cf8', text: '#eef2ff', lightText: '#c7d2fe', line: '#3730a3' },
  purple: { bg: '#3b0764', stroke: '#c084fc', text: '#faf5ff', lightText: '#e9d5ff', line: '#581c87' },
  pink:   { bg: '#500724', stroke: '#f472b6', text: '#fdf2f8', lightText: '#fbcfe8', line: '#831843' },
  orange: { bg: '#431407', stroke: '#fb923c', text: '#fff7ed', lightText: '#fed7aa', line: '#7c2d12' },
  yellow: { bg: '#422006', stroke: '#facc15', text: '#fefce8', lightText: '#fef08a', line: '#713f12' },
  red:    { bg: '#450a0a', stroke: '#f87171', text: '#fef2f2', lightText: '#fecaca', line: '#7f1d1d' },
  dark:   { bg: '#090d16', stroke: '#475569', text: '#e2e8f0', lightText: '#94a3b8', line: '#1e293b' },
  mono:   { bg: '#18181b', stroke: '#e4e4e7', text: '#fafafa', lightText: '#a1a1aa', line: '#3f3f46' }
};

const PRESETS = {
  pastel: {
    name: 'pastel',
    background: '#ffffff',
    titleColor: '#1e1e1e',
    subtitleColor: '#495057',
    bodyColor: '#2b2b2b',
    edgeColor: '#495057',
    tagBg: '#f1f3f5',
    tagText: '#495057',
    defaultTheme: 'blue',
    roughness: 1,
    fillStyle: 'solid',
    fontFamily: 1,
    rx: 12,
    shadow: true,
    grid: false,
    dark: false
  },
  dark: {
    name: 'dark',
    background: '#0f172a',
    titleColor: '#f8fafc',
    subtitleColor: '#94a3b8',
    bodyColor: '#e2e8f0',
    edgeColor: '#94a3b8',
    tagBg: '#1e293b',
    tagText: '#e2e8f0',
    defaultTheme: 'blue',
    roughness: 0,
    fillStyle: 'solid',
    fontFamily: 2,
    rx: 10,
    shadow: true,
    grid: true,
    dark: true
  },
  blueprint: {
    name: 'blueprint',
    background: '#f8fafc',
    titleColor: '#0f172a',
    subtitleColor: '#475569',
    bodyColor: '#1e293b',
    edgeColor: '#334155',
    tagBg: '#e2e8f0',
    tagText: '#0f172a',
    defaultTheme: 'slate',
    roughness: 0,
    fillStyle: 'solid',
    fontFamily: 2,
    rx: 6,
    shadow: false,
    grid: true,
    dark: false
  },
  sketch: {
    name: 'sketch',
    background: '#fffdf8',
    titleColor: '#1c1917',
    subtitleColor: '#57534e',
    bodyColor: '#292524',
    edgeColor: '#44403c',
    tagBg: '#f5f5f4',
    tagText: '#292524',
    defaultTheme: 'orange',
    roughness: 2,
    fillStyle: 'hachure',
    fontFamily: 1,
    rx: 8,
    shadow: false,
    grid: false,
    dark: false
  },
  uml: {
    name: 'uml',
    background: '#ffffff',
    titleColor: '#09090b',
    subtitleColor: '#52525b',
    bodyColor: '#18181b',
    edgeColor: '#27272a',
    tagBg: '#f4f4f5',
    tagText: '#18181b',
    defaultTheme: 'mono',
    roughness: 0,
    fillStyle: 'solid',
    fontFamily: 2,
    rx: 3,
    shadow: false,
    grid: false,
    dark: false
  },
  minimal: {
    name: 'minimal',
    background: '#fafafa',
    titleColor: '#18181b',
    subtitleColor: '#71717a',
    bodyColor: '#27272a',
    edgeColor: '#3f3f46',
    tagBg: '#f4f4f5',
    tagText: '#27272a',
    defaultTheme: 'mono',
    roughness: 0,
    fillStyle: 'solid',
    fontFamily: 2,
    rx: 4,
    shadow: false,
    grid: false,
    dark: false
  }
};

class DiagramBuilder {
  constructor(spec = {}) {
    this.spec = spec;
    const presetKey = spec.preset && PRESETS[spec.preset] ? spec.preset : 'pastel';
    this.preset = { ...PRESETS[presetKey], ...(spec.style || {}) };
    if (spec.background) this.preset.background = spec.background;
    if (typeof spec.grid === 'boolean') this.preset.grid = spec.grid;
    if (typeof spec.roughness === 'number') this.preset.roughness = spec.roughness;
    if (typeof spec.shadow === 'boolean') this.preset.shadow = spec.shadow;
    if (spec.fillStyle) this.preset.fillStyle = spec.fillStyle;
    if (spec.fontFamily) this.preset.fontFamily = normalizeFontFamily(spec.fontFamily);

    this.title = spec.title !== undefined ? spec.title : '系统架构与数据流';
    this.subtitle = spec.subtitle || '';
    this.width = spec.width || 1200;
    this.height = spec.height || 920;

    this.groups = spec.groups || [];
    this.cards = spec.cards || [];
    this.nodes = spec.nodes || [];
    this.edges = spec.edges || [];
    this.arrows = spec.arrows || [];
    this.configBoxes = spec.configBoxes || [];
    this.lifelines = spec.lifelines || [];
    this.fragments = spec.fragments || [];
    this.messages = spec.messages || [];
    this.rawElements = spec.rawElements || [];

    this.nodeMap = new Map();
    this._indexNodes();
  }

  resolvePalette(item = {}, fallbackTheme) {
    const paletteTable = this.preset.dark ? DARK_PALETTES : PALETTES;
    const themeName = item.theme || fallbackTheme || this.preset.defaultTheme || 'gray';
    const base = paletteTable[themeName] || PALETTES[themeName] || paletteTable.gray;
    return {
      bg: item.bg || item.backgroundColor || base.bg,
      stroke: item.stroke || item.strokeColor || base.stroke,
      text: item.text || item.textColor || base.text,
      lightText: item.lightText || base.lightText,
      line: item.line || base.line
    };
  }

  _computeNodeGeometry(n) {
    const shape = (n.shape || n.type || 'rect').toLowerCase();
    const w = n.w || n.width || (shape === 'class' || shape === 'uml-class' || shape === 'interface' ? 240 : shape === 'card' ? 300 : 160);
    let h = n.h || n.height;
    if (!h) {
      if (shape === 'class' || shape === 'uml-class' || shape === 'interface' || shape === 'enum' || shape === 'entity') {
        const headerH = n.stereotype ? 54 : 38;
        const attrs = n.attributes || n.fields || [];
        const methods = n.methods || [];
        const attrH = attrs.length > 0 ? attrs.length * 22 + 14 : 16;
        const methodH = methods.length > 0 ? methods.length * 22 + 14 : (attrs.length > 0 ? 12 : 0);
        h = headerH + attrH + methodH;
      } else if (shape === 'card') {
        const items = n.items || [];
        const headerH = n.sub ? 84 : 64;
        h = headerH + items.length * 28 + 20;
      } else if (shape === 'actor' || shape === 'stickman') {
        h = 90;
      } else if (shape === 'initial' || shape === 'final') {
        h = w;
      } else {
        h = 64;
      }
    }
    return { ...n, shape, w, h };
  }

  _indexNodes() {
    this.cards.forEach((c, idx) => {
      const geom = this._computeNodeGeometry({ ...c, shape: c.shape || 'card' });
      const id = c.id || `card_${idx}`;
      this.nodeMap.set(id, geom);
    });
    this.nodes.forEach((n, idx) => {
      const geom = this._computeNodeGeometry(n);
      const id = n.id || `node_${idx}`;
      this.nodeMap.set(id, geom);
    });
    this.configBoxes.forEach((b, idx) => {
      const geom = this._computeNodeGeometry({ ...b, shape: 'config' });
      const id = b.id || `config_${idx}`;
      this.nodeMap.set(id, geom);
    });
  }

  _resolveEdgeGeometry(edge) {
    if (typeof edge.startX === 'number' && typeof edge.startY === 'number' && Array.isArray(edge.points)) {
      const pts = edge.points.map(([dx, dy]) => [edge.startX + dx, edge.startY + dy]);
      return {
        startX: edge.startX,
        startY: edge.startY,
        points: edge.points,
        absPoints: pts,
        routing: edge.routing || 'straight'
      };
    }

    const fromNode = this.nodeMap.get(edge.from);
    const toNode = this.nodeMap.get(edge.to);
    if (!fromNode || !toNode) {
      return {
        startX: edge.startX || 0,
        startY: edge.startY || 0,
        points: edge.points || [[0, 0], [60, 0]],
        absPoints: [[edge.startX || 0, edge.startY || 0], [(edge.startX || 0) + 60, edge.startY || 0]],
        routing: edge.routing || 'straight'
      };
    }

    const fcx = fromNode.x + fromNode.w / 2;
    const fcy = fromNode.y + fromNode.h / 2;
    const tcx = toNode.x + toNode.w / 2;
    const tcy = toNode.y + toNode.h / 2;
    const dx = tcx - fcx;
    const dy = tcy - fcy;

    let fromSide = edge.fromSide;
    let toSide = edge.toSide;
    if (!fromSide || fromSide === 'auto') {
      fromSide = Math.abs(dx) >= Math.abs(dy) ? (dx >= 0 ? 'right' : 'left') : (dy >= 0 ? 'bottom' : 'top');
    }
    if (!toSide || toSide === 'auto') {
      toSide = Math.abs(dx) >= Math.abs(dy) ? (dx >= 0 ? 'left' : 'right') : (dy >= 0 ? 'top' : 'bottom');
    }

    const anchorPoint = (node, side) => {
      switch (side) {
        case 'top': return [node.x + node.w / 2, node.y];
        case 'bottom': return [node.x + node.w / 2, node.y + node.h];
        case 'left': return [node.x, node.y + node.h / 2];
        case 'right':
        default: return [node.x + node.w, node.y + node.h / 2];
      }
    };

    const [x1, y1] = anchorPoint(fromNode, fromSide);
    const [x2, y2] = anchorPoint(toNode, toSide);
    const routing = edge.routing || 'straight';

    let absPoints;
    if (routing === 'orthogonal') {
      if ((fromSide === 'right' || fromSide === 'left') && (toSide === 'left' || toSide === 'right')) {
        const midX = (x1 + x2) / 2;
        absPoints = [[x1, y1], [midX, y1], [midX, y2], [x2, y2]];
      } else if ((fromSide === 'top' || fromSide === 'bottom') && (toSide === 'top' || toSide === 'bottom')) {
        const midY = (y1 + y2) / 2;
        absPoints = [[x1, y1], [x1, midY], [x2, midY], [x2, y2]];
      } else if (fromSide === 'right' || fromSide === 'left') {
        absPoints = [[x1, y1], [x2, y1], [x2, y2]];
      } else {
        absPoints = [[x1, y1], [x1, y2], [x2, y2]];
      }
    } else {
      absPoints = [[x1, y1], [x2, y2]];
    }

    const relPoints = absPoints.map(([px, py]) => [px - x1, py - y1]);
    return {
      startX: x1,
      startY: y1,
      points: relPoints,
      absPoints,
      routing,
      fromSide,
      toSide
    };
  }

  buildExcalidraw() {
    let idCounter = 1;
    const genId = (prefix) => `${prefix}_${idCounter++}_${Math.random().toString(36).slice(2, 8)}`;
    const elements = [];

    const addShape = (type, cfg) => {
      elements.push({
        id: cfg.id || genId(type),
        type,
        x: cfg.x,
        y: cfg.y,
        width: cfg.width,
        height: cfg.height,
        angle: 0,
        strokeColor: cfg.strokeColor || '#1e1e1e',
        backgroundColor: cfg.backgroundColor || 'transparent',
        fillStyle: cfg.fillStyle || this.preset.fillStyle || 'solid',
        strokeWidth: cfg.strokeWidth ?? 2,
        strokeStyle: cfg.strokeStyle || 'solid',
        roughness: cfg.roughness ?? this.preset.roughness ?? 1,
        opacity: cfg.opacity ?? 100,
        groupIds: cfg.groupIds || [],
        frameId: null,
        roundness: cfg.roundness !== undefined ? cfg.roundness : { type: 3 },
        seed: Math.floor(Math.random() * 1000000),
        version: 1,
        versionNonce: 1,
        isDeleted: false,
        boundElements: null,
        updated: Date.now(),
        link: null,
        locked: false
      });
    };

    const addRect = (cfg) => addShape('rectangle', cfg);
    const addEllipse = (cfg) => addShape('ellipse', cfg);
    const addDiamond = (cfg) => addShape('diamond', { ...cfg, roundness: { type: 2 } });

    const addLine = (cfg) => {
      const endPoint = cfg.points[cfg.points.length - 1] || [0, 0];
      elements.push({
        id: cfg.id || genId('line'),
        type: 'line',
        x: cfg.startX,
        y: cfg.startY,
        width: Math.abs(endPoint[0]),
        height: Math.abs(endPoint[1]),
        angle: 0,
        strokeColor: cfg.strokeColor || '#495057',
        backgroundColor: 'transparent',
        fillStyle: 'solid',
        strokeWidth: cfg.strokeWidth || 1.5,
        strokeStyle: cfg.strokeStyle || 'solid',
        roughness: cfg.roughness ?? this.preset.roughness ?? 0,
        opacity: 100,
        groupIds: [],
        frameId: null,
        roundness: null,
        seed: Math.floor(Math.random() * 1000000),
        version: 1,
        versionNonce: 1,
        isDeleted: false,
        points: cfg.points,
        startBinding: null,
        endBinding: null,
        startArrowhead: null,
        endArrowhead: null
      });
    };

    const addText = (cfg) => {
      elements.push({
        id: cfg.id || genId('text'),
        type: 'text',
        x: cfg.x,
        y: cfg.y,
        width: cfg.width,
        height: cfg.height,
        angle: 0,
        strokeColor: cfg.strokeColor || this.preset.bodyColor || '#1e1e1e',
        backgroundColor: 'transparent',
        fillStyle: 'solid',
        strokeWidth: 1,
        strokeStyle: 'solid',
        roughness: 0,
        opacity: cfg.opacity ?? 100,
        groupIds: [],
        frameId: null,
        roundness: null,
        seed: Math.floor(Math.random() * 1000000),
        version: 1,
        versionNonce: 1,
        isDeleted: false,
        boundElements: null,
        updated: Date.now(),
        link: null,
        locked: false,
        text: cfg.text,
        fontSize: cfg.fontSize || 16,
        fontFamily: cfg.fontFamily || this.preset.fontFamily || 1,
        textAlign: cfg.textAlign || 'center',
        verticalAlign: cfg.verticalAlign || 'middle',
        containerId: null,
        originalText: cfg.text,
        lineHeight: 1.3
      });
    };

    const mapExcalidrawArrowhead = (ah) => {
      if (!ah || ah === 'none') return null;
      if (ah === 'hollow-triangle' || ah === 'inherit' || ah === 'triangle') return 'triangle';
      if (ah === 'filled-diamond' || ah === 'composition' || ah === 'hollow-diamond' || ah === 'aggregation' || ah === 'diamond') return 'diamond';
      if (ah === 'circle' || ah === 'dot') return 'dot';
      if (ah === 'bar') return 'bar';
      return 'arrow';
    };

    const addArrow = (cfg) => {
      const endPoint = cfg.points[cfg.points.length - 1] || [0, 0];
      elements.push({
        id: cfg.id || genId('arrow'),
        type: 'arrow',
        x: cfg.startX,
        y: cfg.startY,
        width: Math.abs(endPoint[0]),
        height: Math.abs(endPoint[1]),
        angle: 0,
        strokeColor: cfg.strokeColor || this.preset.edgeColor || '#495057',
        backgroundColor: 'transparent',
        fillStyle: 'solid',
        strokeWidth: cfg.strokeWidth || 2,
        strokeStyle: cfg.strokeStyle || 'solid',
        roughness: cfg.roughness ?? this.preset.roughness ?? 1,
        opacity: 100,
        groupIds: [],
        frameId: null,
        roundness: { type: 2 },
        seed: Math.floor(Math.random() * 1000000),
        version: 1,
        versionNonce: 1,
        isDeleted: false,
        points: cfg.points,
        startBinding: null,
        endBinding: null,
        startArrowhead: mapExcalidrawArrowhead(cfg.startArrowhead),
        endArrowhead: mapExcalidrawArrowhead(cfg.endArrowhead !== undefined ? cfg.endArrowhead : 'arrow')
      });
    };

    // 1. Title & Subtitle
    if (this.title) {
      addText({
        x: (this.width - 800) / 2,
        y: 32,
        width: 800,
        height: 42,
        text: this.title,
        fontSize: 30,
        strokeColor: this.preset.titleColor,
        textAlign: 'center'
      });
    }
    if (this.subtitle) {
      addText({
        x: (this.width - 700) / 2,
        y: 78,
        width: 700,
        height: 24,
        text: this.subtitle,
        fontSize: 16,
        strokeColor: this.preset.subtitleColor,
        textAlign: 'center'
      });
    }

    // 2. Groups / Swimlanes / Containers
    this.groups.forEach((g) => {
      const p = this.resolvePalette(g, 'slate');
      addRect({
        x: g.x,
        y: g.y,
        width: g.w,
        height: g.h,
        backgroundColor: g.bg || (this.preset.dark ? '#1e293b' : p.bg),
        strokeColor: p.stroke,
        strokeWidth: g.strokeWidth || 1.5,
        strokeStyle: g.strokeStyle || 'dashed',
        opacity: g.opacity ?? 60
      });
      if (g.label || g.title) {
        addText({
          x: g.x + 14,
          y: g.y + 10,
          width: g.w - 28,
          height: 22,
          text: g.label || g.title,
          fontSize: 14,
          strokeColor: p.text,
          textAlign: 'left'
        });
      }
    });

    // 3. Sequence Fragments
    this.fragments.forEach((f) => {
      const p = this.resolvePalette(f, 'slate');
      addRect({
        x: f.x,
        y: f.y,
        width: f.w,
        height: f.h,
        backgroundColor: 'transparent',
        strokeColor: p.stroke,
        strokeWidth: 1.5,
        strokeStyle: 'dashed',
        roundness: null
      });
      const label = `${(f.operator || 'alt').toUpperCase()}${f.condition ? ` [${f.condition}]` : ''}`;
      addText({
        x: f.x + 8,
        y: f.y + 6,
        width: f.w - 16,
        height: 20,
        text: label,
        fontSize: 12,
        strokeColor: p.text,
        textAlign: 'left'
      });
      (f.dividers || []).forEach((div) => {
        addLine({
          startX: f.x,
          startY: div.y,
          points: [[0, 0], [f.w, 0]],
          strokeColor: p.stroke,
          strokeStyle: 'dashed'
        });
        if (div.condition) {
          addText({
            x: f.x + 12,
            y: div.y + 6,
            width: f.w - 24,
            height: 18,
            text: `[${div.condition}]`,
            fontSize: 12,
            strokeColor: p.lightText,
            textAlign: 'left'
          });
        }
      });
    });

    // 4. Sequence Lifelines
    const lifelineTop = 115;
    const lifelineBottom = this.height - 55;
    this.lifelines.forEach((ll) => {
      const p = this.resolvePalette(ll, 'blue');
      const boxW = ll.w || 130;
      const boxH = ll.h || 44;
      const topY = ll.y || lifelineTop;
      const endY = ll.endY || lifelineBottom;
      if (ll.actor) {
        addEllipse({
          x: ll.x - 14,
          y: topY,
          width: 28,
          height: 28,
          backgroundColor: p.bg,
          strokeColor: p.stroke
        });
      } else {
        addRect({
          x: ll.x - boxW / 2,
          y: topY,
          width: boxW,
          height: boxH,
          backgroundColor: p.bg,
          strokeColor: p.stroke,
          roundness: this.preset.rx <= 4 ? null : { type: 3 }
        });
      }
      addText({
        x: ll.x - boxW / 2,
        y: ll.actor ? topY + 32 : topY + 11,
        width: boxW,
        height: 22,
        text: ll.title || ll.id,
        fontSize: 15,
        strokeColor: p.text
      });
      const lineStartY = ll.actor ? topY + 56 : topY + boxH;
      addLine({
        startX: ll.x,
        startY: lineStartY,
        points: [[0, 0], [0, endY - lineStartY]],
        strokeColor: p.stroke,
        strokeStyle: 'dashed'
      });
      (ll.activations || []).forEach((act) => {
        addRect({
          x: ll.x - 6,
          y: act.startY,
          width: 12,
          height: Math.max(16, act.endY - act.startY),
          backgroundColor: p.bg,
          strokeColor: p.stroke,
          roundness: null
        });
      });
    });

    // 5. Cards & Nodes
    const renderNodeExcalidraw = (rawNode) => {
      const n = this._computeNodeGeometry(rawNode);
      const p = this.resolvePalette(n);
      const shape = n.shape;
      const fillStyle = n.fillStyle || this.preset.fillStyle;
      const strokeStyle = n.strokeStyle || 'solid';
      const strokeWidth = n.strokeWidth || 2;

      if (shape === 'diamond' || shape === 'decision') {
        addDiamond({
          x: n.x,
          y: n.y,
          width: n.w,
          height: n.h,
          backgroundColor: p.bg,
          strokeColor: p.stroke,
          fillStyle,
          strokeStyle,
          strokeWidth
        });
        addText({
          x: n.x + 12,
          y: n.y + n.h / 2 - 12,
          width: n.w - 24,
          height: 24,
          text: n.title || n.label || '',
          fontSize: 15,
          strokeColor: p.text
        });
        return;
      }

      if (shape === 'ellipse' || shape === 'circle' || shape === 'pill' || shape === 'terminator' || shape === 'state' || shape === 'initial' || shape === 'final') {
        addEllipse({
          x: n.x,
          y: n.y,
          width: n.w,
          height: n.h,
          backgroundColor: shape === 'initial' ? p.stroke : p.bg,
          strokeColor: p.stroke,
          fillStyle,
          strokeStyle,
          strokeWidth
        });
        if (n.title || n.label) {
          addText({
            x: n.x + 10,
            y: n.y + n.h / 2 - 12,
            width: n.w - 20,
            height: 24,
            text: n.title || n.label,
            fontSize: 15,
            strokeColor: p.text
          });
        }
        return;
      }

      if (shape === 'cylinder' || shape === 'database') {
        addRect({
          x: n.x,
          y: n.y + 12,
          width: n.w,
          height: n.h - 12,
          backgroundColor: p.bg,
          strokeColor: p.stroke,
          fillStyle,
          strokeStyle,
          strokeWidth
        });
        addEllipse({
          x: n.x,
          y: n.y,
          width: n.w,
          height: 24,
          backgroundColor: p.bg,
          strokeColor: p.stroke,
          fillStyle,
          strokeWidth
        });
        addText({
          x: n.x + 10,
          y: n.y + 34,
          width: n.w - 20,
          height: 24,
          text: n.title || n.label || '',
          fontSize: 16,
          strokeColor: p.text
        });
        if (n.sub) {
          addText({
            x: n.x + 10,
            y: n.y + 60,
            width: n.w - 20,
            height: 20,
            text: n.sub,
            fontSize: 13,
            strokeColor: p.lightText
          });
        }
        return;
      }

      if (shape === 'class' || shape === 'uml-class' || shape === 'interface' || shape === 'enum' || shape === 'entity') {
        addRect({
          x: n.x,
          y: n.y,
          width: n.w,
          height: n.h,
          backgroundColor: p.bg,
          strokeColor: p.stroke,
          fillStyle,
          strokeStyle,
          strokeWidth,
          roundness: null
        });
        let curY = n.y + 10;
        if (n.stereotype) {
          addText({
            x: n.x + 8,
            y: curY,
            width: n.w - 16,
            height: 18,
            text: `<<${n.stereotype}>>`,
            fontSize: 12,
            fontFamily: 3,
            strokeColor: p.lightText
          });
          curY += 20;
        }
        addText({
          x: n.x + 8,
          y: curY,
          width: n.w - 16,
          height: 24,
          text: n.title || n.name || 'Class',
          fontSize: 17,
          strokeColor: p.text
        });
        curY += 28;
        addLine({
          startX: n.x,
          startY: curY,
          points: [[0, 0], [n.w, 0]],
          strokeColor: p.stroke
        });
        curY += 8;
        const attrs = n.attributes || n.fields || [];
        attrs.forEach((attr) => {
          addText({
            x: n.x + 12,
            y: curY,
            width: n.w - 24,
            height: 20,
            text: attr,
            fontSize: 13,
            fontFamily: 3,
            strokeColor: this.preset.bodyColor,
            textAlign: 'left'
          });
          curY += 22;
        });
        const methods = n.methods || [];
        if (methods.length > 0) {
          curY += 4;
          addLine({
            startX: n.x,
            startY: curY,
            points: [[0, 0], [n.w, 0]],
            strokeColor: p.stroke
          });
          curY += 8;
          methods.forEach((m) => {
            addText({
              x: n.x + 12,
              y: curY,
              width: n.w - 24,
              height: 20,
              text: m,
              fontSize: 13,
              fontFamily: 3,
              strokeColor: this.preset.bodyColor,
              textAlign: 'left'
            });
            curY += 22;
          });
        }
        return;
      }

      if (shape === 'text') {
        addText({
          x: n.x,
          y: n.y,
          width: n.w,
          height: n.h,
          text: n.title || n.text || '',
          fontSize: n.fontSize || 16,
          strokeColor: p.text,
          textAlign: n.textAlign || 'left'
        });
        return;
      }

      // Default: card / rect / note / parallelogram / hexagon / actor
      addRect({
        x: n.x,
        y: n.y,
        width: n.w,
        height: n.h,
        backgroundColor: p.bg,
        strokeColor: p.stroke,
        fillStyle,
        strokeStyle,
        strokeWidth,
        roundness: this.preset.rx <= 4 ? null : { type: 3 }
      });

      const hasList = Array.isArray(n.items) && n.items.length > 0;
      const titleY = hasList || n.sub ? n.y + 15 : n.y + (n.h - 26) / 2;
      addText({
        x: n.x + 10,
        y: titleY,
        width: n.w - 20,
        height: 26,
        text: n.title || n.label || '',
        fontSize: hasList ? 20 : 16,
        strokeColor: p.text
      });
      if (n.sub) {
        addText({
          x: n.x + 10,
          y: n.y + 42,
          width: n.w - 20,
          height: 20,
          text: n.sub,
          fontSize: 13,
          strokeColor: p.lightText
        });
      }
      if (hasList) {
        let curY = n.y + (n.sub ? 75 : 55);
        n.items.forEach((it) => {
          addText({
            x: n.x + 20,
            y: curY,
            width: n.w - 40,
            height: 24,
            text: `• ${it}`,
            fontSize: 15,
            strokeColor: this.preset.bodyColor,
            textAlign: 'left'
          });
          curY += 28;
        });
      }
    };

    this.cards.forEach((c) => renderNodeExcalidraw({ ...c, shape: c.shape || 'card' }));
    this.nodes.forEach((n) => renderNodeExcalidraw(n));

    // 6. Edges & Legacy Arrows
    const allEdges = [...this.arrows, ...this.edges];
    allEdges.forEach((a) => {
      const geom = this._resolveEdgeGeometry(a);
      addArrow({
        startX: geom.startX,
        startY: geom.startY,
        points: geom.points,
        strokeColor: a.strokeColor || a.stroke || this.preset.edgeColor,
        strokeWidth: a.strokeWidth || 2,
        strokeStyle: a.strokeStyle || 'solid',
        startArrowhead: a.startArrowhead || a.markerStart,
        endArrowhead: a.endArrowhead !== undefined ? a.endArrowhead : a.markerEnd
      });
      if (a.label) {
        const midIdx = Math.floor(geom.absPoints.length / 2);
        const p1 = geom.absPoints[Math.max(0, midIdx - 1)];
        const p2 = geom.absPoints[midIdx];
        const lx = a.labelPos ? a.labelPos.x : (p1[0] + p2[0]) / 2;
        const ly = a.labelPos ? a.labelPos.y : (p1[1] + p2[1]) / 2 - 12;
        addText({
          x: lx - 40,
          y: ly,
          width: (a.labelPos && a.labelPos.w) || 80,
          height: 22,
          text: a.label,
          fontSize: (a.labelPos && a.labelPos.fontSize) || 13,
          strokeColor: a.labelColor || this.preset.tagText
        });
      }
    });

    // 7. Sequence Messages
    const lifelineMap = new Map(this.lifelines.map((l) => [l.id, l]));
    this.messages.forEach((m) => {
      const fromLL = lifelineMap.get(m.from);
      const toLL = lifelineMap.get(m.to);
      if (!fromLL || !toLL) return;
      const isReturn = m.type === 'return' || m.strokeStyle === 'dashed';
      const isSelf = m.from === m.to || m.type === 'self';
      const points = isSelf ? [[0, 0], [42, 0], [42, 28], [0, 28]] : [[0, 0], [toLL.x - fromLL.x, 0]];
      addArrow({
        startX: fromLL.x,
        startY: m.y,
        points,
        strokeColor: m.strokeColor || this.preset.edgeColor,
        strokeStyle: isReturn ? 'dashed' : 'solid',
        endArrowhead: 'arrow'
      });
      if (m.label) {
        const midX = isSelf ? fromLL.x + 50 : (fromLL.x + toLL.x) / 2 - 60;
        addText({
          x: midX,
          y: m.y - 22,
          width: 120,
          height: 20,
          text: m.label,
          fontSize: 13,
          strokeColor: this.preset.bodyColor
        });
      }
    });

    // 8. Config Boxes
    this.configBoxes.forEach((box) => {
      const p = this.resolvePalette(box, 'red');
      addRect({
        x: box.x,
        y: box.y,
        width: box.w,
        height: box.h,
        backgroundColor: p.bg,
        strokeColor: p.stroke,
        strokeWidth: 2
      });
      addText({
        x: box.x + 20,
        y: box.y + 18,
        width: box.w - 40,
        height: 30,
        text: box.title,
        fontSize: 22,
        strokeColor: p.text
      });
      if (box.sub) {
        addText({
          x: box.x + 20,
          y: box.y + 50,
          width: box.w - 40,
          height: 22,
          text: box.sub,
          fontSize: 14,
          strokeColor: p.lightText
        });
      }
      let bY = box.y + 85;
      (box.items || []).forEach((it) => {
        addText({
          x: box.x + 30,
          y: bY,
          width: box.w - 60,
          height: 24,
          text: `• ${it}`,
          fontSize: 14.5,
          strokeColor: this.preset.bodyColor,
          textAlign: 'left'
        });
        bY += 28;
      });
    });

    this.rawElements.forEach((el) => elements.push(el));

    return {
      type: 'excalidraw',
      version: 2,
      source: 'https://excalidraw.com',
      elements,
      appState: {
        gridSize: this.preset.grid ? 20 : null,
        viewBackgroundColor: this.preset.background
      },
      files: {}
    };
  }

  buildSVG() {
    const edgeColor = this.preset.edgeColor || '#495057';
    const isSketch = (this.preset.roughness || 0) >= 2;
    const defaultRx = this.preset.rx ?? 12;

    const resolveFillAttr = (p, fillStyle) => {
      const fsMode = fillStyle || this.preset.fillStyle || 'solid';
      if (fsMode === 'hachure' || fsMode === 'cross-hatch') {
        return `fill="${p.bg}"`;
      }
      return `fill="${p.bg}"`;
    };

    const renderHachureOverlay = (w, h, rx, stroke, fillStyle) => {
      const fsMode = fillStyle || this.preset.fillStyle || 'solid';
      if (fsMode !== 'hachure' && fsMode !== 'cross-hatch') return '';
      return `<rect width="${w}" height="${h}" rx="${rx}" fill="url(#pattern-hachure)" opacity="0.22" pointer-events="none"/>`;
    };

    const dashArrayFor = (style) => {
      if (style === 'dashed') return 'stroke-dasharray="6,5"';
      if (style === 'dotted') return 'stroke-dasharray="2,4"';
      return '';
    };

    // 1. Groups / Swimlanes
    const groupsSvg = this.groups.map((g) => {
      const p = this.resolvePalette(g, 'slate');
      const rx = g.rx ?? defaultRx;
      const dash = dashArrayFor(g.strokeStyle || 'dashed');
      const bgFill = g.bg || (this.preset.dark ? 'rgba(30,41,59,0.45)' : p.bg);
      const label = g.label || g.title || '';
      const badgeW = Math.max(90, estimateTextWidth(label, 8, 14) + 28);
      return `
    <g transform="translate(${g.x}, ${g.y})">
      <rect width="${g.w}" height="${g.h}" rx="${rx}" fill="${bgFill}" fill-opacity="0.55" stroke="${p.stroke}" stroke-width="${g.strokeWidth || 1.8}" ${dash}/>
      ${label ? `
      <rect x="14" y="-13" width="${badgeW}" height="26" rx="6" fill="${p.bg}" stroke="${p.stroke}" stroke-width="1.5"/>
      <text class="group-title" x="26" y="4" fill="${p.text}">${escapeXml(label)}</text>` : ''}
    </g>`;
    }).join('\n');

    // 2. Sequence Fragments
    const fragmentsSvg = this.fragments.map((f) => {
      const p = this.resolvePalette(f, 'slate');
      const op = (f.operator || 'alt').toUpperCase();
      const tagW = Math.max(46, estimateTextWidth(op, 9, 14) + 20);
      const condText = f.condition ? `[${f.condition}]` : '';
      const condW = condText ? estimateTextWidth(condText, 8, 13.5) + 12 : 0;
      const dividersSvg = (f.dividers || []).map((div) => {
        const dText = div.condition ? `[${div.condition}]` : '';
        const dW = dText ? estimateTextWidth(dText, 8, 13.5) + 12 : 0;
        return `
      <line x1="0" y1="${div.y - f.y}" x2="${f.w}" y2="${div.y - f.y}" stroke="${p.stroke}" stroke-width="1.5" stroke-dasharray="5,5"/>
      ${dText ? `<rect x="10" y="${div.y - f.y + 5}" width="${dW}" height="19" rx="3" fill="${this.preset.background}" fill-opacity="0.9"/>
      <text class="mono-text" x="14" y="${div.y - f.y + 19}" fill="${p.lightText}">${escapeXml(dText)}</text>` : ''}`;
      }).join('');
      return `
    <g transform="translate(${f.x}, ${f.y})">
      <rect width="${f.w}" height="${f.h}" rx="4" fill="none" stroke="${p.stroke}" stroke-width="1.6"/>
      <polygon points="0,0 ${tagW},0 ${tagW},16 ${tagW - 10},26 0,26" fill="${p.bg}" stroke="${p.stroke}" stroke-width="1.5"/>
      <text class="mono-text" x="10" y="17" font-weight="700" fill="${p.text}">${escapeXml(op)}</text>
      ${condText ? `<rect x="${tagW + 8}" y="4" width="${condW}" height="19" rx="3" fill="${this.preset.background}" fill-opacity="0.9"/>
      <text class="mono-text" x="${tagW + 12}" y="18" fill="${p.lightText}">${escapeXml(condText)}</text>` : ''}
      ${dividersSvg}
    </g>`;
    }).join('\n');

    // 3. Sequence Lifelines
    const lifelineTop = 115;
    const lifelineBottom = this.height - 55;
    const lifelinesSvg = this.lifelines.map((ll) => {
      const p = this.resolvePalette(ll, 'blue');
      const titleStr = ll.title || ll.id;
      const boxW = Math.max(ll.w || 136, estimateTextWidth(titleStr, 8.8, 15) + 28);
      const boxH = ll.h || 44;
      const topY = ll.y || lifelineTop;
      const endY = ll.endY || lifelineBottom;
      const lineStartY = ll.actor ? topY + 56 : topY + boxH;
      const headerSvg = ll.actor ? `
      <circle cx="${ll.x}" cy="${topY + 4}" r="9" fill="${p.bg}" stroke="${p.stroke}" stroke-width="2"/>
      <line x1="${ll.x}" y1="${topY + 13}" x2="${ll.x}" y2="${topY + 27}" stroke="${p.stroke}" stroke-width="2"/>
      <line x1="${ll.x - 12}" y1="${topY + 19}" x2="${ll.x + 12}" y2="${topY + 19}" stroke="${p.stroke}" stroke-width="2"/>
      <line x1="${ll.x}" y1="${topY + 27}" x2="${ll.x - 9}" y2="${topY + 38}" stroke="${p.stroke}" stroke-width="2"/>
      <line x1="${ll.x}" y1="${topY + 27}" x2="${ll.x + 9}" y2="${topY + 38}" stroke="${p.stroke}" stroke-width="2"/>
      <text class="node-title" x="${ll.x}" y="${topY + 52}" text-anchor="middle" fill="${p.text}" font-size="13.5">${escapeXml(titleStr)}</text>` : `
      <rect x="${ll.x - boxW / 2}" y="${topY}" width="${boxW}" height="${boxH}" rx="${Math.min(8, defaultRx)}" fill="${p.bg}" stroke="${p.stroke}" stroke-width="2"/>
      <text class="node-title" x="${ll.x}" y="${topY + boxH / 2 + 5}" text-anchor="middle" fill="${p.text}">${escapeXml(titleStr)}</text>`;

      const actsSvg = (ll.activations || []).map((act) => `
      <rect x="${ll.x - 6}" y="${act.startY}" width="12" height="${Math.max(16, act.endY - act.startY)}" rx="2" fill="${p.bg}" stroke="${p.stroke}" stroke-width="1.6"/>`).join('');

      return `
    <g>
      <line x1="${ll.x}" y1="${lineStartY}" x2="${ll.x}" y2="${endY}" stroke="${p.stroke}" stroke-width="1.6" stroke-dasharray="6,5"/>
      ${headerSvg}
      ${actsSvg}
    </g>`;
    }).join('\n');

    // 4. Nodes & Cards
    const renderNodeSvg = (rawNode) => {
      const n = this._computeNodeGeometry(rawNode);
      const p = this.resolvePalette(n);
      const shape = n.shape;
      const rx = n.rx ?? defaultRx;
      const strokeW = n.strokeWidth || 2;
      const dash = dashArrayFor(n.strokeStyle);
      const shadowAttr = (n.shadow ?? this.preset.shadow) ? 'filter="url(#shadow)"' : '';
      const sketchAttr = isSketch ? 'filter="url(#sketch-filter)"' : '';

      if (shape === 'diamond' || shape === 'decision') {
        const pts = `${n.w / 2},0 ${n.w},${n.h / 2} ${n.w / 2},${n.h} 0,${n.h / 2}`;
        return `
    <g transform="translate(${n.x}, ${n.y})" ${shadowAttr} ${sketchAttr}>
      <polygon points="${pts}" ${resolveFillAttr(p, n.fillStyle)} stroke="${p.stroke}" stroke-width="${strokeW}" ${dash}/>
      <text class="node-title" x="${n.w / 2}" y="${n.h / 2 + (n.sub ? -2 : 5)}" text-anchor="middle" fill="${p.text}">${escapeXml(n.title || n.label || '')}</text>
      ${n.sub ? `<text class="card-sub" x="${n.w / 2}" y="${n.h / 2 + 16}" text-anchor="middle" fill="${p.lightText}">${escapeXml(n.sub)}</text>` : ''}
    </g>`;
      }

      if (shape === 'pill' || shape === 'terminator' || shape === 'stadium') {
        const pillRx = n.h / 2;
        return `
    <g transform="translate(${n.x}, ${n.y})" ${shadowAttr} ${sketchAttr}>
      <rect width="${n.w}" height="${n.h}" rx="${pillRx}" ${resolveFillAttr(p, n.fillStyle)} stroke="${p.stroke}" stroke-width="${strokeW}" ${dash}/>
      ${renderHachureOverlay(n.w, n.h, pillRx, p.stroke, n.fillStyle)}
      <text class="node-title" x="${n.w / 2}" y="${n.h / 2 + 5}" text-anchor="middle" fill="${p.text}">${escapeXml(n.title || n.label || '')}</text>
    </g>`;
      }

      if (shape === 'ellipse' || shape === 'circle' || shape === 'state' || shape === 'initial' || shape === 'final') {
        if (shape === 'initial') {
          return `
    <g transform="translate(${n.x}, ${n.y})">
      <circle cx="${n.w / 2}" cy="${n.h / 2}" r="${Math.min(n.w, n.h) / 2}" fill="${p.stroke}"/>
    </g>`;
        }
        if (shape === 'final') {
          const r = Math.min(n.w, n.h) / 2;
          return `
    <g transform="translate(${n.x}, ${n.y})">
      <circle cx="${n.w / 2}" cy="${n.h / 2}" r="${r}" fill="none" stroke="${p.stroke}" stroke-width="2"/>
      <circle cx="${n.w / 2}" cy="${n.h / 2}" r="${r * 0.6}" fill="${p.stroke}"/>
    </g>`;
        }
        return `
    <g transform="translate(${n.x}, ${n.y})" ${shadowAttr} ${sketchAttr}>
      <ellipse cx="${n.w / 2}" cy="${n.h / 2}" rx="${n.w / 2}" ry="${n.h / 2}" ${resolveFillAttr(p, n.fillStyle)} stroke="${p.stroke}" stroke-width="${strokeW}" ${dash}/>
      <text class="node-title" x="${n.w / 2}" y="${n.h / 2 + (n.sub ? -2 : 5)}" text-anchor="middle" fill="${p.text}">${escapeXml(n.title || n.label || '')}</text>
      ${n.sub ? `<text class="card-sub" x="${n.w / 2}" y="${n.h / 2 + 16}" text-anchor="middle" fill="${p.lightText}">${escapeXml(n.sub)}</text>` : ''}
    </g>`;
      }

      if (shape === 'cylinder' || shape === 'database') {
        const ry = 13;
        const bodyH = n.h - ry * 2;
        const pathD = `M 0 ${ry} L 0 ${ry + bodyH} A ${n.w / 2} ${ry} 0 0 0 ${n.w} ${ry + bodyH} L ${n.w} ${ry} Z`;
        return `
    <g transform="translate(${n.x}, ${n.y})" ${shadowAttr} ${sketchAttr}>
      <path d="${pathD}" fill="${p.bg}" stroke="${p.stroke}" stroke-width="${strokeW}" ${dash}/>
      <ellipse cx="${n.w / 2}" cy="${ry}" rx="${n.w / 2}" ry="${ry}" fill="${p.bg}" stroke="${p.stroke}" stroke-width="${strokeW}"/>
      <text class="node-title" x="${n.w / 2}" y="${n.h / 2 + (n.sub ? 2 : 10)}" text-anchor="middle" fill="${p.text}">${escapeXml(n.title || n.label || '')}</text>
      ${n.sub ? `<text class="card-sub" x="${n.w / 2}" y="${n.h / 2 + 22}" text-anchor="middle" fill="${p.lightText}">${escapeXml(n.sub)}</text>` : ''}
    </g>`;
      }

      if (shape === 'parallelogram' || shape === 'io') {
        const skew = 20;
        const pts = `${skew},0 ${n.w},0 ${n.w - skew},${n.h} 0,${n.h}`;
        return `
    <g transform="translate(${n.x}, ${n.y})" ${shadowAttr} ${sketchAttr}>
      <polygon points="${pts}" fill="${p.bg}" stroke="${p.stroke}" stroke-width="${strokeW}" ${dash}/>
      <text class="node-title" x="${n.w / 2}" y="${n.h / 2 + 5}" text-anchor="middle" fill="${p.text}">${escapeXml(n.title || n.label || '')}</text>
    </g>`;
      }

      if (shape === 'hexagon' || shape === 'prep') {
        const inset = 22;
        const pts = `${inset},0 ${n.w - inset},0 ${n.w},${n.h / 2} ${n.w - inset},${n.h} ${inset},${n.h} 0,${n.h / 2}`;
        return `
    <g transform="translate(${n.x}, ${n.y})" ${shadowAttr} ${sketchAttr}>
      <polygon points="${pts}" fill="${p.bg}" stroke="${p.stroke}" stroke-width="${strokeW}" ${dash}/>
      <text class="node-title" x="${n.w / 2}" y="${n.h / 2 + 5}" text-anchor="middle" fill="${p.text}">${escapeXml(n.title || n.label || '')}</text>
    </g>`;
      }

      if (shape === 'actor' || shape === 'stickman') {
        const cx = n.w / 2;
        return `
    <g transform="translate(${n.x}, ${n.y})">
      <circle cx="${cx}" cy="16" r="12" fill="${p.bg}" stroke="${p.stroke}" stroke-width="2"/>
      <line x1="${cx}" y1="28" x2="${cx}" y2="54" stroke="${p.stroke}" stroke-width="2"/>
      <line x1="${cx - 18}" y1="38" x2="${cx + 18}" y2="38" stroke="${p.stroke}" stroke-width="2"/>
      <line x1="${cx}" y1="54" x2="${cx - 14}" y2="74" stroke="${p.stroke}" stroke-width="2"/>
      <line x1="${cx}" y1="54" x2="${cx + 14}" y2="74" stroke="${p.stroke}" stroke-width="2"/>
      <text class="node-title" x="${cx}" y="92" text-anchor="middle" fill="${p.text}">${escapeXml(n.title || n.label || 'Actor')}</text>
    </g>`;
      }

      if (shape === 'note' || shape === 'callout') {
        const fold = 16;
        const bodyPath = `M 0 0 L ${n.w - fold} 0 L ${n.w} ${fold} L ${n.w} ${n.h} L 0 ${n.h} Z`;
        const foldPath = `M ${n.w - fold} 0 L ${n.w - fold} ${fold} L ${n.w} ${fold}`;
        const lines = (n.items && n.items.length ? n.items : String(n.title || n.text || '').split('\n'));
        const textSvg = lines.map((line, idx) => `<text class="card-item" x="14" y="${28 + idx * 22}" fill="${this.preset.bodyColor}">${parseBold(line)}</text>`).join('\n      ');
        return `
    <g transform="translate(${n.x}, ${n.y})" ${shadowAttr}>
      <path d="${bodyPath}" fill="${p.bg}" stroke="${p.stroke}" stroke-width="1.8"/>
      <path d="${foldPath}" fill="none" stroke="${p.stroke}" stroke-width="1.6"/>
      ${textSvg}
    </g>`;
      }

      if (shape === 'class' || shape === 'uml-class' || shape === 'interface' || shape === 'enum' || shape === 'entity') {
        const headerH = n.stereotype ? 54 : 38;
        const attrs = n.attributes || n.fields || [];
        const methods = n.methods || [];
        const attrBlockH = attrs.length > 0 ? attrs.length * 22 + 14 : 16;
        const methodStartY = headerH + attrBlockH;
        const attrsSvg = attrs.map((a, idx) => `<text class="mono-text" x="14" y="${headerH + 20 + idx * 22}" fill="${this.preset.bodyColor}">${escapeXml(a)}</text>`).join('\n      ');
        const methodsSvg = methods.map((m, idx) => `<text class="mono-text" x="14" y="${methodStartY + 20 + idx * 22}" fill="${this.preset.bodyColor}">${escapeXml(m)}</text>`).join('\n      ');
        return `
    <g transform="translate(${n.x}, ${n.y})" ${shadowAttr}>
      <rect width="${n.w}" height="${n.h}" rx="${Math.min(4, rx)}" fill="${p.bg}" stroke="${p.stroke}" stroke-width="${strokeW}"/>
      ${n.stereotype ? `<text class="mono-text" x="${n.w / 2}" y="20" text-anchor="middle" fill="${p.lightText}">&lt;&lt;${escapeXml(n.stereotype)}&gt;&gt;</text>` : ''}
      <text class="node-title" x="${n.w / 2}" y="${n.stereotype ? 42 : 25}" text-anchor="middle" fill="${p.text}">${escapeXml(n.title || n.name || 'Class')}</text>
      <line x1="0" y1="${headerH}" x2="${n.w}" y2="${headerH}" stroke="${p.stroke}" stroke-width="1.5"/>
      ${attrsSvg}
      ${methods.length > 0 ? `<line x1="0" y1="${methodStartY}" x2="${n.w}" y2="${methodStartY}" stroke="${p.stroke}" stroke-width="1.5"/>` : ''}
      ${methodsSvg}
    </g>`;
      }

      if (shape === 'text') {
        return `
    <g transform="translate(${n.x}, ${n.y})">
      <text class="node-title" x="0" y="20" fill="${p.text}" font-size="${n.fontSize || 16}">${escapeXml(n.title || n.text || '')}</text>
    </g>`;
      }

      // Card or simple rect
      const hasList = Array.isArray(n.items) && n.items.length > 0;
      if (!hasList && shape !== 'card') {
        return `
    <g transform="translate(${n.x}, ${n.y})" ${shadowAttr} ${sketchAttr}>
      <rect width="${n.w}" height="${n.h}" rx="${rx}" ${resolveFillAttr(p, n.fillStyle)} stroke="${p.stroke}" stroke-width="${strokeW}" ${dash}/>
      ${renderHachureOverlay(n.w, n.h, rx, p.stroke, n.fillStyle)}
      <text class="node-title" x="${n.w / 2}" y="${n.h / 2 + (n.sub ? -3 : 6)}" text-anchor="middle" fill="${p.text}">${escapeXml(n.title || n.label || '')}</text>
      ${n.sub ? `<text class="card-sub" x="${n.w / 2}" y="${n.h / 2 + 17}" text-anchor="middle" fill="${p.lightText}">${escapeXml(n.sub)}</text>` : ''}
    </g>`;
      }

      const itemsSvg = (n.items || []).map((it, idx) => `<text y="${idx * 28}" fill="${this.preset.bodyColor}">• ${parseBold(it)}</text>`).join('\n        ');
      return `
    <g transform="translate(${n.x}, ${n.y})" ${shadowAttr} ${sketchAttr}>
      <rect width="${n.w}" height="${n.h}" rx="${rx}" ${resolveFillAttr(p, n.fillStyle)} stroke="${p.stroke}" stroke-width="${strokeW}" ${dash}/>
      ${renderHachureOverlay(n.w, n.h, rx, p.stroke, n.fillStyle)}
      <text class="card-title" x="${n.w / 2}" y="36" text-anchor="middle" fill="${p.text}">${escapeXml(n.title || '')}</text>
      ${n.sub ? `<text class="card-sub" x="${n.w / 2}" y="56" text-anchor="middle" fill="${p.lightText}">${escapeXml(n.sub)}</text>` : ''}
      <line x1="25" y1="${n.sub ? 72 : 55}" x2="${n.w - 25}" y2="${n.sub ? 72 : 55}" stroke="${p.line}" stroke-width="1.5" stroke-dasharray="4,4"/>
      <g class="card-item" transform="translate(24, ${n.sub ? 102 : 85})">
        ${itemsSvg}
      </g>
    </g>`;
    };

    const cardsSvg = [
      ...this.cards.map((c) => renderNodeSvg({ ...c, shape: c.shape || 'card' })),
      ...this.nodes.map((n) => renderNodeSvg(n))
    ].join('\n');

    // 5. Edges & Arrows
    const resolveMarkerUrl = (arrowhead, isRed, isStart = false) => {
      if (arrowhead === 'none' || arrowhead === null) return '';
      const kind = arrowhead || (isStart ? 'none' : 'arrow');
      if (kind === 'none') return '';
      if (kind === 'hollow-triangle' || kind === 'inherit' || kind === 'triangle') return 'url(#arrow-hollow-triangle)';
      if (kind === 'filled-diamond' || kind === 'composition') return 'url(#arrow-filled-diamond)';
      if (kind === 'hollow-diamond' || kind === 'aggregation' || kind === 'diamond') return 'url(#arrow-hollow-diamond)';
      if (kind === 'open') return 'url(#arrow-open)';
      if (kind === 'circle' || kind === 'dot') return 'url(#arrow-circle)';
      return isRed ? 'url(#arrow-red)' : 'url(#arrow-gray)';
    };

    const allEdges = [...this.arrows, ...this.edges];
    const arrowsSvg = allEdges.map((a) => {
      const geom = this._resolveEdgeGeometry(a);
      const isRed = a.strokeColor === '#e03131' || a.marker === 'red';
      const color = a.strokeColor || a.stroke || edgeColor;
      const width = a.strokeWidth || 2.1;
      const dashAttr = dashArrayFor(a.strokeStyle);

      const startMarker = resolveMarkerUrl(a.startArrowhead || a.markerStart, isRed, true);
      const endMarker = resolveMarkerUrl(a.endArrowhead !== undefined ? a.endArrowhead : (a.markerEnd !== undefined ? a.markerEnd : 'arrow'), isRed, false);
      const markerStartAttr = startMarker ? `marker-start="${startMarker}"` : '';
      const markerEndAttr = endMarker ? `marker-end="${endMarker}"` : '';

      let pathD = '';
      let curveMid = null;
      if (a.path) {
        pathD = a.path;
      } else if (geom.routing === 'curved' && geom.absPoints.length === 2) {
        const [[x1, y1], [x2, y2]] = geom.absPoints;
        const offset = a.curveOffset || 62;
        let cx1, cy1, cx2, cy2;
        if (geom.fromSide === 'top' && geom.toSide === 'top') {
          const arcY = Math.min(y1, y2) - offset;
          cx1 = x1; cy1 = arcY; cx2 = x2; cy2 = arcY;
        } else if (geom.fromSide === 'bottom' && geom.toSide === 'bottom') {
          const arcY = Math.max(y1, y2) + offset;
          cx1 = x1; cy1 = arcY; cx2 = x2; cy2 = arcY;
        } else if (geom.fromSide === 'left' && geom.toSide === 'left') {
          const arcX = Math.min(x1, x2) - offset;
          cx1 = arcX; cy1 = y1; cx2 = arcX; cy2 = y2;
        } else if (geom.fromSide === 'right' && geom.toSide === 'right') {
          const arcX = Math.max(x1, x2) + offset;
          cx1 = arcX; cy1 = y1; cx2 = arcX; cy2 = y2;
        } else {
          cx1 = (x1 + x2) / 2; cy1 = y1;
          cx2 = (x1 + x2) / 2; cy2 = y2;
        }
        pathD = `M ${x1} ${y1} C ${cx1} ${cy1}, ${cx2} ${cy2}, ${x2} ${y2}`;
        curveMid = {
          x: 0.125 * x1 + 0.375 * cx1 + 0.375 * cx2 + 0.125 * x2,
          y: 0.125 * y1 + 0.375 * cy1 + 0.375 * cy2 + 0.125 * y2 + 4
        };
      } else {
        pathD = geom.absPoints.map(([px, py], idx) => `${idx === 0 ? 'M' : 'L'} ${px} ${py}`).join(' ');
      }

      let labelSvg = '';
      if (a.label) {
        const midIdx = Math.floor(geom.absPoints.length / 2);
        const p1 = geom.absPoints[Math.max(0, midIdx - 1)];
        const p2 = geom.absPoints[midIdx];
        const lp = a.labelPos || curveMid || { x: (p1[0] + p2[0]) / 2, y: (p1[1] + p2[1]) / 2 + 4 };
        const boxW = lp.w || Math.max(54, estimateTextWidth(a.label, 8, 13.5) + 18);
        const tagClass = isRed ? 'cfg-text' : 'tag-text';
        const tagFill = isRed ? '#ffe3e3' : this.preset.tagBg;
        const tagStroke = isRed ? 'stroke="#ffa8a8"' : `stroke="${this.preset.dark ? '#334155' : '#dee2e6'}"`;
        labelSvg += `
      <rect x="${lp.x - boxW / 2}" y="${lp.y - 15}" width="${boxW}" height="22" rx="5" fill="${tagFill}" ${tagStroke}/>
      <text class="${tagClass}" x="${lp.x}" y="${lp.y}" text-anchor="middle">${escapeXml(a.label)}</text>`;
      }

      const placeEndMultiplicity = (text, pt, side, hasCenterLabel) => {
        const [px, py] = pt;
        const yOff = hasCenterLabel ? 20 : -9;
        if (side === 'left') return `<text class="mono-text" x="${px - 14}" y="${py + yOff}" text-anchor="end" fill="${this.preset.subtitleColor}">${escapeXml(text)}</text>`;
        if (side === 'top') return `<text class="mono-text" x="${px + 12}" y="${py - 12}" text-anchor="start" fill="${this.preset.subtitleColor}">${escapeXml(text)}</text>`;
        if (side === 'bottom') return `<text class="mono-text" x="${px + 12}" y="${py + 22}" text-anchor="start" fill="${this.preset.subtitleColor}">${escapeXml(text)}</text>`;
        return `<text class="mono-text" x="${px + 14}" y="${py + yOff}" text-anchor="start" fill="${this.preset.subtitleColor}">${escapeXml(text)}</text>`;
      };

      if (a.startLabel) {
        labelSvg += placeEndMultiplicity(a.startLabel, geom.absPoints[0], geom.fromSide || 'right', Boolean(a.label));
      }
      if (a.endLabel) {
        labelSvg += placeEndMultiplicity(a.endLabel, geom.absPoints[geom.absPoints.length - 1], geom.toSide || 'left', Boolean(a.label));
      }

      return `
    <g>
      <path d="${pathD}" fill="none" stroke="${color}" stroke-width="${width}" ${dashAttr} ${markerStartAttr} ${markerEndAttr}/>
      ${labelSvg}
    </g>`;
    }).join('\n');

    // 6. Sequence Messages
    const lifelineMap = new Map(this.lifelines.map((l) => [l.id, l]));
    const messagesSvg = this.messages.map((m) => {
      const fromLL = lifelineMap.get(m.from);
      const toLL = lifelineMap.get(m.to);
      if (!fromLL || !toLL) return '';
      const isReturn = m.type === 'return' || m.strokeStyle === 'dashed';
      const isAsync = m.type === 'async';
      const isSelf = m.from === m.to || m.type === 'self';
      const dashAttr = isReturn ? 'stroke-dasharray="5,5"' : '';
      const markerEnd = isAsync || isReturn ? 'url(#arrow-open)' : 'url(#arrow-gray)';
      const color = m.strokeColor || edgeColor;

      if (isSelf) {
        const sx = fromLL.x + 6;
        const pathD = `M ${sx} ${m.y} L ${sx + 42} ${m.y} L ${sx + 42} ${m.y + 26} L ${sx} ${m.y + 26}`;
        return `
    <g>
      <path d="${pathD}" fill="none" stroke="${color}" stroke-width="1.8" ${dashAttr} marker-end="${markerEnd}"/>
      ${m.label ? `<text class="mono-text" x="${sx + 50}" y="${m.y + 17}" fill="${this.preset.bodyColor}">${escapeXml(m.label)}</text>` : ''}
    </g>`;
      }

      const dir = toLL.x > fromLL.x ? 1 : -1;
      const x1 = fromLL.x + dir * 6;
      const x2 = toLL.x - dir * 6;
      const midX = (x1 + x2) / 2;
      return `
    <g>
      <line x1="${x1}" y1="${m.y}" x2="${x2}" y2="${m.y}" stroke="${color}" stroke-width="1.9" ${dashAttr} marker-end="${markerEnd}"/>
      ${m.label ? `<text class="mono-text" x="${midX}" y="${m.y - 7}" text-anchor="middle" fill="${this.preset.bodyColor}">${escapeXml(m.label)}</text>` : ''}
    </g>`;
    }).join('\n');

    // 7. Config Boxes
    const configSvg = this.configBoxes.map((b) => {
      const p = this.resolvePalette(b, 'red');
      const itemsSvg = (b.items || []).map((it, idx) => `<text y="${idx * 28}" fill="${this.preset.bodyColor}">• ${parseBold(it)}</text>`).join('\n        ');
      return `
    <g transform="translate(${b.x}, ${b.y})" ${this.preset.shadow ? 'filter="url(#red-shadow)"' : ''}>
      <rect width="${b.w}" height="${b.h}" rx="${defaultRx}" fill="${p.bg}" stroke="${p.stroke}" stroke-width="2.5"/>
      <text class="card-title" x="${b.w / 2}" y="36" text-anchor="middle" fill="${p.text}" font-size="22">${escapeXml(b.title)}</text>
      ${b.sub ? `<text class="card-sub" x="${b.w / 2}" y="58" text-anchor="middle" font-size="14" fill="${p.lightText}">${escapeXml(b.sub)}</text>` : ''}
      <line x1="30" y1="74" x2="${b.w - 30}" y2="74" stroke="${p.line}" stroke-width="1.5" stroke-dasharray="4,4"/>
      <g class="card-item" transform="translate(35, 104)" font-size="15">
        ${itemsSvg}
      </g>
    </g>`;
    }).join('\n');

    const gridDef = this.preset.grid ? `
    <pattern id="bg-grid" width="24" height="24" patternUnits="userSpaceOnUse">
      <circle cx="2" cy="2" r="1" fill="${this.preset.dark ? '#334155' : '#cbd5e1'}" opacity="0.65"/>
    </pattern>` : '';

    return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${this.width} ${this.height}" width="100%" height="100%">
  <defs>
    <filter id="shadow" x="-5%" y="-5%" width="110%" height="110%" filterUnits="userSpaceOnUse">
      <feDropShadow dx="0" dy="4" stdDeviation="6" flood-color="#000000" flood-opacity="${this.preset.dark ? '0.35' : '0.07'}"/>
    </filter>
    <filter id="red-shadow" x="-4%" y="-4%" width="108%" height="108%" filterUnits="userSpaceOnUse">
      <feDropShadow dx="0" dy="5" stdDeviation="8" flood-color="#e03131" flood-opacity="0.12"/>
    </filter>
    <filter id="sketch-filter" x="-2%" y="-2%" width="104%" height="104%">
      <feTurbulence type="fractalNoise" baseFrequency="0.04" numOctaves="2" result="noise"/>
      <feDisplacementMap in="SourceGraphic" in2="noise" scale="1.8" xChannelSelector="R" yChannelSelector="G"/>
    </filter>
    <pattern id="pattern-hachure" width="8" height="8" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
      <line x1="0" y1="0" x2="0" y2="8" stroke="${edgeColor}" stroke-width="1.2"/>
    </pattern>${gridDef}
    <marker id="arrow-gray" markerWidth="10" markerHeight="10" refX="8" refY="5" orient="auto-start-reverse">
      <path d="M 0 1.5 L 8.5 5 L 0 8.5 Z" fill="${edgeColor}" />
    </marker>
    <marker id="arrow-red" markerWidth="10" markerHeight="10" refX="8" refY="5" orient="auto-start-reverse">
      <path d="M 0 1.5 L 8.5 5 L 0 8.5 Z" fill="#e03131" />
    </marker>
    <marker id="arrow-open" markerWidth="10" markerHeight="10" refX="8" refY="5" orient="auto-start-reverse">
      <path d="M 1 1.5 L 8.5 5 L 1 8.5" fill="none" stroke="${edgeColor}" stroke-width="1.8"/>
    </marker>
    <marker id="arrow-hollow-triangle" markerWidth="12" markerHeight="12" refX="10" refY="6" orient="auto-start-reverse">
      <polygon points="0,1.5 10.5,6 0,10.5" fill="${this.preset.background}" stroke="${edgeColor}" stroke-width="1.8"/>
    </marker>
    <marker id="arrow-filled-diamond" markerWidth="14" markerHeight="12" refX="12" refY="6" orient="auto-start-reverse">
      <polygon points="0,6 6,1.5 12,6 6,10.5" fill="${edgeColor}" stroke="${edgeColor}" stroke-width="1.4"/>
    </marker>
    <marker id="arrow-hollow-diamond" markerWidth="14" markerHeight="12" refX="12" refY="6" orient="auto-start-reverse">
      <polygon points="0,6 6,1.5 12,6 6,10.5" fill="${this.preset.background}" stroke="${edgeColor}" stroke-width="1.6"/>
    </marker>
    <marker id="arrow-circle" markerWidth="10" markerHeight="10" refX="5" refY="5" orient="auto">
      <circle cx="5" cy="5" r="3.5" fill="${edgeColor}"/>
    </marker>
    <style>
      .title { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", sans-serif; font-weight: 800; fill: ${this.preset.titleColor}; }
      .subtitle { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "PingFang SC", sans-serif; font-weight: 500; fill: ${this.preset.subtitleColor}; }
      .group-title { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "PingFang SC", sans-serif; font-weight: 700; font-size: 13px; }
      .card-title { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "PingFang SC", sans-serif; font-weight: 700; font-size: 19px; }
      .node-title { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "PingFang SC", sans-serif; font-weight: 700; font-size: 16px; }
      .card-sub { font-family: "SF Mono", "Consolas", Menlo, monospace; font-size: 13px; }
      .mono-text { font-family: "SF Mono", "Consolas", Menlo, monospace; font-size: 13px; }
      .card-item { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "PingFang SC", sans-serif; font-size: 14.5px; }
      .tag-text { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "PingFang SC", sans-serif; font-size: 12.5px; font-weight: 600; fill: ${this.preset.tagText}; text-anchor: middle; }
      .cfg-text { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "PingFang SC", sans-serif; font-size: 12.5px; font-weight: 700; fill: #c92a2a; text-anchor: middle; }
    </style>
  </defs>

  <rect width="100%" height="100%" fill="${this.preset.background}" rx="14"/>
  ${this.preset.grid ? `<rect width="100%" height="100%" fill="url(#bg-grid)" rx="14"/>` : ''}

  ${this.title ? `<g transform="translate(${this.width / 2}, 48)" text-anchor="middle">
    <text class="title" font-size="28" y="0">${escapeXml(this.title)}</text>
    ${this.subtitle ? `<text class="subtitle" font-size="15" y="28">${escapeXml(this.subtitle)}</text>` : ''}
  </g>` : ''}

  <!-- Groups / Swimlanes -->
  ${groupsSvg}

  <!-- Sequence Lifelines -->
  ${lifelinesSvg}

  <!-- Sequence Fragments -->
  ${fragmentsSvg}
  <!-- Nodes & Cards -->
  ${cardsSvg}

  <!-- Edges & Arrows -->
  ${arrowsSvg}

  <!-- Sequence Messages -->
  ${messagesSvg}

  <!-- Config Banners -->
  ${configSvg}
</svg>`;
  }

  generate(outputDir = './docs', namePrefix = 'architecture') {
    if (!fs.existsSync(outputDir)) {
      fs.mkdirSync(outputDir, { recursive: true });
    }

    const excalidrawPath = path.join(outputDir, `${namePrefix}.excalidraw`);
    fs.writeFileSync(excalidrawPath, JSON.stringify(this.buildExcalidraw(), null, 2), 'utf-8');

    const svgPath = path.join(outputDir, `${namePrefix}.svg`);
    fs.writeFileSync(svgPath, this.buildSVG(), 'utf-8');

    const pngPath = path.join(outputDir, `${namePrefix}.png`);
    try {
      execSync(`rsvg-convert -w 2400 "${svgPath}" -o "${pngPath}"`);
    } catch (e) {
      // ignore if rsvg-convert not present
    }

    return { excalidrawPath, svgPath, pngPath };
  }
}

function normalizeFontFamily(ff) {
  if (typeof ff === 'number') return ff;
  if (ff === 'hand' || ff === 'virgil') return 1;
  if (ff === 'sans' || ff === 'helvetica') return 2;
  if (ff === 'mono' || ff === 'code' || ff === 'cascadia') return 3;
  return 1;
}

function estimateTextWidth(str = '', asciiW = 8.5, cjkW = 14.5) {
  let width = 0;
  for (const ch of String(str)) {
    width += ch.charCodeAt(0) > 255 ? cjkW : asciiW;
  }
  return Math.ceil(width);
}

function escapeXml(str = '') {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function parseBold(str = '') {
  const escaped = escapeXml(str);
  return escaped.replace(/\*\*(.*?)\*\*/g, '<tspan font-weight="700">$1</tspan>');
}

function generateDiagram(spec, options = {}) {
  const builder = new DiagramBuilder(spec);
  return builder.generate(options.outputDir, options.namePrefix);
}

if (require.main === module) {
  const args = process.argv.slice(2);
  if (args.length === 0) {
    console.log('Usage: node diagram_generator.js <spec.json> [outputDir] [namePrefix]');
    process.exit(1);
  }
  const specFile = path.resolve(args[0]);
  const outputDir = args[1] || './docs';
  const namePrefix = args[2] || 'architecture';
  const spec = JSON.parse(fs.readFileSync(specFile, 'utf-8'));
  const res = generateDiagram(spec, { outputDir, namePrefix });
  console.log(`✓ Diagram generated:\n  - ${res.excalidrawPath}\n  - ${res.svgPath}\n  - ${res.pngPath}`);
}

module.exports = {
  DiagramBuilder,
  generateDiagram,
  PALETTES,
  DARK_PALETTES,
  PRESETS
};
