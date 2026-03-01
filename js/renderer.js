/**
 * Mermaid Renderer
 * Wraps mermaid.render() and manages SVG insertion, click binding,
 * and pan/zoom on the canvas.
 */

let renderCounter = 0;

// Pan/zoom state
let scale = 1;
let panX = 0;
let panY = 0;
let isDragging = false;
let dragStartX = 0;
let dragStartY = 0;
let panStartX = 0;
let panStartY = 0;

const MIN_SCALE = 0.2;
const MAX_SCALE = 3;

let canvasContainer = null;
let diagramCanvas = null;

// Hover/dblclick state
let tooltipEl = null;
let currentHighlight = null;
let currentDrillTargets = {};
let currentSubgraphIds = [];
let currentOnDrill = () => { };
let currentOnCreateDrill = () => { };
let currentOnHoverDrillable = () => { };
let currentOnClickDrillable = () => { };
let lastHoveredDrillTarget = null;

// Cluster map: bidirectional mapping between subgraph IDs and cluster DOM elements
let clusterMap = new Map();        // subgraphId → cluster element
let reverseClusterMap = new Map(); // cluster element → { id, label }
let hasDragged = false;
let clickTimer = null;

export function initRenderer() {
  canvasContainer = document.getElementById('canvas-container');
  diagramCanvas = document.getElementById('diagram-canvas');

  // Initialize Mermaid
  window.mermaid.initialize({
    startOnLoad: false,
    securityLevel: 'loose',
    theme: 'default',
    flowchart: {
      useMaxWidth: false,
      htmlLabels: true,
      curve: 'basis',
    },
  });

  tooltipEl = document.getElementById('svg-tooltip');

  setupPanZoom();
  setupHoverAndDblClick();
}

/**
 * Build bidirectional maps between subgraph IDs and cluster DOM elements.
 * Called once after each render. Uses priority-based matching:
 *   Pass 0 — data-id attribute exact match (Mermaid v11+)
 *   Pass 1 — word-boundary match on cluster element ID
 *   Pass 2 — exact match on label text
 *   Pass 3 — exact match on ID text
 *   Pass 4 — case-insensitive exact match fallback
 */
function buildClusterMap(subgraphIds) {
  clusterMap.clear();
  reverseClusterMap.clear();

  const svgEl = diagramCanvas.querySelector('svg');
  if (!svgEl) return;

  const clusters = Array.from(svgEl.querySelectorAll('.cluster'));
  const claimed = new Set();

  // Helper to claim a cluster for a subgraph
  function claim(sgId, sgLabel, cluster) {
    clusterMap.set(sgId, cluster);
    reverseClusterMap.set(cluster, { id: sgId, label: sgLabel });
    claimed.add(cluster);
  }

  // Pass 0: exact match on data-id attribute (Mermaid v11+ sets this)
  for (const sgInfo of subgraphIds) {
    const sgId = typeof sgInfo === 'string' ? sgInfo : sgInfo.id;
    const sgLabel = typeof sgInfo === 'string' ? sgId : sgInfo.label;
    for (const cluster of clusters) {
      if (claimed.has(cluster)) continue;
      const dataId = cluster.getAttribute('data-id');
      if (dataId && dataId === sgId) {
        claim(sgId, sgLabel, cluster);
        break;
      }
    }
  }

  // Pass 1: match by cluster element ID with word-boundary regex.
  // Mermaid generates IDs like "flowchart-{SubgraphId}-{counter}".
  // Sort by sgId length descending so longer IDs match first,
  // preventing "Auth" from stealing the cluster for "AuthService".
  const sorted = [...subgraphIds].sort((a, b) => {
    const idA = typeof a === 'string' ? a : a.id;
    const idB = typeof b === 'string' ? b : b.id;
    return idB.length - idA.length;
  });

  for (const sgInfo of sorted) {
    const sgId = typeof sgInfo === 'string' ? sgInfo : sgInfo.id;
    if (clusterMap.has(sgId)) continue;
    const sgLabel = typeof sgInfo === 'string' ? sgId : sgInfo.label;

    // Word-boundary pattern to avoid substring false positives
    // e.g. "Gateway" must not match "PaymentGateway"
    const escaped = sgId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const pattern = new RegExp('(?:^|[^a-zA-Z0-9])' + escaped + '(?:[^a-zA-Z0-9]|$)');

    for (const cluster of clusters) {
      if (claimed.has(cluster)) continue;
      const cid = cluster.id || '';
      if (pattern.test(cid)) {
        claim(sgId, sgLabel, cluster);
        break;
      }
    }
  }

  // Pass 2–4: label text fallback for any subgraphs not matched by ID/data-id
  const unmatched = subgraphIds.filter(sgInfo => {
    const sgId = typeof sgInfo === 'string' ? sgInfo : sgInfo.id;
    return !clusterMap.has(sgId);
  });

  if (unmatched.length === 0) return;

  const clusterLabels = clusters.filter(c => !claimed.has(c)).map(cluster => {
    const labelEl = cluster.querySelector('.cluster-label .nodeLabel, .cluster-label span');
    return { cluster, text: labelEl ? labelEl.textContent.trim() : '' };
  });

  function tryMatch(predicate) {
    for (const sgInfo of unmatched) {
      const sgId = typeof sgInfo === 'string' ? sgInfo : sgInfo.id;
      if (clusterMap.has(sgId)) continue;
      const sgLabel = typeof sgInfo === 'string' ? sgId : sgInfo.label;

      for (const { cluster, text } of clusterLabels) {
        if (claimed.has(cluster)) continue;
        if (predicate(text, sgId, sgLabel)) {
          claim(sgId, sgLabel, cluster);
          break;
        }
      }
    }
  }

  // Pass 2: exact label match
  tryMatch((text, _id, label) => text === label);
  // Pass 3: exact ID match
  tryMatch((text, id, _label) => text === id);
  // Pass 4: case-insensitive exact match (no substring matching)
  tryMatch((text, id, label) =>
    text.toLowerCase() === label.toLowerCase() ||
    text.toLowerCase() === id.toLowerCase()
  );
}

