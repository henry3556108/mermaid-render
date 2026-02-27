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
const ZOOM_STEP = 0.15;

let canvasContainer = null;
let diagramCanvas = null;

// Hover/dblclick state
let tooltipEl = null;
let currentHighlight = null;
let currentDrillTargets = {};
let currentSubgraphIds = [];
let currentOnDrill = () => {};
let currentOnCreateDrill = () => {};

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
 * Identify a hovered/clicked SVG element as a node or subgraph.
 * Returns { type, id, label, element } or null.
 */
function identifyElement(target) {
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

  // Try subgraph cluster
  const cluster = target.closest('.cluster');
  if (cluster) {
    const labelEl = cluster.querySelector('.cluster-label .nodeLabel, .cluster-label span');
    if (labelEl) {
      const text = labelEl.textContent.trim();
      // Match against known subgraph IDs
      for (const sgInfo of currentSubgraphIds) {
        const sgId = typeof sgInfo === 'string' ? sgInfo : sgInfo.id;
        const sgLabel = typeof sgInfo === 'string' ? sgId : sgInfo.label;
        if (text.includes(sgLabel) || text.includes(sgId)) {
          return { type: 'subgraph', id: sgId, label: sgLabel, element: cluster };
        }
      }
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
      return;
    }

    // Add highlight
    if (info.element !== currentHighlight) {
      info.element.classList.add('hover-highlight');
      currentHighlight = info.element;
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
  });

  // dblclick — drill or create
  canvasContainer.addEventListener('dblclick', (e) => {
    // Ignore interactive controls
    if (e.target.closest('.subgraph-toggle, .drill-btn, a, button')) return;

    const info = identifyElement(e.target);
    if (!info) return;

    const targetDiagramId = currentDrillTargets[info.id];
    if (targetDiagramId) {
      // Already linked — navigate
      currentOnDrill(targetDiagramId);
    } else {
      // Not linked — open create modal
      currentOnCreateDrill(info.id, info.label, info.type);
    }
  });
}

function setupPanZoom() {
  // Mouse wheel zoom
  canvasContainer.addEventListener('wheel', (e) => {
    e.preventDefault();
    const rect = canvasContainer.getBoundingClientRect();
    const mouseX = e.clientX - rect.left;
    const mouseY = e.clientY - rect.top;

    const oldScale = scale;
    const delta = e.deltaY > 0 ? -ZOOM_STEP : ZOOM_STEP;
    scale = Math.min(MAX_SCALE, Math.max(MIN_SCALE, scale + delta));

    // Zoom toward mouse position
    panX = mouseX - (mouseX - panX) * (scale / oldScale);
    panY = mouseY - (mouseY - panY) * (scale / oldScale);

    applyTransform();
  }, { passive: false });

  // Pan with mouse drag
  canvasContainer.addEventListener('mousedown', (e) => {
    if (e.button !== 0) return;
    // Don't start drag if clicking on interactive element
    if (e.target.closest('.subgraph-toggle, .drill-btn, a, button')) return;
    isDragging = true;
    dragStartX = e.clientX;
    dragStartY = e.clientY;
    panStartX = panX;
    panStartY = panY;
    canvasContainer.classList.add('dragging');
  });

  window.addEventListener('mousemove', (e) => {
    if (!isDragging) return;
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
  scale = Math.min(MAX_SCALE, scale + ZOOM_STEP);
  applyTransform();
}

export function zoomOut() {
  scale = Math.max(MIN_SCALE, scale - ZOOM_STEP);
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
 */
export async function renderDiagram(definition, options = {}) {
  const {
    drillTargets = {},
    onDrill = () => {},
    subgraphIds = [],
    collapsedIds = new Set(),
    onToggleCollapse = () => {},
    onCreateDrill = () => {},
  } = options;

  // Update module-level state for event handlers
  currentDrillTargets = drillTargets;
  currentSubgraphIds = subgraphIds;
  currentOnDrill = onDrill;
  currentOnCreateDrill = onCreateDrill;

  const id = `mermaid-diagram-${++renderCounter}`;

  try {
    const { svg, bindFunctions } = await window.mermaid.render(id, definition);
    diagramCanvas.innerHTML = svg;

    if (bindFunctions) {
      bindFunctions(diagramCanvas);
    }

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
    // Try regular node first
    let targetEl = diagramCanvas.querySelector(`[id*="flowchart-${nodeId}-"]`);
    let isSubgraph = false;

    if (targetEl) {
      targetEl = targetEl.closest('.node') || targetEl;
    } else {
      // Try subgraph cluster: match by label text
      const clusters = svgEl.querySelectorAll('.cluster');
      for (const cluster of clusters) {
        const labelEl = cluster.querySelector('.cluster-label .nodeLabel, .cluster-label span');
        if (labelEl && (labelEl.textContent.trim() === nodeId || labelEl.textContent.trim().includes(nodeId))) {
          targetEl = cluster;
          isSubgraph = true;
          break;
        }
      }
    }

    if (!targetEl) continue;

    targetEl.classList.add('drillable');
    const bbox = targetEl.getBBox();

    // Create a group for the drill button at the top-right corner
    const btnGroup = document.createElementNS('http://www.w3.org/2000/svg', 'g');
    btnGroup.classList.add('drill-btn');
    btnGroup.setAttribute('transform', `translate(${bbox.x + bbox.width - 4}, ${bbox.y - 4})`);

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

    // Append to the element's parent so it renders on top
    if (isSubgraph) {
      // For clusters, append to the SVG root so it's above the cluster
      svgEl.appendChild(btnGroup);
    } else {
      targetEl.appendChild(btnGroup);
    }
  }
}

function injectCollapseToggles(subgraphIds, collapsedIds, onToggleCollapse) {
  // Find subgraph label elements in the SVG
  const svgEl = diagramCanvas.querySelector('svg');
  if (!svgEl) return;

  for (const sgInfo of subgraphIds) {
    const sgId = typeof sgInfo === 'string' ? sgInfo : sgInfo.id;
    const isCollapsed = collapsedIds.has(sgId);

    // Mermaid renders subgraph containers with specific class patterns
    // Try to find the cluster label for this subgraph
    const clusters = svgEl.querySelectorAll('.cluster');
    for (const cluster of clusters) {
      const labelEl = cluster.querySelector('.cluster-label .nodeLabel, .cluster-label span');
      if (!labelEl) continue;

      const text = labelEl.textContent.trim();
      const sgLabel = typeof sgInfo === 'string' ? sgId : sgInfo.label;

      if (text.includes(sgLabel) || text.includes(sgId)) {
        // Add toggle button
        const toggle = document.createElementNS('http://www.w3.org/2000/svg', 'text');
        const labelRect = labelEl.getBoundingClientRect();
        const svgRect = svgEl.getBoundingClientRect();

        // Position the toggle near the cluster label
        const clusterRect = cluster.querySelector('rect');
        if (clusterRect) {
          const x = parseFloat(clusterRect.getAttribute('x')) + 12;
          const y = parseFloat(clusterRect.getAttribute('y')) + 18;
          toggle.setAttribute('x', x);
          toggle.setAttribute('y', y);
        }

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
