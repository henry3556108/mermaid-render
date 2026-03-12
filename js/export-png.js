/**
 * PNG Export — renders the current SVG diagram to a PNG blob.
 *
 * Pipeline: clone SVG → strip interactive overlays → replace foreignObject
 * with SVG <text> → serialize → draw to offscreen Canvas → toBlob('image/png')
 */

/**
 * Replace <foreignObject> elements (Mermaid htmlLabels) with SVG <text>.
 * The Canvas Image pipeline cannot render foreignObject content.
 */
function replaceForeignObjects(svgClone) {
  const SVG_NS = 'http://www.w3.org/2000/svg';
  for (const fo of svgClone.querySelectorAll('foreignObject')) {
    const div = fo.querySelector('.nodeLabel, .edgeLabel, span');
    if (!div) { fo.remove(); continue; }

    const text = div.textContent || '';
    if (!text.trim()) { fo.remove(); continue; }

    const foX = parseFloat(fo.getAttribute('x') || 0);
    const foY = parseFloat(fo.getAttribute('y') || 0);
    const foW = parseFloat(fo.getAttribute('width') || 100);
    const foH = parseFloat(fo.getAttribute('height') || 30);

    // Compute font properties from the DOM element
    const computed = window.getComputedStyle(div);
    const fontSize = computed.fontSize || '14px';
    const fontFamily = computed.fontFamily || 'sans-serif';
    const color = computed.color || '#333';

    // Handle multiline: split on <br> or newlines
    const lines = text.split(/\n/).map(l => l.trim()).filter(Boolean);

    const svgText = document.createElementNS(SVG_NS, 'text');
    svgText.setAttribute('x', String(foX + foW / 2));
    svgText.setAttribute('text-anchor', 'middle');
    svgText.setAttribute('font-family', fontFamily);
    svgText.setAttribute('font-size', fontSize);
    svgText.setAttribute('fill', color);

    if (lines.length <= 1) {
      svgText.setAttribute('y', String(foY + foH / 2));
      svgText.setAttribute('dominant-baseline', 'central');
      svgText.textContent = text.trim();
    } else {
      const lineHeight = parseFloat(fontSize) * 1.2;
      const totalH = lineHeight * lines.length;
      const startY = foY + (foH - totalH) / 2 + lineHeight * 0.8;
      for (let i = 0; i < lines.length; i++) {
        const tspan = document.createElementNS(SVG_NS, 'tspan');
        tspan.setAttribute('x', String(foX + foW / 2));
        tspan.setAttribute('y', String(startY + i * lineHeight));
        tspan.textContent = lines[i];
        svgText.appendChild(tspan);
      }
    }

    fo.parentNode.replaceChild(svgText, fo);
  }
}

/**
 * Export the currently rendered SVG diagram as a PNG Blob.
 *
 * @param {HTMLElement} svgContainer - The #diagram-canvas element
 * @param {number} [scaleFactor=2] - Resolution multiplier (2 = retina)
 * @returns {Promise<Blob>} PNG image blob
 */
export function exportSvgAsPng(svgContainer, scaleFactor = 2) {
  return new Promise((resolve, reject) => {
    const svgEl = svgContainer.querySelector('svg');
    if (!svgEl) return reject(new Error('No SVG found'));

    // Deep-clone so we don't mutate the live DOM
    const clone = svgEl.cloneNode(true);

    // Strip interactive overlays added by renderer
    clone.querySelectorAll('.drill-btn, .subgraph-toggle').forEach(el => el.remove());

    // Dimensions from viewBox (preferred) or bounding rect
    const vb = svgEl.viewBox.baseVal;
    const svgWidth = (vb && vb.width) || svgEl.getBoundingClientRect().width;
    const svgHeight = (vb && vb.height) || svgEl.getBoundingClientRect().height;

    clone.setAttribute('width', svgWidth);
    clone.setAttribute('height', svgHeight);
    clone.removeAttribute('style');

    // Replace foreignObject elements before serialization
    // (must happen while clone is in the DOM so getComputedStyle works)
    const offscreen = document.createElement('div');
    offscreen.style.cssText = 'position:fixed;left:-99999px;top:0;visibility:hidden;';
    offscreen.appendChild(clone);
    document.body.appendChild(offscreen);

    replaceForeignObjects(clone);

    document.body.removeChild(offscreen);

    // Serialize to SVG string
    const serializer = new XMLSerializer();
    const svgString = serializer.serializeToString(clone);
    const blob = new Blob([svgString], { type: 'image/svg+xml;charset=utf-8' });
    const blobUrl = URL.createObjectURL(blob);

    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(blobUrl);
      const canvas = document.createElement('canvas');
      canvas.width = Math.round(svgWidth * scaleFactor);
      canvas.height = Math.round(svgHeight * scaleFactor);
      const ctx = canvas.getContext('2d');
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
      canvas.toBlob((pngBlob) => {
        if (pngBlob) resolve(pngBlob);
        else reject(new Error('Canvas toBlob failed'));
      }, 'image/png');
    };
    img.onerror = () => {
      URL.revokeObjectURL(blobUrl);
      reject(new Error('Failed to load SVG as image'));
    };
    img.src = blobUrl;
  });
}