/**
 * Identify a hovered/clicked SVG element as a node or subgraph.
 * Returns { type, id, label, element } or null.
 */
function identifyElement(target) {
  // Ignore preview overlay elements
  if (target.closest('#link-preview-overlay')) return null;
  // Ignore interactive controls
  if (target.closest('.subgraph-toggle, .drill-btn, a, button')) return null;

  // Try node
  const nodeGroup = target.closest('.node');
  if (nodeGroup) {
    // Mermaid v11 puts the id on the .node group itself (e.g. id="flowchart-A-0")
    // Check the group's own id first, then fall back to child elements
    const candidates = [nodeGroup, ...nodeGroup.querySelectorAll('[id*="flowchart-"]')];
    for (const el of candidates) {
      const elId = el.getAttribute('id') || '';
      const match = elId.match(/flowchart-([^-]+)-/);
      if (match) {
        const nodeId = match[1];
        const labelEl = nodeGroup.querySelector('.nodeLabel');
        const label = labelEl ? labelEl.textContent.trim() : nodeId;
        return { type: 'node', id: nodeId, label, element: nodeGroup };
      }
    }
  }

  // Try subgraph cluster — look up in pre-built reverse map
  const cluster = target.closest('.cluster');
  if (cluster) {
    const info = reverseClusterMap.get(cluster);
    if (info) {
      return { type: 'subgraph', id: info.id, label: info.label, element: cluster };
    }
  }

  return null;
}

