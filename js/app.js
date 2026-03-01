/**
 * App - Main entry point
 * Coordinates all modules and handles the render cycle.
 */

import {
  getRegistry,
  getCurrentDiagramId,
  getDrillTargets,
  navigateTo,
  onStateChange,
  toggleCollapse,
  getCollapseState,
  getRawDefinition,
  setEditorContent,
  getEditorContent,
  clearEditorContent,
  loadProject,
  addDiagram,
  deleteDiagram,
  renameDiagram,
  setDrillTarget,
  removeDrillTarget,
  getAllDiagramList,
  getProjectJSON,
  importProject,
  getProjectName,
  setProjectName,
} from './state.js';

import { renderBreadcrumb, loadDiagramDefinition } from './navigator.js';
import { initRenderer, renderDiagram, zoomIn, zoomOut, zoomReset } from './renderer.js';
import { transformDefinition, extractSubgraphIds, parseMermaidDefinition, extractSubgraphContent } from './parser.js';

// Editor elements
let editorTextarea = null;
let editorFooter = null;
let debounceTimer = null;
const DEBOUNCE_MS = 500;

// Create-drill modal
let openCreateDrillModal = null;

// Preview overlay
let previewOverlay = null;
let previewTitle = null;
let previewCloseBtn = null;
let previewContent = null;
let previewCache = {};
let currentPreviewId = null;
let previewRenderCounter = 0;
let previewPinned = false;

// Preview pan/zoom state
let pvScale = 1;
let pvPanX = 0;
let pvPanY = 0;
let pvDragging = false;
let pvDragStartX = 0;
let pvDragStartY = 0;
let pvPanStartX = 0;
let pvPanStartY = 0;

async function init() {
  // Load or create project from localStorage
  loadProject();

  // Init renderer (mermaid + pan/zoom)
  initRenderer();

  // Init editor
  initEditor();

  // Init resize handle
  initResizeHandle();

  // Init project name
  initProjectName();

  // Init project controls (Export / Import / Demo)
  initProjectControls();

  // Init diagram management (selector + CRUD + link panel)
  initDiagramManagement();

  // Init link sidebar
  initLinkSidebar();

  // Init preview overlay
  previewOverlay = document.getElementById('link-preview-overlay');
  previewTitle = document.getElementById('link-preview-title');
  previewCloseBtn = document.getElementById('link-preview-close');
  previewContent = document.getElementById('link-preview-content');
  initPreviewInteractions();

  // Init create-drill modal
  openCreateDrillModal = initCreateDrillModal();

  // Bind toolbar buttons
  document.getElementById('btn-zoom-in').addEventListener('click', zoomIn);
  document.getElementById('btn-zoom-out').addEventListener('click', zoomOut);
  document.getElementById('btn-zoom-reset').addEventListener('click', zoomReset);
  document.getElementById('btn-fullscreen').addEventListener('click', toggleFullscreen);

  // Listen for state changes
  onStateChange((eventType) => {
    if (eventType === 'navigate') {
      previewCache = {};
      hidePreviewOverlay();
      refreshDiagramSelector();
      syncEditorForCurrentDiagram();
      renderCurrentDiagram();
      if (isSidebarOpen()) buildLinkPanel();
    } else if (eventType === 'collapse') {
      previewCache = {};
      renderCurrentDiagram();
    } else if (eventType === 'project-structure') {
      previewCache = {};
      hidePreviewOverlay();
      refreshDiagramSelector();
      if (isSidebarOpen()) buildLinkPanel();
    } else if (eventType === 'drill-targets') {
      previewCache = {};
      renderCurrentDiagram();
      if (isSidebarOpen()) buildLinkPanel();
    }
  });

  // Navigate to entry diagram
  const registry = getRegistry();
  navigateTo(registry.entryDiagram);
}

// --- Project Name ---

let projectNameInput = null;

