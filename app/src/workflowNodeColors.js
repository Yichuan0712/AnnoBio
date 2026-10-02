// High-contrast palette ordered to keep consecutively assigned colors visually distinct.
export const DATASET_BORDER_COLORS = [
  '#2563eb', '#dc2626', '#16a34a', '#9333ea', '#ea580c', '#0891b2',
  '#ca8a04', '#be123c', '#0f766e', '#4f46e5', '#65a30d', '#c026d3',
  '#0369a1', '#b45309', '#15803d', '#7c3aed', '#b91c1c', '#0d9488',
  '#a16207', '#1d4ed8', '#9d174d', '#059669', '#7e22ce', '#c2410c',
];

// Dataset and Prompt nodes share this palette so adjacent nodes can receive distinct colors.
export const NODE_COLORS_ENABLED = true;

if (typeof document !== 'undefined') {
  if (NODE_COLORS_ENABLED) delete document.documentElement.dataset.nodeColors;
  else document.documentElement.dataset.nodeColors = 'off';
}

/** Display color for a node color index, or '' while node colors are disabled. */
export function datasetColorAt(colorIndex) {
  if (!NODE_COLORS_ENABLED) return '';
  const parsed = Number.parseInt(String(colorIndex ?? ''), 10);
  const index = Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
  return DATASET_BORDER_COLORS[index % DATASET_BORDER_COLORS.length];
}

export const promptColorAt = datasetColorAt;