function setupHoverAndDblClick() {
  // mousemove — show tooltip + highlight
  canvasContainer.addEventListener('mousemove', (e) => {
    if (isDragging) return;
    const info = identifyElement(e.target);

    // Clear previous highlight
    if (currentHighlight && (!info || info.element !== currentHighlight)) {
      currentHighlight.classList.remove('hover-highlight');
      currentHighlight = null;
    }

    if (!info) {
      tooltipEl.style.display = 'none';
      if (lastHoveredDrillTarget !== null) {
        lastHoveredDrillTarget = null;
        currentOnHoverDrillable(null);
      }
      return;
    }

    // Add highlight
    if (info.element !== currentHighlight) {
      info.element.classList.add('hover-highlight');
      currentHighlight = info.element;
    }

    // Notify hover drillable callback
    const drillTarget = currentDrillTargets[info.id] || null;
    if (drillTarget !== lastHoveredDrillTarget) {
      lastHoveredDrillTarget = drillTarget;
      currentOnHoverDrillable(drillTarget);
    }

    // Tooltip content
    const typeLabel = info.type === 'node' ? 'Node' : 'Subgraph';
    const hasDrill = currentDrillTargets[info.id];
    const action = hasDrill ? 'double-click to navigate' : 'double-click to create sub-diagram';
    tooltipEl.textContent = `${typeLabel}: ${info.label} — ${action}`;

    // Position tooltip near cursor, within canvas-container
    const containerRect = canvasContainer.getBoundingClientRect();
    let left = e.clientX - containerRect.left + 12;
    let top = e.clientY - containerRect.top - 28;

    // Clamp so tooltip doesn't overflow
    const ttWidth = tooltipEl.offsetWidth || 200;
    if (left + ttWidth > containerRect.width - 8) {
      left = e.clientX - containerRect.left - ttWidth - 8;
    }
    if (top < 4) top = 4;

    tooltipEl.style.left = left + 'px';
    tooltipEl.style.top = top + 'px';
    tooltipEl.style.display = '';
  });

  // mouseleave — hide tooltip + remove highlight
  canvasContainer.addEventListener('mouseleave', () => {
    tooltipEl.style.display = 'none';
    if (currentHighlight) {
      currentHighlight.classList.remove('hover-highlight');
      currentHighlight = null;
    }
    if (lastHoveredDrillTarget !== null) {
      lastHoveredDrillTarget = null;
      currentOnHoverDrillable(null);
    }
  });

  // click — pin preview for drillable elements (delayed to distinguish from dblclick)
  canvasContainer.addEventListener('click', (e) => {
    if (hasDragged) return;
    if (e.target.closest('#link-preview-overlay')) return;
    if (e.target.closest('.subgraph-toggle, .drill-btn')) return;

    const info = identifyElement(e.target);
    clearTimeout(clickTimer);
    clickTimer = setTimeout(() => {
      if (!info) {
        currentOnClickDrillable(null);
        return;
      }
      const targetDiagramId = currentDrillTargets[info.id] || null;
      currentOnClickDrillable(targetDiagramId);
    }, 250);
  });

  // dblclick — drill or create (cancels pending single-click)
  canvasContainer.addEventListener('dblclick', (e) => {
    clearTimeout(clickTimer);
    if (e.target.closest('#link-preview-overlay')) return;
    if (e.target.closest('.subgraph-toggle, .drill-btn')) return;

    const info = identifyElement(e.target);
    if (!info) return;

    const targetDiagramId = currentDrillTargets[info.id];
    if (targetDiagramId) {
      currentOnDrill(targetDiagramId);
    } else {
      currentOnCreateDrill(info.id, info.label, info.type);
    }
  });
}

function setupPanZoom() {
  // Mouse wheel zoom
  canvasContainer.addEventListener('wheel', (e) => {
    if (e.target.closest('#link-preview-overlay')) return;
    e.preventDefault();
    const rect = canvasContainer.getBoundingClientRect();
    const mouseX = e.clientX - rect.left;
    const mouseY = e.clientY - rect.top;

    const oldScale = scale;
    const factor = Math.pow(1.001, -e.deltaY);
    scale = Math.min(MAX_SCALE, Math.max(MIN_SCALE, scale * factor));

    // Zoom toward mouse position
    panX = mouseX - (mouseX - panX) * (scale / oldScale);
    panY = mouseY - (mouseY - panY) * (scale / oldScale);

    applyTransform();
  }, { passive: false });

  // Pan with mouse drag
  canvasContainer.addEventListener('mousedown', (e) => {
    if (e.button !== 0) return;
    if (e.target.closest('#link-preview-overlay')) return;
    // Don't start drag if clicking on interactive element
    if (e.target.closest('.subgraph-toggle, .drill-btn, a, button')) return;
    isDragging = true;
    hasDragged = false;
    dragStartX = e.clientX;
    dragStartY = e.clientY;
    panStartX = panX;
    panStartY = panY;
    canvasContainer.classList.add('dragging');
  });

  window.addEventListener('mousemove', (e) => {
    if (!isDragging) return;
    if (!hasDragged) {
      const dx = Math.abs(e.clientX - dragStartX);
      const dy = Math.abs(e.clientY - dragStartY);
      if (dx > 3 || dy > 3) hasDragged = true;
    }
    panX = panStartX + (e.clientX - dragStartX);
    panY = panStartY + (e.clientY - dragStartY);
    applyTransform();
  });

  window.addEventListener('mouseup', () => {
    isDragging = false;
    canvasContainer.classList.remove('dragging');
  });

  // Touch support
  let lastTouchDist = 0;
  canvasContainer.addEventListener('touchstart', (e) => {
    if (e.touches.length === 1) {
      isDragging = true;
      dragStartX = e.touches[0].clientX;
      dragStartY = e.touches[0].clientY;
      panStartX = panX;
      panStartY = panY;
    } else if (e.touches.length === 2) {
      lastTouchDist = Math.hypot(
        e.touches[1].clientX - e.touches[0].clientX,
        e.touches[1].clientY - e.touches[0].clientY
      );
    }
  }, { passive: true });

  canvasContainer.addEventListener('touchmove', (e) => {
    if (e.touches.length === 1 && isDragging) {
      panX = panStartX + (e.touches[0].clientX - dragStartX);
      panY = panStartY + (e.touches[0].clientY - dragStartY);
      applyTransform();
    } else if (e.touches.length === 2) {
      const dist = Math.hypot(
        e.touches[1].clientX - e.touches[0].clientX,
        e.touches[1].clientY - e.touches[0].clientY
      );
      const delta = (dist - lastTouchDist) * 0.005;
      scale = Math.min(MAX_SCALE, Math.max(MIN_SCALE, scale + delta));
      lastTouchDist = dist;
      applyTransform();
    }
  }, { passive: true });

  canvasContainer.addEventListener('touchend', () => {
    isDragging = false;
  });
}

