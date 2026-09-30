// High-contrast palette ordered to keep consecutively assigned colors visually distinct.
export const DATASET_BORDER_COLORS = [
  '#2563eb', '#dc2626', '#16a34a', '#9333ea', '#ea580c', '#0891b2',
  '#ca8a04', '#be123c', '#0f766e', '#4f46e5', '#65a30d', '#c026d3',
  '#0369a1', '#b45309', '#15803d', '#7c3aed', '#b91c1c', '#0d9488',
  '#a16207', '#1d4ed8', '#9d174d', '#059669', '#7e22ce', '#c2410c',
];

// Dataset color indexes are still assigned and saved while this is off; only the display is hidden.
export const NODE_COLORS_ENABLED = false;

if (!NODE_COLORS_ENABLED && typeof document !== 'undefined') {
  document.documentElement.dataset.nodeColors = 'off';
}

/** Display color for a dataset color index, or '' while node colors are disabled. */
export function datasetColorAt(colorIndex) {
  if (!NODE_COLORS_ENABLED) return '';
  const parsed = Number.parseInt(String(colorIndex ?? ''), 10);
  const index = Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
  return DATASET_BORDER_COLORS[index % DATASET_BORDER_COLORS.length];
}