function initProjectName() {
  projectNameInput = document.getElementById('project-name');
  projectNameInput.value = getProjectName();

  projectNameInput.addEventListener('change', () => {
    const name = projectNameInput.value.trim();
    if (name) {
      setProjectName(name);
    } else {
      projectNameInput.value = getProjectName();
    }
  });

  projectNameInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      projectNameInput.blur();
    }
  });
}

function syncProjectName() {
  if (projectNameInput) {
    projectNameInput.value = getProjectName();
  }
}

// --- Project Controls ---

function initProjectControls() {
  document.getElementById('btn-export').addEventListener('click', () => {
    const json = getProjectJSON();
    const blob = new Blob([json], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    const safeName = getProjectName().replace(/[^a-zA-Z0-9_\-\u4e00-\u9fff ]/g, '').trim() || 'mermaid-project';
    a.download = safeName + '.json';
    a.click();
    URL.revokeObjectURL(url);
  });

  const fileInput = document.getElementById('file-import');

  document.getElementById('btn-import').addEventListener('click', () => {
    fileInput.click();
  });

  fileInput.addEventListener('change', (e) => {
    const file = e.target.files[0];
    if (!file) return;

    if (!confirm('Import will replace the current project. Continue?')) {
      fileInput.value = '';
      return;
    }

    const reader = new FileReader();
    reader.onload = (ev) => {
      try {
        importProject(ev.target.result);
        syncProjectName();
        const registry = getRegistry();
        // Reset navigation and go to entry
        navigateTo(registry.entryDiagram);
      } catch (err) {
        alert('Failed to import: ' + err.message);
      }
      fileInput.value = '';
    };
    reader.readAsText(file);
  });

  document.getElementById('btn-demo').addEventListener('click', () => {
    loadDemoProject();
  });
}

// --- Diagram Management ---

function initDiagramManagement() {
  const selector = document.getElementById('diagram-selector');

  // Switch diagram on selector change
  selector.addEventListener('change', () => {
    const id = selector.value;
    if (id && id !== getCurrentDiagramId()) {
      navigateTo(id);
    }
  });

  // Add diagram
  document.getElementById('btn-add-diagram').addEventListener('click', () => {
    const title = prompt('New diagram title:');
    if (!title || !title.trim()) return;
    const id = addDiagram(title.trim());
    navigateTo(id);
  });

  // Rename diagram
  document.getElementById('btn-rename-diagram').addEventListener('click', () => {
    const diagramId = getCurrentDiagramId();
    if (!diagramId) return;
    const registry = getRegistry();
    const config = registry.diagrams[diagramId];
    const newTitle = prompt('Rename diagram:', config ? config.title : '');
    if (!newTitle || !newTitle.trim()) return;
    renameDiagram(diagramId, newTitle.trim());
    refreshDiagramSelector();
    renderBreadcrumb();
  });

  // Delete diagram
  document.getElementById('btn-delete-diagram').addEventListener('click', () => {
    const diagramId = getCurrentDiagramId();
    if (!diagramId) return;
    const registry = getRegistry();
    const config = registry.diagrams[diagramId];
    const title = config ? config.title : diagramId;

    if (!confirm(`Delete diagram "${title}"?`)) return;

    // If deleting current diagram, navigate away first
    const allDiagrams = getAllDiagramList();
    if (allDiagrams.length <= 1) {
      alert('Cannot delete the last diagram.');
      return;
    }

    const entryId = registry.entryDiagram;
    const targetId = diagramId === entryId
      ? allDiagrams.find(d => d.id !== diagramId).id
      : entryId;

    navigateTo(targetId);
    deleteDiagram(diagramId);
    refreshDiagramSelector();
  });

  // Initial population
  refreshDiagramSelector();
}

function refreshDiagramSelector() {
  const selector = document.getElementById('diagram-selector');
  const list = getAllDiagramList();
  const currentId = getCurrentDiagramId();

  selector.innerHTML = '';
  for (const { id, title, depth } of list) {
    const opt = document.createElement('option');
    opt.value = id;
    const indent = depth > 0 ? '\u00A0\u00A0'.repeat(depth) + '└ ' : '';
    opt.textContent = indent + title;
    if (id === currentId) opt.selected = true;
    selector.appendChild(opt);
  }
}

// --- Link Sidebar ---

let linkSidebar = null;
let btnToggleSidebar = null;

function initLinkSidebar() {
  linkSidebar = document.getElementById('link-sidebar');
  btnToggleSidebar = document.getElementById('btn-toggle-sidebar');

  btnToggleSidebar.addEventListener('click', () => toggleSidebar());
  document.getElementById('btn-close-sidebar').addEventListener('click', () => toggleSidebar(false));

  // Reflect initial open state
  btnToggleSidebar.classList.add('active');
}

function toggleSidebar(forceOpen) {
  const isCollapsed = linkSidebar.classList.contains('collapsed');
  const shouldOpen = forceOpen !== undefined ? forceOpen : isCollapsed;

  if (shouldOpen) {
    linkSidebar.classList.remove('collapsed');
    btnToggleSidebar.classList.add('active');
    buildLinkPanel();
  } else {
    linkSidebar.classList.add('collapsed');
    btnToggleSidebar.classList.remove('active');
  }
}

function isSidebarOpen() {
  return linkSidebar && !linkSidebar.classList.contains('collapsed');
}

function buildLinkPanel() {
  const container = document.getElementById('link-panel-content');
  const diagramId = getCurrentDiagramId();
  if (!diagramId) return;

  container.innerHTML = '';

  // Get current editor content to parse node IDs
  const content = editorTextarea.value || getRawDefinition(diagramId) || '';
  const parsed = parseMermaidDefinition(content);

  // Collect all linkable IDs: subgraphs + free nodes + nodes inside subgraphs
  const linkableIds = [];
  const seen = new Set();

  // Subgraphs first (displayed as a group header)
  for (const sg of parsed.subgraphs) {
    if (!seen.has(sg.id)) {
      linkableIds.push({ id: sg.id, label: sg.label, isSubgraph: true });
      seen.add(sg.id);
    }
  }

  // Then regular nodes
  for (const node of parsed.freeNodes) {
    if (!seen.has(node.id)) {
      linkableIds.push({ id: node.id, isSubgraph: false });
      seen.add(node.id);
    }
  }
  for (const sg of parsed.subgraphs) {
    for (const nid of sg.nodeIds) {
      if (!seen.has(nid)) {
        linkableIds.push({ id: nid, isSubgraph: false });
        seen.add(nid);
      }
    }
  }

  if (linkableIds.length === 0) {
    container.innerHTML = '<div class="link-panel-empty">No nodes found in current diagram.</div>';
    return;
  }

  const registry = getRegistry();
  const currentDrillTargets = (registry.diagrams[diagramId] || {}).drillTargets || {};
  const allDiagrams = getAllDiagramList().filter(d => d.id !== diagramId);

  for (const item of linkableIds) {
    const nodeId = item.id;
    const row = document.createElement('div');
    row.className = 'link-row';

    const label = document.createElement('span');
    label.className = 'link-node-id' + (item.isSubgraph ? ' link-subgraph' : '');
    label.textContent = item.isSubgraph ? `[sg] ${item.label || nodeId}` : nodeId;
    label.title = nodeId;

    const select = document.createElement('select');
    const noneOpt = document.createElement('option');
    noneOpt.value = '';
    noneOpt.textContent = '(None)';
    select.appendChild(noneOpt);

    for (const d of allDiagrams) {
      const opt = document.createElement('option');
      opt.value = d.id;
      opt.textContent = d.title;
      if (currentDrillTargets[nodeId] === d.id) opt.selected = true;
      select.appendChild(opt);
    }

    select.addEventListener('change', () => {
      if (select.value) {
        setDrillTarget(diagramId, nodeId, select.value);
      } else {
        removeDrillTarget(diagramId, nodeId);
      }
    });

    row.appendChild(label);
    row.appendChild(select);
    container.appendChild(row);
  }
}

// --- Editor ---

function initEditor() {
  editorTextarea = document.getElementById('editor-textarea');
  editorFooter = document.getElementById('editor-footer');

  // Debounced input handler
  editorTextarea.addEventListener('input', () => {
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      onEditorInput();
    }, DEBOUNCE_MS);
  });

  // Reset button
  document.getElementById('btn-editor-reset').addEventListener('click', () => {
    const diagramId = getCurrentDiagramId();
    if (!diagramId) return;
    clearTimeout(debounceTimer);
    clearEditorContent(diagramId);
    const raw = getRawDefinition(diagramId);
    if (raw) {
      editorTextarea.value = raw;
      editorFooter.textContent = '';
      editorFooter.classList.remove('error');
      renderCurrentDiagram();
    }
  });

  // Tab key inserts spaces instead of changing focus
  editorTextarea.addEventListener('keydown', (e) => {
    if (e.key === 'Tab') {
      e.preventDefault();
      const start = editorTextarea.selectionStart;
      const end = editorTextarea.selectionEnd;
      editorTextarea.value =
        editorTextarea.value.substring(0, start) + '  ' + editorTextarea.value.substring(end);
      editorTextarea.selectionStart = editorTextarea.selectionEnd = start + 2;
      editorTextarea.dispatchEvent(new Event('input', { bubbles: true }));
    }
  });
}