function applyTransform() {
  diagramCanvas.style.transform = `translate(${panX}px, ${panY}px) scale(${scale})`;
}

export function zoomIn() {
  scale = Math.min(MAX_SCALE, scale * 1.15);
  applyTransform();
}

export function zoomOut() {
  scale = Math.max(MIN_SCALE, scale / 1.15);
  applyTransform();
}

export function zoomReset() {
  scale = 1;
  panX = 0;
  panY = 0;
  applyTransform();
  fitToView();
}

function fitToView() {
  const svg = diagramCanvas.querySelector('svg');
  if (!svg) return;

  const containerRect = canvasContainer.getBoundingClientRect();
  const svgWidth = svg.viewBox.baseVal.width || svg.getBoundingClientRect().width;
  const svgHeight = svg.viewBox.baseVal.height || svg.getBoundingClientRect().height;

  const padding = 40;
  const scaleX = (containerRect.width - padding * 2) / svgWidth;
  const scaleY = (containerRect.height - padding * 2) / svgHeight;
  scale = Math.min(scaleX, scaleY, 1.5);

  panX = (containerRect.width - svgWidth * scale) / 2;
  panY = (containerRect.height - svgHeight * scale) / 2;

  applyTransform();
}

/**
 * Render a Mermaid definition string into the canvas.
 *
 * @param {string} definition - Mermaid definition text
 * @param {object} options
 * @param {object} options.drillTargets - Map of nodeId -> diagramId for drillable nodes
 * @param {function} options.onDrill - Callback when a drillable node is clicked: (diagramId) => void
 * @param {string[]} options.subgraphIds - List of subgraph IDs in this diagram
 * @param {Set<string>} options.collapsedIds - Set of currently collapsed subgraph IDs
 * @param {function} options.onToggleCollapse - Callback: (subgraphId) => void
 * @param {function} options.onCreateDrill - Callback when user wants to create a new drill link: (nodeId, label, type) => void
 * @param {function} options.onHoverDrillable - Callback when hovering a drillable element: (targetDiagramId | null) => void
 * @param {function} options.onClickDrillable - Callback when clicking a drillable element: (targetDiagramId | null) => void
 */
export async function renderDiagram(definition, options = {}) {
  const {
    drillTargets = {},
    onDrill = () => { },
    subgraphIds = [],
    collapsedIds = new Set(),
    onToggleCollapse = () => { },
    onCreateDrill = () => { },
    onHoverDrillable = () => { },
    onClickDrillable = () => { },
  } = options;

  // Update module-level state for event handlers
  currentDrillTargets = drillTargets;
  currentSubgraphIds = subgraphIds;
  currentOnDrill = onDrill;
  currentOnCreateDrill = onCreateDrill;
  currentOnHoverDrillable = onHoverDrillable;
  currentOnClickDrillable = onClickDrillable;
  lastHoveredDrillTarget = null;

  const id = `mermaid-diagram-${++renderCounter}`;

  try {
    const { svg, bindFunctions } = await window.mermaid.render(id, definition);
    diagramCanvas.innerHTML = svg;

    if (bindFunctions) {
      bindFunctions(diagramCanvas);
    }

    // Build subgraphId ↔ cluster element mapping
    buildClusterMap(subgraphIds);

    // Mark drillable nodes and inject drill buttons
    injectDrillButtons(drillTargets, onDrill);

    // Inject collapse/expand toggles on subgraph labels
    injectCollapseToggles(subgraphIds, collapsedIds, onToggleCollapse);

    // Fit diagram in view
    requestAnimationFrame(() => fitToView());
  } catch (err) {
    console.error('Mermaid render error:', err);
    // Don't replace canvas — keep last valid diagram visible
    throw err;
  }
}

