/**
 * Mermaid Definition Parser & Transformer
 *
 * Parses .mmd flowchart definitions to extract subgraph structure,
 * and produces collapsed versions by replacing subgraph contents
 * with summary nodes while redirecting edges.
 */

// Match an edge line: NodeA --> NodeB  or  NodeA -->|label| NodeB
const EDGE_LINE_RE = /^\s*(\w+)\s*(-+->|=+=>|-\.+->)\s*(?:\|([^|]*)\|\s*)?(\w+)/;

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

    // Edge line
    const edgeMatch = trimmed.match(EDGE_LINE_RE);
    if (edgeMatch) {
      const from = edgeMatch[1];
      const to = edgeMatch[4];
      const label = (edgeMatch[3] || '').trim();
      edges.push({ from, to, label, line: i });

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

  // Map each collapsed internal node -> its collapsed subgraph ID (summary node)
  const nodeToSummary = new Map();
  for (const sgId of collapsedIds) {
    const sg = sgMap.get(sgId);
    if (!sg) continue;
    for (const nodeId of sg.nodeIds) {
      nodeToSummary.set(nodeId, sgId);
    }
  }

  // Build collapsed line ranges
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

  // Build edge lookup by line number
  const edgeByLine = new Map();
  for (const edge of edges) {
    edgeByLine.set(edge.line, edge);
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
      const sgMatch = trimmed.match(SUBGRAPH_START_RE);
      if (sgMatch && collapsedIds.has(sgMatch[1]) && !insertedSummaries.has(sgMatch[1])) {
        const sg = sgMap.get(sgMatch[1]);
        if (sg) {
          insertedSummaries.add(sg.id);
          outputLines.push(`  ${sg.id}["[+] ${sg.label} (${sg.nodeIds.length} nodes)"]`);
        }
      }
      // Skip all other lines inside collapsed ranges
      continue;
    }

    // Handle edge lines: redirect endpoints if they point to collapsed nodes
    const edge = edgeByLine.get(i);
    if (edge) {
      let from = edge.from;
      let to = edge.to;

      if (nodeToSummary.has(from)) from = nodeToSummary.get(from);
      if (nodeToSummary.has(to)) to = nodeToSummary.get(to);

      // Skip self-loops (internal edges within same collapsed subgraph)
      if (from === to) continue;

      // Deduplicate redirected edges
      const edgeKey = `${from}-->${to}`;
      if (emittedEdges.has(edgeKey)) continue;
      emittedEdges.add(edgeKey);

      if (edge.label) {
        outputLines.push(`  ${from} -->|${edge.label}| ${to}`);
      } else {
        outputLines.push(`  ${from} --> ${to}`);
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
        contentLines.push(`  ${edge.from} -->|${edge.label}| ${edge.to}`);
      } else {
        contentLines.push(`  ${edge.from} --> ${edge.to}`);
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