function onEditorInput() {
  const diagramId = getCurrentDiagramId();
  if (!diagramId) return;

  const content = editorTextarea.value;
  setEditorContent(diagramId, content);
  previewCache = {};
  renderCurrentDiagram();
  if (isSidebarOpen()) buildLinkPanel();
}

/**
 * When navigating to a diagram, load the appropriate content into the editor.
 */
function syncEditorForCurrentDiagram() {
  const diagramId = getCurrentDiagramId();
  if (!diagramId) return;

  // Load content: prefer user-edited, fall back to raw
  const edited = getEditorContent(diagramId);
  if (edited !== null) {
    editorTextarea.value = edited;
    editorFooter.textContent = 'Edited';
    editorFooter.classList.remove('error');
  } else {
    const raw = loadDiagramDefinition(diagramId);
    editorTextarea.value = raw;
    editorFooter.textContent = '';
    editorFooter.classList.remove('error');
  }
}

// --- Resize Handle ---

function initResizeHandle() {
  const handle = document.getElementById('resize-handle');
  const editorPane = document.getElementById('editor-pane');
  let startX = 0;
  let startWidth = 0;

  handle.addEventListener('mousedown', (e) => {
    e.preventDefault();
    startX = e.clientX;
    startWidth = editorPane.offsetWidth;
    handle.classList.add('active');
    document.body.classList.add('resizing');

    const onMouseMove = (e) => {
      const delta = e.clientX - startX;
      const newWidth = Math.max(200, Math.min(startWidth + delta, window.innerWidth * 0.8));
      editorPane.style.width = newWidth + 'px';
    };

    const onMouseUp = () => {
      handle.classList.remove('active');
      document.body.classList.remove('resizing');
      window.removeEventListener('mousemove', onMouseMove);
      window.removeEventListener('mouseup', onMouseUp);
    };

    window.addEventListener('mousemove', onMouseMove);
    window.addEventListener('mouseup', onMouseUp);
  });
}

