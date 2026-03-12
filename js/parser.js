/**
 * Mermaid Definition Parser & Transformer
 *
 * Parses .mmd flowchart definitions to extract subgraph structure,
 * and produces collapsed versions by replacing subgraph contents
 * with summary nodes while redirecting edges.
 */

// Match subgraph start: subgraph ID["Label"] or subgraph ID
const SUBGRAPH_START_RE = /^\s*subgraph\s+(\w+)(?:\s*\["?([^"\]]*)"?\])?\s*$/;

// Match subgraph end
const SUBGRAPH_END_RE = /^\s*end\s*$/;

// Match graph/flowchart header
const HEADER_RE = /^\s*(graph|flowchart)\s+(TB|BT|LR|RL|TD)/i;

// Match any standalone node definition: ID followed by any bracket-based shape
// Covers: A["x"], A("x"), A[("x")], A(["x"]), A(("x")), A[["x"]], A{{"x"}}, A{"x"}, A>"x"], A[/x/], etc.
const NODE_DEF_RE = /^\s*(\w+)\s*[\[({>]/;

/**
 * Skip over a Mermaid node shape definition (e.g. ["text"], ("text"), {{"text"}}, >"text"])
 * starting at position `pos`. Returns the position after the closing bracket,
 * or `startPos` if no shape is found.
 */
function skipNodeShape(str, pos) {
  const startPos = pos;
  while (pos < str.length && str[pos] === ' ') pos++;
  if (pos >= str.length) return startPos;

  const ch = str[pos];
  const brackets = { '[': ']', '(': ')', '{': '}' };

  // Flag shape: >text]
  if (ch === '>') {
    pos++;
    let inQuote = false;
    while (pos < str.length) {
      if (str[pos] === '"') inQuote = !inQuote;
      else if (!inQuote && str[pos] === ']') { pos++; return pos; }
      pos++;
    }
    return startPos;
  }

  if (!(ch in brackets)) return startPos;

  const open = ch;
  const close = brackets[open];
  let depth = 0;
  let inQuote = false;
  while (pos < str.length) {
    const c = str[pos];
    if (c === '"') inQuote = !inQuote;
    else if (!inQuote) {
      if (c === open) depth++;
      else if (c === close) {
        depth--;
        if (depth <= 0) { pos++; return pos; }
      }
    }
    pos++;
  }
  return startPos; // unclosed bracket — treat as no shape
}

/**
 * Try to parse one arrow + label starting at position `pos` in `str`.
 * Returns { arrow, label, consumed } or null if no arrow found.
 */
function parseArrow(str, pos) {
  const rest = str.substring(pos);
  let arrow = null, label = '', consumed = 0;
  let m;

  // Inline label patterns: -- "text" --> / -- text -->
  if ((m = rest.match(/^--\s+"([^"]*)"\s*-->/))) {
    arrow = '-->'; label = m[1]; consumed = m[0].length;
  } else if ((m = rest.match(/^--\s+(.+?)\s+-->/))) {
    arrow = '-->'; label = m[1]; consumed = m[0].length;
  // Inline label: == "text" ==> / == text ==>
  } else if ((m = rest.match(/^==\s+"([^"]*)"\s*==>/))) {
    arrow = '==>'; label = m[1]; consumed = m[0].length;
  } else if ((m = rest.match(/^==\s+(.+?)\s+==>/))) {
    arrow = '==>'; label = m[1]; consumed = m[0].length;
  // Inline label: -. "text" .-> / -. text .->
  } else if ((m = rest.match(/^-\.\s+"([^"]*)"\s*\.->/))) {
    arrow = '-.->'; label = m[1]; consumed = m[0].length;
  } else if ((m = rest.match(/^-\.\s+(.+?)\s+\.->/))) {
    arrow = '-.->'; label = m[1]; consumed = m[0].length;
  }

  // Direct arrow with optional pipe label
  if (!arrow) {
    m = rest.match(/^(-+->|=+=>|-\.+->)\s*(?:\|([^|]*)\|)?/);
    if (!m) return null;
    arrow = m[1]; label = (m[2] || '').trim(); consumed = m[0].length;
  }

  return { arrow, label: label.trim(), consumed };
}

/**
 * Parse all edges from a Mermaid edge line (handles chains like A --> B --> C).
 * Returns array of { from, to, arrow, label } objects, or empty array.
 * Supports:
 *   - A --> B, A ==> B, A -.-> B          (direct arrows)
 *   - A -->|label| B                       (pipe label)
 *   - A -- "label" --> B, A -- label --> B (inline label)
 *   - A["text"] --> B["text"]              (node shape definitions on either side)
 *   - A --> B --> C --> D                   (chained edges)
 */
function parseEdges(trimmed) {
  const edges = [];
  const fromMatch = trimmed.match(/^(\w+)/);
  if (!fromMatch) return edges;

  let currentNode = fromMatch[1];
  let pos = currentNode.length;

  // Skip optional node shape definition on the first node
  pos = skipNodeShape(trimmed, pos);

  while (pos < trimmed.length) {
    // Skip whitespace
    while (pos < trimmed.length && trimmed[pos] === ' ') pos++;
    if (pos >= trimmed.length) break;

    const arrowResult = parseArrow(trimmed, pos);
    if (!arrowResult) break;

    pos += arrowResult.consumed;

    // Skip whitespace after arrow
    while (pos < trimmed.length && trimmed[pos] === ' ') pos++;

    // Extract "to" node ID
    const toMatch = trimmed.substring(pos).match(/^(\w+)/);
    if (!toMatch) break;

    const toNode = toMatch[1];
    pos += toNode.length;

    edges.push({ from: currentNode, to: toNode, arrow: arrowResult.arrow, label: arrowResult.label });

    currentNode = toNode;

    // Skip optional node shape on "to" node
    pos = skipNodeShape(trimmed, pos);
  }

  return edges;
}

/**
 * Extract a standalone node definition from an edge line.
 * E.g., from 'A["label"] --> B["text"]' and nodeId "B",
 * returns '  B["text"]'. Returns null if no inline shape found.
 */
function extractInlineDef(line, nodeId) {
  const re = new RegExp('\\b' + nodeId + '(?=\\s*[\\[({>])');
  const m = line.match(re);
  if (!m) return null;
  const idEnd = m.index + nodeId.length;
  const shapeEnd = skipNodeShape(line, idEnd);
  if (shapeEnd === idEnd) return null;
  return '  ' + line.substring(m.index, shapeEnd);
}

/**
 * Parse a Mermaid flowchart definition and extract structure.
 */
export function parseMermaidDefinition(definition) {
  const lines = definition.split('\n');
  const subgraphs = []; // { id, label, startLine, endLine, nodeIds: [] }
  const edges = [];     // { from, to, label, line }
  let header = '';

  const subgraphStack = [];
  const allNodeIds = new Set();
  const subgraphNodeIds = new Set(); // nodes that belong to any subgraph

  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i].trim();
    if (!trimmed || trimmed.startsWith('%%')) continue;

    // Header
    if (HEADER_RE.test(trimmed)) {
      header = trimmed;
      continue;
    }

    // Subgraph start
    const sgMatch = trimmed.match(SUBGRAPH_START_RE);
    if (sgMatch) {
      subgraphStack.push({
        id: sgMatch[1],
        label: sgMatch[2] || sgMatch[1],
        startLine: i,
        endLine: -1,
        nodeIds: [],
      });
      continue;
    }

    // Subgraph end
    if (SUBGRAPH_END_RE.test(trimmed)) {
      if (subgraphStack.length > 0) {
        const sg = subgraphStack.pop();
        sg.endLine = i;
        sg.nodeIds = [...new Set(sg.nodeIds)];
        subgraphs.push(sg);
      }
      continue;
    }

    // Edge line (supports chained edges like A --> B --> C)
    const edgeList = parseEdges(trimmed);
    if (edgeList.length > 0) {
      for (const edgeInfo of edgeList) {
        const { from, to } = edgeInfo;
        edges.push({ ...edgeInfo, line: i });

        allNodeIds.add(from);
        allNodeIds.add(to);

        // Register nodes in ALL ancestor subgraphs (not just innermost)
        if (subgraphStack.length > 0) {
          for (const sg of subgraphStack) {
            sg.nodeIds.push(from, to);
          }
          subgraphNodeIds.add(from);
          subgraphNodeIds.add(to);
        }
      }
      continue;
    }

    // Standalone node definition
    const nodeMatch = trimmed.match(NODE_DEF_RE);
    if (nodeMatch) {
      const id = nodeMatch[1];
      // Skip keywords
      if (['subgraph', 'end', 'graph', 'flowchart', 'style', 'classDef', 'click', 'linkStyle'].includes(id)) continue;

      allNodeIds.add(id);
      // Register node in ALL ancestor subgraphs (not just innermost)
      if (subgraphStack.length > 0) {
        for (const sg of subgraphStack) {
          sg.nodeIds.push(id);
        }
        subgraphNodeIds.add(id);
      }
    }
  }

  // Free nodes = all nodes not inside any subgraph
  const freeNodes = [];
  for (const id of allNodeIds) {
    if (!subgraphNodeIds.has(id)) {
      freeNodes.push({ id });
    }
  }

  return { header, subgraphs, edges, freeNodes, lines };
}

/**
 * Transform a Mermaid definition by collapsing specified subgraphs.
 *
 * Uses a single-pass line iterator to preserve the original nesting structure.
 * Collapsed subgraphs are replaced in-place with a summary node.
 *
 * @param {string} definition - Original .mmd content
 * @param {Set<string>} collapsedIds - Set of subgraph IDs to collapse
 * @returns {string} - Transformed Mermaid definition
 */
export function transformDefinition(definition, collapsedIds, prebuiltParsed) {
  if (!collapsedIds || collapsedIds.size === 0) return definition;

  const parsed = prebuiltParsed || parseMermaidDefinition(definition);
  const { subgraphs, edges } = parsed;
  const lines = definition.split('\n');

  // Build subgraph map
  const sgMap = new Map();
  for (const sg of subgraphs) {
    sgMap.set(sg.id, sg);
  }

  // Build collapsed line ranges (must be built before nodeToSummary)
  const collapsedRanges = [];
  for (const sgId of collapsedIds) {
    const sg = sgMap.get(sgId);
    if (!sg) continue;
    collapsedRanges.push({ start: sg.startLine, end: sg.endLine, id: sgId });
  }

  function isLineInCollapsedRange(lineIdx) {
    for (const r of collapsedRanges) {
      if (lineIdx >= r.start && lineIdx <= r.end) return true;
    }
    return false;
  }

  // Check if a subgraph is nested inside another collapsed subgraph
  function isNestedInCollapsedRange(sg) {
    for (const r of collapsedRanges) {
      if (r.id === sg.id) continue;
      if (sg.startLine >= r.start && sg.endLine <= r.end) return true;
    }
    return false;
  }

  // Map each collapsed internal node -> its outermost collapsed subgraph ID (summary node)
  // Skip nested collapsed subgraphs — their nodes belong to the outer collapsed parent
  const nodeToSummary = new Map();
  for (const sgId of collapsedIds) {
    const sg = sgMap.get(sgId);
    if (!sg || isNestedInCollapsedRange(sg)) continue;
    for (const nodeId of sg.nodeIds) {
      nodeToSummary.set(nodeId, sgId);
    }
  }

  // Build edge lookup by line number (multiple edges per line for chains)
  const edgesByLine = new Map();
  for (const edge of edges) {
    if (!edgesByLine.has(edge.line)) {
      edgesByLine.set(edge.line, []);
    }
    edgesByLine.get(edge.line).push(edge);
  }

  // Track inserted summary nodes and deduplicated redirected edges
  const insertedSummaries = new Set();
  const emittedEdges = new Set();

  // Single pass through all lines, preserving original order and nesting
  const outputLines = [];

  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i].trim();

    // Preserve blank lines and comments (unless inside collapsed range)
    if (!trimmed || trimmed.startsWith('%%')) {
      if (!isLineInCollapsedRange(i)) {
        outputLines.push(lines[i]);
      }
      continue;
    }

    // If this line is inside a collapsed range...
    if (isLineInCollapsedRange(i)) {
      // At the start line of a collapsed subgraph, emit a summary node
      // but only if it's not nested inside another collapsed subgraph
      const sgMatch = trimmed.match(SUBGRAPH_START_RE);
      if (sgMatch && collapsedIds.has(sgMatch[1]) && !insertedSummaries.has(sgMatch[1])) {
        const sg = sgMap.get(sgMatch[1]);
        if (sg && !isNestedInCollapsedRange(sg)) {
          insertedSummaries.add(sg.id);
          outputLines.push(`  ${sg.id}["[+] ${sg.label} (${sg.nodeIds.length} nodes)"]`);
        }
      }
      // Skip all other lines inside collapsed ranges
      continue;
    }

    // Handle edge lines: redirect endpoints if they point to collapsed nodes
    const lineEdges = edgesByLine.get(i);
    if (lineEdges) {
      // Check if any edge in the chain needs redirection
      let needsRedirect = false;
      for (const edge of lineEdges) {
        if (nodeToSummary.has(edge.from) || nodeToSummary.has(edge.to)) {
          needsRedirect = true;
          break;
        }
      }

      if (!needsRedirect) {
        // No redirect needed — preserve original line with node definitions intact
        outputLines.push(lines[i]);
      } else {
        // At least one edge needs redirection — break chain into individual edges
        const seenDefs = new Set();
        for (const edge of lineEdges) {
          const fromRedirected = nodeToSummary.has(edge.from);
          const toRedirected = nodeToSummary.has(edge.to);
          const from = fromRedirected ? nodeToSummary.get(edge.from) : edge.from;
          const to = toRedirected ? nodeToSummary.get(edge.to) : edge.to;

          // Skip self-loops (internal edges within same collapsed subgraph)
          if (from === to) continue;

          // Deduplicate redirected edges
          const edgeKey = `${from}-->${to}`;
          if (emittedEdges.has(edgeKey)) continue;
          emittedEdges.add(edgeKey);

          // Preserve inline node definitions for non-redirected endpoints
          if (!fromRedirected && !seenDefs.has(edge.from)) {
            const def = extractInlineDef(lines[i], edge.from);
            if (def) { outputLines.push(def); seenDefs.add(edge.from); }
          }
          if (!toRedirected && !seenDefs.has(edge.to)) {
            const def = extractInlineDef(lines[i], edge.to);
            if (def) { outputLines.push(def); seenDefs.add(edge.to); }
          }

          if (edge.label) {
            outputLines.push(`  ${from} ${edge.arrow}|${edge.label}| ${to}`);
          } else {
            outputLines.push(`  ${from} ${edge.arrow} ${to}`);
          }
        }
      }
      continue;
    }

    // All other lines: pass through as-is
    outputLines.push(lines[i]);
  }

  return outputLines.join('\n');
}

