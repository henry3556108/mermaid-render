/**
 * Mermaid Definition Parser & Transformer
 *
 * Parses .mmd flowchart definitions to extract subgraph structure,
 * and produces collapsed versions by replacing subgraph contents
 * with summary nodes while redirecting edges.
 */

// Edge arrow patterns: -->, --->, ===>, -.->, -.->
const EDGE_PATTERN = /(-+->|=+=>|-\.+->)/;

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

      if (subgraphStack.length > 0) {
        const currentSg = subgraphStack[subgraphStack.length - 1];
        currentSg.nodeIds.push(from, to);
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
      if (subgraphStack.length > 0) {
        const currentSg = subgraphStack[subgraphStack.length - 1];
        currentSg.nodeIds.push(id);
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
 * @param {string} definition - Original .mmd content
 * @param {Set<string>} collapsedIds - Set of subgraph IDs to collapse
 * @returns {string} - Transformed Mermaid definition
 */
export function transformDefinition(definition, collapsedIds) {
  if (!collapsedIds || collapsedIds.size === 0) return definition;

  const parsed = parseMermaidDefinition(definition);
  const { header, subgraphs, edges } = parsed;
  const lines = definition.split('\n');

  // Build subgraph map
  const sgMap = new Map();
  for (const sg of subgraphs) {
    sgMap.set(sg.id, sg);
  }

  // Build set of all nodes inside collapsed subgraphs
  // and map each collapsed internal node -> summary node ID
  const nodeToSummary = new Map();
  const allCollapsedNodes = new Set();

  for (const sgId of collapsedIds) {
    const sg = sgMap.get(sgId);
    if (!sg) continue;
    for (const nodeId of sg.nodeIds) {
      nodeToSummary.set(nodeId, sgId);
      allCollapsedNodes.add(nodeId);
    }
  }

  // Build subgraph line ranges for checking if a line is inside a subgraph
  const subgraphRanges = subgraphs.map(sg => ({
    id: sg.id,
    start: sg.startLine,
    end: sg.endLine,
  }));

  function isInsideSubgraph(lineIdx) {
    for (const r of subgraphRanges) {
      if (lineIdx >= r.start && lineIdx <= r.end) return r.id;
    }
    return null;
  }

  // Rebuild the definition
  const outputLines = [];
  outputLines.push(header || 'graph TB');

  // 1. Emit collapsed subgraphs as summary nodes
  for (const sgId of collapsedIds) {
    const sg = sgMap.get(sgId);
    if (!sg) continue;
    outputLines.push(`  ${sgId}["[+] ${sg.label} (${sg.nodeIds.length} nodes)"]`);
  }

  // 2. Emit non-collapsed subgraphs (their original lines, but skip edges involving collapsed nodes)
  for (const sg of subgraphs) {
    if (collapsedIds.has(sg.id)) continue;

    for (let i = sg.startLine; i <= sg.endLine; i++) {
      // Check if this line is an edge involving a collapsed node
      let skip = false;
      for (const edge of edges) {
        if (edge.line === i) {
          if (allCollapsedNodes.has(edge.from) || allCollapsedNodes.has(edge.to)) {
            skip = true;
            break;
          }
        }
      }
      if (!skip) {
        outputLines.push(lines[i]);
      }
    }
  }

  // 3. Emit free lines (outside any subgraph, not edges, not header)
  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i].trim();
    if (!trimmed || trimmed.startsWith('%%')) continue;
    if (HEADER_RE.test(trimmed)) continue;
    if (isInsideSubgraph(i) !== null) continue;

    // Skip edge lines (we handle all edges below)
    let isEdge = false;
    for (const edge of edges) {
      if (edge.line === i) { isEdge = true; break; }
    }
    if (isEdge) continue;

    // It's a free node definition — emit it
    outputLines.push(lines[i]);
  }

  // 4. Emit all edges, redirecting those involving collapsed nodes
  const emittedEdges = new Set();
  for (const edge of edges) {
    let from = edge.from;
    let to = edge.to;

    // Redirect if endpoint is inside a collapsed subgraph
    if (nodeToSummary.has(from)) from = nodeToSummary.get(from);
    if (nodeToSummary.has(to)) to = nodeToSummary.get(to);

    // Skip self-loops (internal edges within same collapsed subgraph)
    if (from === to) continue;

    // Deduplicate
    const edgeKey = `${from}-->${to}`;
    if (emittedEdges.has(edgeKey)) continue;
    emittedEdges.add(edgeKey);

    if (edge.label) {
      outputLines.push(`  ${from} -->|${edge.label}| ${to}`);
    } else {
      outputLines.push(`  ${from} --> ${to}`);
    }
  }

  return outputLines.join('\n');
}

/**
 * Extract subgraph IDs from a definition (for UI controls).
 */
export function extractSubgraphIds(definition) {
  const parsed = parseMermaidDefinition(definition);
  return parsed.subgraphs.map(sg => ({ id: sg.id, label: sg.label }));
}