// --- Create-Drill Modal ---

/**
 * Initialize the create-drill modal and return an openModal function.
 * openModal(elementInfo, defaultTitle) → Promise<string|null>
 */
function initCreateDrillModal() {
  const overlay = document.getElementById('create-drill-modal');
  const infoEl = document.getElementById('modal-element-info');
  const titleInput = document.getElementById('modal-diagram-title');
  const btnCancel = document.getElementById('modal-btn-cancel');
  const btnCreate = document.getElementById('modal-btn-create');

  let resolveFn = null;

  function close(value) {
    overlay.style.display = 'none';
    if (resolveFn) {
      resolveFn(value);
      resolveFn = null;
    }
  }

  btnCancel.addEventListener('click', () => close(null));
  btnCreate.addEventListener('click', () => close(titleInput.value.trim() || null));

  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) close(null);
  });

  overlay.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') close(null);
    if (e.key === 'Enter') {
      e.preventDefault();
      close(titleInput.value.trim() || null);
    }
    // Focus trap: cycle focus within modal
    if (e.key === 'Tab') {
      const focusable = overlay.querySelectorAll('input, button, [tabindex]:not([tabindex="-1"])');
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    }
  });

  return function openModal(elementInfo, defaultTitle) {
    infoEl.textContent = elementInfo;
    titleInput.value = defaultTitle;
    overlay.style.display = '';
    titleInput.focus();
    titleInput.select();
    return new Promise((resolve) => {
      resolveFn = resolve;
    });
  };
}