/**
 * Inject a small circular drill button at the top-right of each drillable node.
 */
function injectDrillButtons(drillTargets, onDrill) {
  const svgEl = diagramCanvas.querySelector('svg');
  if (!svgEl) return;

  for (const nodeId of Object.keys(drillTargets)) {
    let targetEl = null;
    let isSubgraph = false;

    // Try subgraph cluster first (via pre-built map)
    const cluster = clusterMap.get(nodeId);
    if (cluster) {
      targetEl = cluster;
      isSubgraph = true;
    } else {
      // Fall back to regular node
      targetEl = diagramCanvas.querySelector(`[id*="flowchart-${nodeId}-"]`);
      if (targetEl) {
        targetEl = targetEl.closest('.node') || targetEl;
      }
    }

    if (!targetEl) continue;

    targetEl.classList.add('drillable');

    // Determine position for drill button at the top-right corner.
    // For subgraphs: use the cluster's <rect> attributes (local coords)
    // and append to the cluster itself — same coordinate space.
    // For nodes: use getBBox() and append to the node group.
    let btnX, btnY;

    if (isSubgraph) {
      const clusterRect = targetEl.querySelector(':scope > rect');
      if (!clusterRect) continue;
      const rx = parseFloat(clusterRect.getAttribute('x'));
      const ry = parseFloat(clusterRect.getAttribute('y'));
      const rw = parseFloat(clusterRect.getAttribute('width'));
      btnX = rx + rw - 4;
      btnY = ry - 4;
    } else {
      const bbox = targetEl.getBBox();
      btnX = bbox.x + bbox.width - 4;
      btnY = bbox.y - 4;
    }

    // Create a group for the drill button
    const btnGroup = document.createElementNS('http://www.w3.org/2000/svg', 'g');
    btnGroup.classList.add('drill-btn');
    btnGroup.setAttribute('transform', `translate(${btnX}, ${btnY})`);

    const circle = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
    circle.setAttribute('r', '10');
    circle.setAttribute('fill', '#4a90d9');
    circle.setAttribute('stroke', '#fff');
    circle.setAttribute('stroke-width', '1.5');

    // Arrow icon for the drill button
    const icon = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    icon.setAttribute('d', 'M-3,-3 L3,0 L-3,3 Z');
    icon.setAttribute('fill', '#fff');
    icon.setAttribute('pointer-events', 'none');

    btnGroup.appendChild(circle);
    btnGroup.appendChild(icon);

    btnGroup.addEventListener('click', (e) => {
      e.stopPropagation();
      onDrill(drillTargets[nodeId]);
    });

    // Append to the element itself so coordinates match
    targetEl.appendChild(btnGroup);
  }
}

function injectCollapseToggles(subgraphIds, collapsedIds, onToggleCollapse) {
  for (const sgInfo of subgraphIds) {
    const sgId = typeof sgInfo === 'string' ? sgInfo : sgInfo.id;
    const isCollapsed = collapsedIds.has(sgId);

    // Use pre-built map to find the cluster
    const cluster = clusterMap.get(sgId);
    if (cluster) {
      const clusterRect = cluster.querySelector(':scope > rect');
      if (clusterRect) {
        const toggle = document.createElementNS('http://www.w3.org/2000/svg', 'text');
        const x = parseFloat(clusterRect.getAttribute('x')) + 12;
        const y = parseFloat(clusterRect.getAttribute('y')) + 18;
        toggle.setAttribute('x', x);
        toggle.setAttribute('y', y);
        toggle.textContent = isCollapsed ? '[+]' : '[-]';
        toggle.classList.add('subgraph-toggle');
        toggle.addEventListener('click', (e) => {
          e.stopPropagation();
          onToggleCollapse(sgId);
        });
        cluster.appendChild(toggle);
      }
    }

    // For collapsed nodes (rendered as regular nodes with [+] prefix)
    if (isCollapsed) {
      const nodeEl = diagramCanvas.querySelector(`[id*="flowchart-${sgId}-"]`);
      if (nodeEl) {
        const nodeGroup = nodeEl.closest('.node') || nodeEl;
        nodeGroup.style.cursor = 'pointer';
        nodeGroup.addEventListener('click', (e) => {
          e.stopPropagation();
          onToggleCollapse(sgId);
        });
      }
    }
  }
}