/**
 * Extract the internal content of a specific subgraph as a standalone diagram.
 * Includes all nested subgraphs, nodes, and edges that are fully inside.
 *
 * @param {string} definition - Full parent diagram definition
 * @param {string} subgraphId - The subgraph ID to extract
 * @returns {string|null} - A standalone mermaid definition, or null if not found
 */
export function extractSubgraphContent(definition, subgraphId) {
  const parsed = parseMermaidDefinition(definition);
  const header = parsed.header || 'graph TB';

  // Find the target subgraph
  const target = parsed.subgraphs.find(sg => sg.id === subgraphId);
  if (!target) return null;

  const lines = definition.split('\n');

  // Collect lines between subgraph start and end (exclusive of the subgraph/end markers)
  // We need to handle nested subgraphs: keep inner subgraph/end pairs, only skip the outermost
  const contentLines = [];
  for (let i = target.startLine + 1; i < target.endLine; i++) {
    const trimmed = lines[i].trim();
    if (!trimmed) continue;
    contentLines.push(lines[i]);
  }

  // Also include edges from outside the subgraph that connect two nodes both inside it
  const nodeSet = new Set(target.nodeIds);
  for (const edge of parsed.edges) {
    // Skip edges already inside the subgraph line range
    if (edge.line > target.startLine && edge.line < target.endLine) continue;
    // Only include if both endpoints are inside this subgraph
    if (nodeSet.has(edge.from) && nodeSet.has(edge.to)) {
      if (edge.label) {
        contentLines.push(`  ${edge.from} ${edge.arrow}|${edge.label}| ${edge.to}`);
      } else {
        contentLines.push(`  ${edge.from} ${edge.arrow} ${edge.to}`);
      }
    }
  }

  if (contentLines.length === 0) return null;

  return header + '\n' + contentLines.join('\n') + '\n';
}

/**
 * Extract subgraph IDs from a definition (for UI controls).
 */
export function extractSubgraphIds(definition, prebuiltParsed) {
  const parsed = prebuiltParsed || parseMermaidDefinition(definition);
  return parsed.subgraphs.map(sg => ({ id: sg.id, label: sg.label }));
}