async function showCreateDrillModal(nodeId, label, type) {
  const diagramId = getCurrentDiagramId();
  if (!diagramId) return;

  const typeLabel = type === 'node' ? 'Node' : 'Subgraph';
  const info = `${typeLabel}: ${label} (${nodeId})`;
  const title = await openCreateDrillModal(info, label);
  if (!title) return;

  // For subgraphs, extract internal content as the initial diagram template
  let initialContent = null;
  if (type === 'subgraph') {
    const rawDef = editorTextarea.value || getRawDefinition(diagramId) || '';
    initialContent = extractSubgraphContent(rawDef, nodeId);
  }

  // Determine which diagram should own this new drill link.
  // If the node belongs to a subgraph that already has a linked diagram,
  // create the drill link on that linked diagram instead of the current one.
  let ownerDiagramId = diagramId;
  if (type === 'node') {
    const rawDef = editorTextarea.value || getRawDefinition(diagramId) || '';
    const parsed = parseMermaidDefinition(rawDef);
    const currentDrillTargets = getDrillTargets();

    // Find the innermost subgraph containing this node.
    // Since nodes are registered in all ancestor subgraphs,
    // the innermost one has the smallest nodeIds array.
    let innermostSg = null;
    for (const sg of parsed.subgraphs) {
      if (sg.nodeIds.includes(nodeId)) {
        if (!innermostSg || sg.nodeIds.length < innermostSg.nodeIds.length) {
          innermostSg = sg;
        }
      }
    }

    if (innermostSg && currentDrillTargets[innermostSg.id]) {
      ownerDiagramId = currentDrillTargets[innermostSg.id];
    }
  }

  const newId = addDiagram(title, initialContent);
  setDrillTarget(ownerDiagramId, nodeId, newId);
}

// --- Preview ---

function showPreviewOverlay(targetDiagramId) {
  const registry = getRegistry();
  const config = registry.diagrams[targetDiagramId];
  previewTitle.textContent = config ? config.title : targetDiagramId;
  previewOverlay.style.display = '';
}

function hidePreviewOverlay() {
  currentPreviewId = null;
  previewOverlay.style.display = 'none';
  unpinPreview();
}

function pinPreview() {
  previewPinned = true;
  previewOverlay.classList.add('pinned');
  resetPreviewTransform();
}

function unpinPreview() {
  previewPinned = false;
  previewOverlay.classList.remove('pinned');
  previewContent.classList.remove('dragging');
  resetPreviewTransform();
}

function resetPreviewTransform() {
  pvScale = 1;
  pvPanX = 0;
  pvPanY = 0;
  const svg = previewContent.querySelector('svg');
  if (svg) {
    svg.style.transform = '';
    svg.style.transformOrigin = '';
  }
}

function applyPreviewTransform() {
  const svg = previewContent.querySelector('svg');
  if (!svg) return;
  svg.style.transformOrigin = '0 0';
  svg.style.transform = `translate(${pvPanX}px, ${pvPanY}px) scale(${pvScale})`;
}

