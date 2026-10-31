/**
 * Small inline SVG icon set (Lucide's designs: 24x24 viewBox, 2px stroke, round caps/joins) —
 * this project has no icon font/library dependency, so icons are vendored as plain primitive
 * data here instead, in the same spirit as modalMaximize.js's iconClose/iconMaximize.
 */
function svgIcon({ paths = [], circles = [], lines = [], rects = [], polylines = [], viewBox = '0 0 24 24', size = 16, strokeWidth = 2 } = {}) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', viewBox);
  svg.setAttribute('width', String(size));
  svg.setAttribute('height', String(size));
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', String(strokeWidth));
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

export const iconFolder = (size) => svgIcon({ size, paths: ['M20 20H4a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h5l2 2h9a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2Z'] });

export const iconText = (size) => svgIcon({
  size,
  lines: [[4, 6, 20, 6], [4, 12, 20, 12], [4, 18, 15, 18]],
});

/** The Prompt node's three lines, shared with its inputs and Optimize's new Prompt output. */
export const iconPrompt = (size = 14) => svgIcon({
  size, viewBox: '0 0 14 14', strokeWidth: 1.5,
  lines: [[2, 4, 12, 4], [2, 7, 12, 7], [2, 10, 8, 10]],
});

/** A single filled four-point sparkle for Generate, shared with its toolbar and input sources. */
export const iconRun = (size = 14) => {
  const svg = svgIcon({ size, paths: ['M12 2 14.8 9.2 22 12 14.8 14.8 12 22 9.2 14.8 2 12 9.2 9.2Z'] });
  svg.setAttribute('fill', 'currentColor');
  svg.setAttribute('stroke', 'none');
  return svg;
};

/** Code chevrons for Process, shared with the toolbar and pipeline step lists. */
export const iconProcess = (size = 14) => svgIcon({
  size,
  paths: ['m16 18 6-6-6-6', 'm8 6-6 6 6 6'],
});

/** The Evaluate node's chart, shared with Optimize's source input. */
export const iconEvaluate = (size = 14) => svgIcon({
  size,
  viewBox: '0 0 14 14',
  strokeWidth: 1.2,
  paths: ['M3 8v4M6 5v7M9 3v9M12 6v6'],
});

/** The original Dataset node's grid, shared with table inputs. */
export const iconDataset = (size = 14) => svgIcon({
  size,
  viewBox: '0 0 14 14',
  strokeWidth: 1.2,
  rects: [[1, 1, 12, 12, 0.5]],
  lines: [[1, 4, 13, 4], [1, 7, 13, 7], [1, 10, 13, 10], [4.5, 1, 4.5, 13], [8, 1, 8, 13]],
});

/** Lucide "merge" — two lines converging into one, like a highway merge sign. */
export const iconMerge = (size) => svgIcon({
  size,
  paths: [
    'm8 6 4-4 4 4',
    'M12 2v10.3a4 4 0 0 1-1.172 2.872L4 22',
    'm20 22-5-5',
  ],
});

/** Lucide "git-compare-arrows" */
export const iconGitCompareArrows = (size) => svgIcon({
  size,
  circles: [[5, 6, 3], [19, 18, 3]],
  paths: [
    'M12 6h5a2 2 0 0 1 2 2v7',
    'm15 9-3-3 3-3',
    'M12 18H7a2 2 0 0 1-2-2V9',
    'm9 15 3 3-3 3',
  ],
});

/** Lucide "copy" */
export const iconCopy = (size) => svgIcon({
  size,
  rects: [[8, 8, 14, 14, 2]],
  paths: ['M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2'],
});

/** Lucide "pencil" */
export const iconPencil = (size) => svgIcon({
  size,
  paths: [
    'M21.174 6.812a1 1 0 0 0-3.986-3.987L3.842 16.174a2 2 0 0 0-.5.83l-1.321 4.352a.5.5 0 0 0 .623.622l4.353-1.32a2 2 0 0 0 .83-.497z',
    'm15 5 4 4',
  ],
});

/** Lucide "download" */
export const iconDownload = (size) => svgIcon({
  size,
  paths: ['M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4'],
  polylines: ['7 10 12 15 17 10'],
  lines: [[12, 15, 12, 3]],
});

