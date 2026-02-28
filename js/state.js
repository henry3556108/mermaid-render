/**
 * State Manager
 * Manages collapse states, navigation stack, current diagram,
 * localStorage persistence, and project CRUD.
 */

const STORAGE_KEY = 'mermaid-project';
const PROJECT_VERSION = 1;
const SAVE_DEBOUNCE_MS = 300;

let _saveTimer = null;

const state = {
  currentDiagramId: null,
  // Map of diagramId -> Set of collapsed subgraph IDs
  collapseStates: {},
  // Registry data
  registry: null,
  // Raw .mmd content cache: diagramId -> string
  rawDefinitions: {},
  // User-edited content cache: diagramId -> string (null = not edited)
  editorContent: {},
  // Event listeners
  _listeners: [],
};

export function onStateChange(fn) {
  state._listeners.push(fn);
}

function notify(eventType) {
  for (const fn of state._listeners) {
    fn(eventType);
  }
}

// --- Registry ---

export function setRegistry(registry) {
  state.registry = registry;
}

export function getRegistry() {
  return state.registry;
}

export function getProjectName() {
  return state.registry ? state.registry.projectName || 'Untitled Project' : 'Untitled Project';
}

export function setProjectName(name) {
  if (!state.registry) return;
  state.registry.projectName = name || 'Untitled Project';
  _saveNow();
}

export function getCurrentDiagramId() {
  return state.currentDiagramId;
}

export function getCurrentDiagramConfig() {
  if (!state.registry || !state.currentDiagramId) return null;
  return state.registry.diagrams[state.currentDiagramId] || null;
}

export function getDrillTargets() {
  const config = getCurrentDiagramConfig();
  return config ? config.drillTargets || {} : {};
}

export function cacheDefinition(diagramId, definition) {
  state.rawDefinitions[diagramId] = definition;
}

export function getRawDefinition(diagramId) {
  return state.rawDefinitions[diagramId] || null;
}

// --- Navigation ---

export function navigateTo(diagramId) {
  if (diagramId === state.currentDiagramId) return;
  state.currentDiagramId = diagramId;
  notify('navigate');
}

/**
 * Navigate to parent diagram in the tree hierarchy.
 */
export function navigateBack() {
  const config = getCurrentDiagramConfig();
  if (!config || !config.parent) return;
  const parentId = config.parent;
  if (state.registry.diagrams[parentId]) {
    state.currentDiagramId = parentId;
    notify('navigate');
  }
}

/**
 * Navigate to a specific diagram by ID (used by breadcrumb clicks).
 */
export function navigateToBreadcrumb(diagramId) {
  if (diagramId === state.currentDiagramId) return;
  state.currentDiagramId = diagramId;
  notify('navigate');
}

/**
 * Build breadcrumb trail by walking up the parent chain.
 * Always reflects the tree position regardless of how you navigated here.
 * e.g. System Overview > Backend Services > Auth Service Detail
 */
export function getBreadcrumbTrail() {
  const trail = [];
  let id = state.currentDiagramId;
  const visited = new Set();

  while (id) {
    if (visited.has(id)) break; // safety: prevent infinite loop on corrupted data
    visited.add(id);
    const config = state.registry.diagrams[id];
    trail.unshift({ id, title: config ? config.title : id });
    id = config ? config.parent : null;
  }

  return trail;
}

// --- Collapse ---

export function getCollapseState(diagramId) {
  if (!state.collapseStates[diagramId]) {
    state.collapseStates[diagramId] = new Set();
  }
  return state.collapseStates[diagramId];
}

export function isCollapsed(diagramId, subgraphId) {
  return getCollapseState(diagramId).has(subgraphId);
}

export function toggleCollapse(diagramId, subgraphId) {
  const s = getCollapseState(diagramId);
  if (s.has(subgraphId)) {
    s.delete(subgraphId);
  } else {
    s.add(subgraphId);
  }
  notify('collapse');
}

// --- Editor Content ---

export function setEditorContent(diagramId, content) {
  state.editorContent[diagramId] = content;
  // Also update raw definition (content IS the source of truth now)
  state.rawDefinitions[diagramId] = content;
  persistProject();
}

export function getEditorContent(diagramId) {
  return state.editorContent[diagramId] ?? null;
}

export function clearEditorContent(diagramId) {
  delete state.editorContent[diagramId];
  persistProject();
}

// --- localStorage Persistence ---

