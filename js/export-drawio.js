/**
 * draw.io Export — generates a .drawio XML file from the current diagram.
 *
 * Reads node/subgraph positions from the rendered SVG DOM and maps
 * the parsed Mermaid structure into draw.io's mxGraphModel XML format.
 */

import { parseMermaidDefinition } from './parser.js';

// ── XML Helpers ──────────────────────────────────────────────────────

function escapeXml(str) {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// ── SVG coordinate helpers ──────────────────────────────────────────

/**
 * Get the bounding box of an SVG element in the SVG viewBox coordinate space,
 * correctly accounting for transform attributes on the element and its ancestors.
 *
 * getBBox() alone returns coordinates in the element's LOCAL coordinate system,
 * which ignores any transform="translate(...)" on the element — causing all
 * nodes to appear clustered near (0,0).  We fix this by multiplying the local
 * bbox corners through the element's CTM (cumulative transform matrix) relative
 * to the root <svg>.
 */
function getSvgSpaceBBox(element) {
  const svg = element.ownerSVGElement;
  if (!svg) return element.getBBox();

  const bbox = element.getBBox();
  const elCTM = element.getCTM();
  const svgCTM = svg.getCTM();

  if (!elCTM || !svgCTM) return bbox;

  // Matrix: element-local coords → SVG viewBox coords
  const m = svgCTM.inverse().multiply(elCTM);

  const pt1 = svg.createSVGPoint();
  pt1.x = bbox.x;
  pt1.y = bbox.y;
  const tl = pt1.matrixTransform(m);

  const pt2 = svg.createSVGPoint();
  pt2.x = bbox.x + bbox.width;
  pt2.y = bbox.y + bbox.height;
  const br = pt2.matrixTransform(m);

  return {
    x: Math.min(tl.x, br.x),
    y: Math.min(tl.y, br.y),
    width: Math.abs(br.x - tl.x),
    height: Math.abs(br.y - tl.y),
  };
}

// ── Shape detection from Mermaid source ─────────────────────────────

/**
 * Detect the draw.io style for a Mermaid node based on its bracket syntax.
 */
function detectNodeInfo(definition, nodeId) {
  const re = new RegExp('\\b' + nodeId + '\\s*(?=[\\[({>])');
  const m = definition.match(re);
  if (!m) return { shape: 'box', label: nodeId };

  let pos = m.index + nodeId.length;
  while (pos < definition.length && definition[pos] === ' ') pos++;
  if (pos >= definition.length) return { shape: 'box', label: nodeId };

  const ch = definition[pos];
  const ch2 = pos + 1 < definition.length ? definition[pos + 1] : '';

  let shape = 'box';
  if (ch === '[') {
    if (ch2 === '(') shape = 'cylinder';
    else if (ch2 === '[') shape = 'subroutine';
    else shape = 'box';
  } else if (ch === '(') {
    if (ch2 === '[') shape = 'stadium';
    else if (ch2 === '(') shape = 'circle';
    else shape = 'round';
  } else if (ch === '{') {
    if (ch2 === '{') shape = 'hexagon';
    else shape = 'diamond';
  } else if (ch === '>') {
    shape = 'flag';
  }

  const label = extractLabel(definition, pos);
  return { shape, label: label || nodeId };
}

function extractLabel(str, pos) {
  const brackets = { '[': ']', '(': ')', '{': '}' };
  const open = str[pos];
  const close = brackets[open] || ']';
  let i = pos;
  let depth = 0;
  let start = -1;
  let end = -1;
  let inQuote = false;

  if (open === '>') {
    i++;
    const hasQuote = str[i] === '"';
    if (hasQuote) i++;
    start = i;
    while (i < str.length) {
      if (hasQuote && str[i] === '"') { end = i; break; }
      if (!hasQuote && str[i] === ']') { end = i; break; }
      i++;
    }
    return str.substring(start, end === -1 ? i : end).trim();
  }

  while (i < str.length) {
    const c = str[i];
    if (c === '"') {
      if (!inQuote) { inQuote = true; start = i + 1; }
      else { end = i; break; }
    } else if (!inQuote) {
      if (c === open) depth++;
      else if (c === close) {
        depth--;
        if (depth <= 0) {
          if (start === -1) return extractUnquotedLabel(str, pos);
          end = i;
          break;
        }
      }
    }
    i++;
  }

  if (start >= 0 && end > start) return str.substring(start, end).trim();
  return extractUnquotedLabel(str, pos);
}

function extractUnquotedLabel(str, pos) {
  const brackets = { '[': ']', '(': ')', '{': '}' };
  let i = pos;
  let lastOpen = pos;
  while (i < str.length && str[i] in brackets) { lastOpen = i; i++; }
  const start = i;
  const open = str[lastOpen];
  const close = brackets[open] || ']';
  while (i < str.length && str[i] !== close && str[i] !== '"') i++;
  return str.substring(start, i).trim();
}

// ── Shape to draw.io style mapping ──────────────────────────────────

const SHAPE_STYLES = {
  box:        'rounded=0;whiteSpace=wrap;html=1;',
  round:      'rounded=1;whiteSpace=wrap;html=1;',
  stadium:    'rounded=1;whiteSpace=wrap;html=1;arcSize=50;',
  diamond:    'rhombus;whiteSpace=wrap;html=1;',
  hexagon:    'shape=hexagon;perimeter=hexagonPerimeter2;whiteSpace=wrap;html=1;fixedSize=1;',
  cylinder:   'shape=cylinder3;whiteSpace=wrap;html=1;boundedLbl=1;backgroundOutline=1;size=15;',
  circle:     'ellipse;whiteSpace=wrap;html=1;',
  subroutine: 'shape=process;whiteSpace=wrap;html=1;',
  flag:       'shape=manualInput;whiteSpace=wrap;html=1;',
};

const ARROW_STYLES = {
  '-->':  '',
  '==>':  'strokeWidth=3;',
  '-.->': 'dashed=1;dashPattern=8 8;',
};

// ── Cluster (subgraph) position extraction ──────────────────────────

/**
 * Multi-pass matching between parser subgraphs and SVG .cluster elements.
 * Mirrors the algorithm in renderer.js buildClusterMap().
 */
function buildClusterPositions(svgEl, subgraphs) {
  const clusters = Array.from(svgEl.querySelectorAll('.cluster'));
  const claimed = new Set();
  const positions = new Map();

  function claim(sgId, cluster) {
    claimed.add(cluster);
    positions.set(sgId, getSvgSpaceBBox(cluster));
  }

  // Pass 0: data-id exact match
  for (const sg of subgraphs) {
    for (const cluster of clusters) {
      if (claimed.has(cluster)) continue;
      if (cluster.getAttribute('data-id') === sg.id) { claim(sg.id, cluster); break; }
    }
  }

  // Pass 1: word-boundary match on cluster element ID (longest first)
  const sorted = [...subgraphs].sort((a, b) => b.id.length - a.id.length);
  for (const sg of sorted) {
    if (positions.has(sg.id)) continue;
    const escaped = sg.id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const pattern = new RegExp('(?:^|[^a-zA-Z0-9])' + escaped + '(?:[^a-zA-Z0-9]|$)');
    for (const cluster of clusters) {
      if (claimed.has(cluster)) continue;
      if (pattern.test(cluster.id || '')) { claim(sg.id, cluster); break; }
    }
  }

  // Pass 2-4: label text fallback
  const unmatched = subgraphs.filter(sg => !positions.has(sg.id));
  if (unmatched.length) {
    const clusterLabels = clusters.filter(c => !claimed.has(c)).map(cluster => {
      const labelEl = cluster.querySelector('.cluster-label .nodeLabel, .cluster-label span');
      return { cluster, text: labelEl ? labelEl.textContent.trim() : '' };
    });

    function tryMatch(predicate) {
      for (const sg of unmatched) {
        if (positions.has(sg.id)) continue;
        for (const { cluster, text } of clusterLabels) {
          if (claimed.has(cluster)) continue;
          if (predicate(text, sg.id, sg.label)) { claim(sg.id, cluster); break; }
        }
      }
    }

    tryMatch((text, _id, label) => text === label);
    tryMatch((text, id) => text === id);
    tryMatch((text, id, label) =>
      text.toLowerCase() === label.toLowerCase() ||
      text.toLowerCase() === id.toLowerCase()
    );
  }

  return positions;
}

// ── Node position extraction ────────────────────────────────────────

function buildNodePositions(svgEl) {
  const positions = new Map();
  for (const nodeGroup of svgEl.querySelectorAll('.node')) {
    const idAttr = nodeGroup.getAttribute('id') || '';
    const match = idAttr.match(/flowchart-(.+?)-\d+/);
    if (!match) continue;
    positions.set(match[1], getSvgSpaceBBox(nodeGroup));
  }
  return positions;
}

// ── Subgraph hierarchy helpers ──────────────────────────────────────

function buildNodeParentMap(subgraphs) {
  const nodeParent = new Map();
  const sorted = [...subgraphs].sort((a, b) => a.nodeIds.length - b.nodeIds.length);
  for (const sg of sorted) {
    for (const nid of sg.nodeIds) nodeParent.set(nid, sg.id);
  }
  return nodeParent;
}

function buildSubgraphParentMap(subgraphs) {
  const sgParent = new Map();
  const sorted = [...subgraphs].sort((a, b) =>
    (a.endLine - a.startLine) - (b.endLine - b.startLine)
  );
  for (let i = 0; i < sorted.length; i++) {
    const sg = sorted[i];
    for (let j = i + 1; j < sorted.length; j++) {
      const candidate = sorted[j];
      if (candidate.startLine < sg.startLine && candidate.endLine > sg.endLine) {
        sgParent.set(sg.id, candidate.id);
        break;
      }
    }
  }
  return sgParent;
}

// ── Edge parent (LCA) helper ────────────────────────────────────────

/**
 * Find the lowest common ancestor container for two nodes so that
 * draw.io can resolve edge endpoints across container boundaries.
 */
function findEdgeParent(fromId, toId, nodeParent, sgParent, idMap) {
  // Build ancestor chain for a node: [immediate sg, parent sg, ..., null(root)]
  function ancestors(nodeId) {
    const chain = [];
    let sg = nodeParent.get(nodeId) || null;
    while (sg) {
      chain.push(sg);
      sg = sgParent.get(sg) || null;
    }
    chain.push(null); // root
    return chain;
  }

  const chainA = ancestors(fromId);
  const chainB = new Set(ancestors(toId));

  for (const sg of chainA) {
    if (chainB.has(sg)) {
      return sg ? (idMap.get('sg_' + sg) || 1) : 1;
    }
  }
  return 1;
}

// ── Main export function ────────────────────────────────────────────

/**
 * Generate a .drawio XML string from the current diagram.
 *
 * @param {string} definition - The Mermaid definition source
 * @param {SVGSVGElement} svgEl - The rendered SVG element (must be in the DOM)
 * @param {string} title - Diagram page title
 * @returns {string|null} Complete .drawio XML, or null if no SVG
 */
export function generateDrawioXml(definition, svgEl, title) {
  if (!svgEl) return null;

  const parsed = parseMermaidDefinition(definition);
  const nodePositions = buildNodePositions(svgEl);
  const clusterPositions = buildClusterPositions(svgEl, parsed.subgraphs);
  const nodeParent = buildNodeParentMap(parsed.subgraphs);
  const sgParent = buildSubgraphParentMap(parsed.subgraphs);

  // Normalise: shift everything so top-left starts near (20, 20)
  let minX = Infinity, minY = Infinity;
  for (const p of nodePositions.values()) { minX = Math.min(minX, p.x); minY = Math.min(minY, p.y); }
  for (const p of clusterPositions.values()) { minX = Math.min(minX, p.x); minY = Math.min(minY, p.y); }
  const offsetX = isFinite(minX) ? 20 - minX : 0;
  const offsetY = isFinite(minY) ? 20 - minY : 0;

  // Apply offset to all absolute positions
  for (const [k, p] of nodePositions) nodePositions.set(k, { ...p, x: p.x + offsetX, y: p.y + offsetY });
  for (const [k, p] of clusterPositions) clusterPositions.set(k, { ...p, x: p.x + offsetX, y: p.y + offsetY });

  let nextId = 2;
  const idMap = new Map();
  const cells = [];

  // ── Subgraph containers (outermost first) ──
  const sgSorted = [...parsed.subgraphs].sort((a, b) =>
    (b.endLine - b.startLine) - (a.endLine - a.startLine)
  );

  for (const sg of sgSorted) {
    const cellId = nextId++;
    idMap.set('sg_' + sg.id, cellId);
    const parentCellId = sgParent.has(sg.id) ? idMap.get('sg_' + sgParent.get(sg.id)) : 1;
    const pos = clusterPositions.get(sg.id);

    let x = 0, y = 0, w = 200, h = 100;
    if (pos) {
      const parentSgId = sgParent.get(sg.id);
      const parentPos = parentSgId ? clusterPositions.get(parentSgId) : null;
      x = parentPos ? pos.x - parentPos.x : pos.x;
      y = parentPos ? pos.y - parentPos.y : pos.y;
      w = pos.width;
      h = pos.height;
    }

    cells.push(
      `      <mxCell id="${cellId}" value="${escapeXml(sg.label)}" ` +
      `style="rounded=1;whiteSpace=wrap;html=1;container=1;collapsible=0;` +
      `fillColor=#dae8fc;strokeColor=#6c8ebf;verticalAlign=top;fontStyle=1;" ` +
      `vertex="1" parent="${parentCellId || 1}">\n` +
      `        <mxGeometry x="${Math.round(x)}" y="${Math.round(y)}" ` +
      `width="${Math.round(w)}" height="${Math.round(h)}" as="geometry"/>\n` +
      `      </mxCell>`
    );
  }

  // ── Nodes ──
  const allNodeIds = new Set();
  for (const e of parsed.edges) { allNodeIds.add(e.from); allNodeIds.add(e.to); }
  for (const n of parsed.freeNodes) allNodeIds.add(n.id);

  for (const nodeId of allNodeIds) {
    const cellId = nextId++;
    idMap.set(nodeId, cellId);

    const { shape, label } = detectNodeInfo(definition, nodeId);
    const style = SHAPE_STYLES[shape] || SHAPE_STYLES.box;
    const pos = nodePositions.get(nodeId);

    let x = 0, y = 0, w = 120, h = 60;
    if (pos) {
      const parentSgId = nodeParent.get(nodeId);
      const parentPos = parentSgId ? clusterPositions.get(parentSgId) : null;
      x = parentPos ? pos.x - parentPos.x : pos.x;
      y = parentPos ? pos.y - parentPos.y : pos.y;
      w = pos.width;
      h = pos.height;
    }

    const parentCellId = nodeParent.has(nodeId) ? idMap.get('sg_' + nodeParent.get(nodeId)) : 1;

    cells.push(
      `      <mxCell id="${cellId}" value="${escapeXml(label)}" ` +
      `style="${style}" vertex="1" parent="${parentCellId || 1}">\n` +
      `        <mxGeometry x="${Math.round(x)}" y="${Math.round(y)}" ` +
      `width="${Math.round(w)}" height="${Math.round(h)}" as="geometry"/>\n` +
      `      </mxCell>`
    );
  }

  // ── Edges ──
  for (const edge of parsed.edges) {
    const cellId = nextId++;
    const sourceId = idMap.get(edge.from);
    const targetId = idMap.get(edge.to);
    if (sourceId == null || targetId == null) continue;

    const edgeParent = findEdgeParent(edge.from, edge.to, nodeParent, sgParent, idMap);
    const arrowStyle = ARROW_STYLES[edge.arrow] || '';
    const edgeLabel = edge.label ? escapeXml(edge.label) : '';

    cells.push(
      `      <mxCell id="${cellId}" value="${edgeLabel}" ` +
      `style="edgeStyle=orthogonalEdgeStyle;rounded=1;orthogonalLoop=1;${arrowStyle}" ` +
      `edge="1" source="${sourceId}" target="${targetId}" parent="${edgeParent}">\n` +
      `        <mxGeometry relative="1" as="geometry"/>\n` +
      `      </mxCell>`
    );
  }

  // ── Assemble XML ──
  return `<?xml version="1.0" encoding="UTF-8"?>
<mxfile host="app.diagrams.net" type="device">
  <diagram id="page1" name="${escapeXml(title)}">
    <mxGraphModel dx="1024" dy="768" grid="1" gridSize="10" guides="1" tooltips="1" connect="1" arrows="1" fold="1" page="0" pageScale="1" pageWidth="1169" pageHeight="827">
      <root>
        <mxCell id="0"/>
        <mxCell id="1" parent="0"/>
${cells.join('\n')}
      </root>
    </mxGraphModel>
  </diagram>
</mxfile>`;
}