function initPreviewInteractions() {
  // Close button
  previewCloseBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    hidePreviewOverlay();
  });

  // Escape key to unpin
  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && previewPinned) {
      hidePreviewOverlay();
    }
  });

  // Wheel zoom on preview
  previewContent.addEventListener('wheel', (e) => {
    if (!previewPinned) return;
    e.preventDefault();
    e.stopPropagation();

    const rect = previewContent.getBoundingClientRect();
    const mouseX = e.clientX - rect.left;
    const mouseY = e.clientY - rect.top;

    const oldScale = pvScale;
    const factor = Math.pow(1.001, -e.deltaY);
    pvScale = Math.min(5, Math.max(0.2, pvScale * factor));

    pvPanX = mouseX - (mouseX - pvPanX) * (pvScale / oldScale);
    pvPanY = mouseY - (mouseY - pvPanY) * (pvScale / oldScale);

    applyPreviewTransform();
  }, { passive: false });

  // Drag pan on preview
  previewContent.addEventListener('mousedown', (e) => {
    if (!previewPinned || e.button !== 0) return;
    e.stopPropagation();
    pvDragging = true;
    pvDragStartX = e.clientX;
    pvDragStartY = e.clientY;
    pvPanStartX = pvPanX;
    pvPanStartY = pvPanY;
    previewContent.classList.add('dragging');
  });

  window.addEventListener('mousemove', (e) => {
    if (!pvDragging) return;
    pvPanX = pvPanStartX + (e.clientX - pvDragStartX);
    pvPanY = pvPanStartY + (e.clientY - pvDragStartY);
    applyPreviewTransform();
  });

  window.addEventListener('mouseup', () => {
    if (pvDragging) {
      pvDragging = false;
      previewContent.classList.remove('dragging');
    }
  });
}

function onClickDrillable(targetDiagramId) {
  if (targetDiagramId === null) {
    // Clicked empty area — unpin if pinned
    if (previewPinned) hidePreviewOverlay();
    return;
  }

  if (previewPinned && targetDiagramId === currentPreviewId) {
    // Clicked same element — toggle off
    hidePreviewOverlay();
    return;
  }

  // Pin this preview (render it first if needed, then pin)
  renderPreviewContent(targetDiagramId).then(() => {
    pinPreview();
  });
}

async function updatePreview(targetDiagramId) {
  // Ignore hover updates while pinned
  if (previewPinned) return;

  if (targetDiagramId === null) {
    hidePreviewOverlay();
    return;
  }

  if (targetDiagramId === currentPreviewId) return;
  await renderPreviewContent(targetDiagramId);
}

async function renderPreviewContent(targetDiagramId) {
  currentPreviewId = targetDiagramId;
  showPreviewOverlay(targetDiagramId);
  resetPreviewTransform();

  if (previewCache[targetDiagramId]) {
    previewContent.innerHTML = previewCache[targetDiagramId];
    return;
  }

  previewContent.innerHTML = '<div class="preview-placeholder">Loading...</div>';

  const content = getEditorContent(targetDiagramId) || getRawDefinition(targetDiagramId);
  if (!content) {
    previewContent.innerHTML = '<div class="preview-placeholder">No content</div>';
    return;
  }

  try {
    const id = `mermaid-preview-${++previewRenderCounter}`;
    const { svg } = await window.mermaid.render(id, content);
    previewCache[targetDiagramId] = svg;
    if (currentPreviewId === targetDiagramId) {
      previewContent.innerHTML = svg;
    }
  } catch {
    if (currentPreviewId === targetDiagramId) {
      previewContent.innerHTML = '<div class="preview-placeholder">Render error</div>';
    }
  }
}

// --- Render ---

