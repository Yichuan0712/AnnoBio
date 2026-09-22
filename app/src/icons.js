/**
 * Small inline SVG icon set (Lucide's designs: 24x24 viewBox, 2px stroke, round caps/joins) —
 * this project has no icon font/library dependency, so icons are vendored as plain primitive
 * data here instead, in the same spirit as modalMaximize.js's iconClose/iconMaximize.
 */
function svgIcon({ paths = [], circles = [], lines = [], rects = [], polylines = [], viewBox = '0 0 24 24', size = 16 } = {}) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', viewBox);
  svg.setAttribute('width', String(size));
  svg.setAttribute('height', String(size));
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '2');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  svg.setAttribute('aria-hidden', 'true');
  paths.forEach((d) => {
    const el = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    el.setAttribute('d', d);
    svg.appendChild(el);
  });
  circles.forEach(([cx, cy, r]) => {
    const el = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
    el.setAttribute('cx', String(cx));
    el.setAttribute('cy', String(cy));
    el.setAttribute('r', String(r));
    svg.appendChild(el);
  });
  lines.forEach(([x1, y1, x2, y2]) => {
    const el = document.createElementNS('http://www.w3.org/2000/svg', 'line');
    el.setAttribute('x1', String(x1));
    el.setAttribute('y1', String(y1));
    el.setAttribute('x2', String(x2));
    el.setAttribute('y2', String(y2));
    svg.appendChild(el);
  });
  rects.forEach(([x, y, w, h, r]) => {
    const el = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
    el.setAttribute('x', String(x));
    el.setAttribute('y', String(y));
    el.setAttribute('width', String(w));
    el.setAttribute('height', String(h));
    if (r != null) { el.setAttribute('rx', String(r)); el.setAttribute('ry', String(r)); }
    svg.appendChild(el);
  });
  polylines.forEach((points) => {
    const el = document.createElementNS('http://www.w3.org/2000/svg', 'polyline');
    el.setAttribute('points', points);
    svg.appendChild(el);
  });
  return svg;
}

/** Lucide "merge" — two lines converging into one, like a highway merge sign. */
export const iconMerge = (size) => svgIcon({
  size,
  paths: [
    'm8 6 4-4 4 4',
    'M12 2v10.3a4 4 0 0 1-1.172 2.872L4 22',
    'm20 22-5-5',
  ],
});

/** Lucide "copy" */
export const iconCopy = (size) => svgIcon({
  size,
  rects: [[8, 8, 14, 14, 2]],
  paths: ['M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2'],
});

/** Lucide "download" */
export const iconDownload = (size) => svgIcon({
  size,
  paths: ['M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4'],
  polylines: ['7 10 12 15 17 10'],
  lines: [[12, 15, 12, 3]],
});

/** Lucide "trash-2" */
export const iconTrash = (size) => svgIcon({
  size,
  paths: [
    'M3 6h18',
    'M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6',
    'M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2',
  ],
  lines: [[10, 11, 10, 17], [14, 11, 14, 17]],
});

/** Lucide "image-plus" — shared by "batch import" and "import (one) image": an image frame with a
 * plus badge reads as "add an image" even alone, unlike a generic upload arrow (could be any file)
 * or a bare "+" (could be "add" anything — a row, a column). */
export const iconImageAdd = (size) => svgIcon({
  size,
  paths: [
    'M16 5h6',
    'M19 2v6',
    'M21 11.5V19a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h7.5',
    'm21 15-3.086-3.086a2 2 0 0 0-2.828 0L6 21',
  ],
  circles: [[9, 9, 2]],
});

/** Lucide "file-text" — used for PDF-column cell chips and buttons. */
export const iconFileText = (size) => svgIcon({
  size,
  paths: [
    'M6 22a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h8a2.4 2.4 0 0 1 1.704.706l3.588 3.588A2.4 2.4 0 0 1 20 8v12a2 2 0 0 1-2 2z',
    'M14 2v5a1 1 0 0 0 1 1h5',
    'M10 9H8',
    'M16 13H8',
    'M16 17H8',
  ],
});