function _saveNow() {
  if (!state.registry) return;
  const project = {
    version: PROJECT_VERSION,
    projectName: state.registry.projectName || 'Untitled Project',
    entryDiagram: state.registry.entryDiagram,
    diagrams: {},
  };
  for (const [id, config] of Object.entries(state.registry.diagrams)) {
    project.diagrams[id] = {
      title: config.title,
      drillTargets: config.drillTargets || {},
      parent: config.parent || null,
      content: state.rawDefinitions[id] || 'graph TB\n  A["Start"]',
    };
  }
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(project));
  } catch (e) {
    alert('Failed to save project: storage quota exceeded.');
  }
}

export function persistProject() {
  clearTimeout(_saveTimer);
  _saveTimer = setTimeout(_saveNow, SAVE_DEBOUNCE_MS);
}

export function loadProject() {
  const raw = localStorage.getItem(STORAGE_KEY);
  if (!raw) {
    createDefaultProject();
    return { isNew: true };
  }

  try {
    const project = JSON.parse(raw);
    _hydrateFromProject(project);
    return { isNew: false };
  } catch (e) {
    console.error('Failed to parse saved project, creating default:', e);
    createDefaultProject();
    return { isNew: true };
  }
}

function _hydrateFromProject(project) {
  const registry = {
    projectName: project.projectName || 'Untitled Project',
    entryDiagram: project.entryDiagram,
    diagrams: {},
  };

  for (const [id, diag] of Object.entries(project.diagrams)) {
    registry.diagrams[id] = {
      title: diag.title,
      drillTargets: diag.drillTargets || {},
      parent: diag.parent || null,
    };
    state.rawDefinitions[id] = diag.content;
  }

  state.registry = registry;
  state.currentDiagramId = null;
  state.editorContent = {};

  state.collapseStates = {};
}

export function createDefaultProject() {
  const id = _generateId();
  const registry = {
    projectName: 'Untitled Project',
    entryDiagram: id,
    diagrams: {
      [id]: {
        title: 'My Diagram',
        drillTargets: {},
        parent: null,
      },
    },
  };
  state.registry = registry;
  state.rawDefinitions = {
    [id]: 'graph TB\n  A["Start"] --> B["End"]',
  };
  state.editorContent = {};

  state.collapseStates = {};
  _saveNow();
}

// --- Project Export / Import ---

export function getProjectJSON() {
  // Force a save first to ensure we have latest data
  _saveNow();
  const raw = localStorage.getItem(STORAGE_KEY);
  return raw || '{}';
}

export function importProject(jsonString) {
  const project = JSON.parse(jsonString);

  // Basic validation
  if (!project.diagrams || typeof project.diagrams !== 'object') {
    throw new Error('Invalid project: missing diagrams');
  }
  if (!project.entryDiagram || !project.diagrams[project.entryDiagram]) {
    throw new Error('Invalid project: entryDiagram not found');
  }

  _hydrateFromProject(project);
  _saveNow();
  notify('project-structure');
}

// --- Diagram CRUD ---

let _idCounter = 0;

function _generateId() {
  _idCounter++;
  return 'diagram-' + Date.now() + '-' + _idCounter;
}

export function addDiagram(title, initialContent) {
  const id = _generateId();
  state.registry.diagrams[id] = {
    title: title || 'Untitled',
    drillTargets: {},
    parent: null,
  };
  state.rawDefinitions[id] = initialContent || 'graph TB\n  A["Start"]';
  _saveNow();
  notify('project-structure');
  return id;
}

export function deleteDiagram(diagramId) {
  if (!state.registry || !state.registry.diagrams[diagramId]) return;

  const diagramIds = Object.keys(state.registry.diagrams);
  if (diagramIds.length <= 1) {
    alert('Cannot delete the last diagram.');
    return false;
  }

  // Clean up drillTargets in all diagrams that point to the deleted diagram
  for (const [id, config] of Object.entries(state.registry.diagrams)) {
    if (config.drillTargets) {
      for (const [nodeId, targetId] of Object.entries(config.drillTargets)) {
        if (targetId === diagramId) {
          delete config.drillTargets[nodeId];
        }
      }
    }
  }

  // If deleting the entry diagram, pick another one
  if (state.registry.entryDiagram === diagramId) {
    const remaining = diagramIds.filter(id => id !== diagramId);
    state.registry.entryDiagram = remaining[0];
  }

  delete state.registry.diagrams[diagramId];
  delete state.rawDefinitions[diagramId];
  delete state.editorContent[diagramId];
  delete state.collapseStates[diagramId];

  _saveNow();
  notify('project-structure');
  return true;
}