function renderCurrentDiagram() {
  const diagramId = getCurrentDiagramId();
  if (!diagramId) return;

  // Update breadcrumb
  renderBreadcrumb();

  // Determine the definition to render
  let rawDefinition;
  const edited = getEditorContent(diagramId);
  if (edited !== null) {
    rawDefinition = edited;
  } else {
    rawDefinition = loadDiagramDefinition(diagramId);
  }

  // Parse once and reuse for subgraph extraction + collapse transform
  const parsed = parseMermaidDefinition(rawDefinition);
  const subgraphIds = extractSubgraphIds(rawDefinition, parsed);

  // Apply collapse transformations
  const collapsedIds = getCollapseState(diagramId);
  const finalDefinition = transformDefinition(rawDefinition, collapsedIds, parsed);

  // Get drill targets for current diagram
  const drillTargets = getDrillTargets();

  // Render
  renderDiagram(finalDefinition, {
    drillTargets,
    onDrill: (targetDiagramId) => {
      // Save editor content before navigating
      const content = editorTextarea.value;
      if (content !== getRawDefinition(diagramId)) {
        setEditorContent(diagramId, content);
      }
      navigateTo(targetDiagramId);
    },
    subgraphIds,
    collapsedIds,
    onToggleCollapse: (subgraphId) => {
      toggleCollapse(diagramId, subgraphId);
    },
    onCreateDrill: (nodeId, label, type) => {
      showCreateDrillModal(nodeId, label, type);
    },
    onHoverDrillable: (targetDiagramId) => {
      updatePreview(targetDiagramId);
    },
    onClickDrillable: (targetDiagramId) => {
      onClickDrillable(targetDiagramId);
    },
  }).then(() => {
    editorFooter.classList.remove('error');
    if (edited !== null) {
      editorFooter.textContent = 'Edited';
    } else {
      editorFooter.textContent = '';
    }
  }).catch((err) => {
    editorFooter.textContent = 'Syntax error: ' + err.message;
    editorFooter.classList.add('error');
  });
}

// --- Demo Project ---

async function loadDemoProject() {
  if (!confirm('Load demo project? This will replace the current project.')) return;

  try {
    // Fetch all demo files
    const [regResp, l1Resp, l2fResp, l2bResp, l2dResp, l3aResp] = await Promise.all([
      fetch('diagrams/registry.json'),
      fetch('diagrams/L1-overview.mmd'),
      fetch('diagrams/L2-frontend.mmd'),
      fetch('diagrams/L2-backend.mmd'),
      fetch('diagrams/L2-data-layer.mmd'),
      fetch('diagrams/L3-auth-service.mmd'),
    ]);

    const registry = await regResp.json();
    const files = {
      'L1-overview.mmd': await l1Resp.text(),
      'L2-frontend.mmd': await l2fResp.text(),
      'L2-backend.mmd': await l2bResp.text(),
      'L2-data-layer.mmd': await l2dResp.text(),
      'L3-auth-service.mmd': await l3aResp.text(),
    };

    // Convert registry format to project format
    const project = {
      version: 1,
      entryDiagram: registry.entryDiagram,
      diagrams: {},
    };

    for (const [id, config] of Object.entries(registry.diagrams)) {
      project.diagrams[id] = {
        title: config.title,
        drillTargets: config.drillTargets || {},
        parent: config.parent || null,
        content: files[config.file] || 'graph TB\n  A["Start"]',
      };
    }

    importProject(JSON.stringify(project));
    syncProjectName();
    navigateTo(registry.entryDiagram);
  } catch (err) {
    alert('Failed to load demo: ' + err.message);
  }
}

// --- Fullscreen ---

function toggleFullscreen() {
  const app = document.getElementById('app');
  if (!document.fullscreenElement) {
    app.requestFullscreen().catch(() => {
      app.classList.toggle('fullscreen');
    });
  } else {
    document.exitFullscreen();
  }
}

// Start the app
init().catch((err) => {
  console.error('Failed to initialize:', err);
  document.getElementById('diagram-canvas').innerHTML =
    `<div class="loading">Failed to load: ${err.message}</div>`;
});
