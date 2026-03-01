/**
 * Navigator
 * Manages breadcrumb UI and diagram loading.
 */

import {
  getBreadcrumbTrail,
  navigateTo,
  getRawDefinition,
} from './state.js';

/**
 * Render the breadcrumb navigation bar.
 */
export function renderBreadcrumb() {
  const container = document.getElementById('breadcrumb');
  const trail = getBreadcrumbTrail();

  container.innerHTML = '';

  trail.forEach((item, index) => {
    if (index > 0) {
      const sep = document.createElement('span');
      sep.className = 'sep';
      sep.textContent = '>';
      container.appendChild(sep);
    }

    const crumb = document.createElement('span');
    crumb.className = 'crumb';
    crumb.textContent = item.title;

    if (index === trail.length - 1) {
      crumb.classList.add('current');
    } else {
      const targetId = item.id;
      crumb.addEventListener('click', () => {
        navigateTo(targetId);
      });
    }

    container.appendChild(crumb);
  });
}

/**
 * Get a diagram definition from the in-memory cache.
 * @param {string} diagramId
 * @returns {string} The raw .mmd content
 */
export function loadDiagramDefinition(diagramId) {
  const cached = getRawDefinition(diagramId);
  if (cached) return cached;

  // Fallback for newly created diagrams not yet cached
  return 'graph TB\n  A["Start"]';
}