export function renameDiagram(diagramId, newTitle) {
  if (!state.registry || !state.registry.diagrams[diagramId]) return;
  state.registry.diagrams[diagramId].title = newTitle;
  _saveNow();
  notify('project-structure');
}

// --- Drill Target Management ---

/**
 * Check if setting targetId as a child of sourceId would create a cycle.
 * Walks up the ancestor chain of sourceId; if targetId is found, it's a cycle.
 */
function _wouldCreateCycle(sourceId, targetId) {
  let current = sourceId;
  const visited = new Set();
  while (current) {
    if (current === targetId) return true;
    if (visited.has(current)) break; // safety: already a cycle in data
    visited.add(current);
    const config = state.registry.diagrams[current];
    current = config ? config.parent : null;
  }
  return false;
}

/**
 * Check if any other drill target (from the same parent) still points to targetId.
 */
function _hasOtherLinkToTarget(parentId, targetId) {
  const config = state.registry.diagrams[parentId];
  if (!config || !config.drillTargets) return false;
  return Object.values(config.drillTargets).some(t => t === targetId);
}

export function setDrillTarget(diagramId, nodeId, targetId) {
  if (!state.registry || !state.registry.diagrams[diagramId]) return false;
  if (!state.registry.diagrams[targetId]) return false;

  if (!state.registry.diagrams[diagramId].drillTargets) {
    state.registry.diagrams[diagramId].drillTargets = {};
  }

  state.registry.diagrams[diagramId].drillTargets[nodeId] = targetId;

  // Set parent on target only if it won't create a cycle in the tree hierarchy.
  // Drill links can freely form cycles (e.g. C → B), but the parent tree stays acyclic.
  const targetConfig = state.registry.diagrams[targetId];
  if (!_wouldCreateCycle(diagramId, targetId)) {
    if (targetConfig.parent && targetConfig.parent !== diagramId) {
      const parentTitle = state.registry.diagrams[targetConfig.parent]?.title || targetConfig.parent;
      if (!confirm(`"${targetConfig.title}" is already a child of "${parentTitle}". Move it under the current diagram?`)) {
        // Still save the drill link, just don't change parent
        _saveNow();
        notify('drill-targets');
        notify('project-structure');
        return true;
      }
    }
    targetConfig.parent = diagramId;
  }

  _saveNow();
  notify('drill-targets');
  notify('project-structure');
  return true;
}

export function removeDrillTarget(diagramId, nodeId) {
  if (!state.registry || !state.registry.diagrams[diagramId]) return;
  const drillTargets = state.registry.diagrams[diagramId].drillTargets;
  if (!drillTargets) return;

  const targetId = drillTargets[nodeId];
  delete drillTargets[nodeId];

  // If no other drill link from this diagram points to the same target,
  // and the target's parent is this diagram, clear the parent
  if (targetId && state.registry.diagrams[targetId]) {
    if (!_hasOtherLinkToTarget(diagramId, targetId)) {
      if (state.registry.diagrams[targetId].parent === diagramId) {
        state.registry.diagrams[targetId].parent = null;
      }
    }
  }

  _saveNow();
  notify('drill-targets');
  notify('project-structure');
}

// --- Utility ---

/**
 * Get all diagrams as a flat list sorted by tree hierarchy.
 * Each item includes { id, title, depth } for UI indentation.
 */
export function getAllDiagramList() {
  if (!state.registry) return [];

  const diagrams = state.registry.diagrams;
  const ids = Object.keys(diagrams);

  // Build children map
  const childrenOf = {};
  for (const id of ids) {
    childrenOf[id] = [];
  }
  for (const id of ids) {
    const parent = diagrams[id].parent;
    if (parent && childrenOf[parent]) {
      childrenOf[parent].push(id);
    }
  }

  // Collect roots (no parent or parent not in diagrams)
  const roots = ids.filter(id => {
    const p = diagrams[id].parent;
    return !p || !diagrams[p];
  });

  // DFS to build ordered list with depth
  const result = [];
  function walk(id, depth) {
    result.push({ id, title: diagrams[id].title, depth });
    for (const childId of childrenOf[id]) {
      walk(childId, depth + 1);
    }
  }
  for (const rootId of roots) {
    walk(rootId, 0);
  }

  return result;
}