/** Lucide "paperclip" */
export const iconPaperclip = (size) => svgIcon({
  size,
  paths: ['m16 6-8.414 8.586a2 2 0 0 0 2.829 2.829l8.414-8.586a4 4 0 1 0-5.657-5.657l-8.379 8.551a6 6 0 1 0 8.485 8.485l8.379-8.551'],
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

/** Lucide "square-plus" — add one asset to an image or PDF cell. */
export const iconSquarePlus = (size) => svgIcon({
  size,
  rects: [[3, 3, 18, 18, 2]],
  paths: ['M8 12h8', 'M12 8v8'],
});

/** Lucide "plus" */
export const iconPlus = (size) => svgIcon({
  size,
  paths: ['M5 12h14', 'M12 5v14'],
});

/** Lucide "x" — remove one item from a list (the whole list uses iconTrash). */
export const iconX = (size) => svgIcon({
  size,
  paths: ['M18 6 6 18', 'M6 6l12 12'],
});

/** Lucide "file-text" — used for a PDF chip that already has a file (mirrors the image thumbnail:
 * this represents a file that's there, not an action). */
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

/** Lucide "workflow" — two nodes joined by an elbow connector, the canvas in miniature. */
export const iconWorkflow = (size) => svgIcon({
  size,
  rects: [[3, 3, 8, 8, 2], [13, 13, 8, 8, 2]],
  paths: ['M7 11v4a2 2 0 0 0 2 2h4'],
});

/** Lucide "history" — a clock with a return arrow. */
export const iconHistory = (size) => svgIcon({
  size,
  paths: [
    'M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8',
    'M12 7v5l4 2',
  ],
  polylines: ['3 3 3 8 8 8'],
});

/** Lucide "copy-plus" — batch import into an image or PDF column. */
export const iconCopyPlus = (size) => svgIcon({
  size,
  paths: ['M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2'],
  lines: [[15, 12, 15, 18], [12, 15, 18, 15]],
  rects: [[8, 8, 14, 14, 2]],
});

/**
 * VS Code-style layout icons for the desktop top bar's panel toggles (workflowCanvas.js): a window
 * frame whose bottom / right region is filled while that panel is open and only outlined while it
 * is hidden, so the icon itself shows the state. Drawn on the 12-unit grid of modalMaximize.js's
 * window-control icons, at the same rendered line weight, so they sit together in the title bar.
 */
function layoutIcon(region, open, size = 12) {
  const svg = svgIcon({ size, viewBox: '0 0 12 12', rects: [[1, 1.5, 10, 9, 0.5]] });
  svg.setAttribute('stroke-width', '1.25');
  const [x, y, w, h] = region === 'bottom' ? [1, 7, 10, 3.5] : [7.5, 1.5, 3.5, 9];
  if (open) {
    const fill = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
    fill.setAttribute('x', String(x));
    fill.setAttribute('y', String(y));
    fill.setAttribute('width', String(w));
    fill.setAttribute('height', String(h));
    fill.setAttribute('fill', 'currentColor');
    fill.setAttribute('stroke', 'none');
    svg.appendChild(fill);
  } else {
    const divider = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    divider.setAttribute('d', region === 'bottom' ? 'M1 7h10' : 'M7.5 1.5v9');
    svg.appendChild(divider);
  }
  return svg;
}

/** The bottom panel (Pipeline, Prompt Optimization; plus Log on desktop). */
export const iconLayoutPanel = (open, size) => layoutIcon('bottom', open, size);

/** The right panel (Agent Assistant). */
export const iconLayoutSidebarRight = (open, size) => layoutIcon('right', open, size);

/** Bottom dock: a window with its lower panel marked off. */
export const iconBottomPanel = (size = 18) => svgIcon({
  size,
  strokeWidth: 1.7,
  rects: [[2, 3, 20, 18, 2]],
  lines: [[2, 15, 22, 15]],
});

/** A simple message outline with the same stroke and corner treatment as the web toolbar. */
export const iconAgentAssistant = (size = 18) => svgIcon({
  size,
  strokeWidth: 1.7,
  paths: ['M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2Z'],
  lines: [[7, 8, 17, 8], [7, 12, 14, 12]],
});
