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

function isDarkTheme() {
  return typeof document !== 'undefined' && document.documentElement.classList.contains('dark');
}

/** Pull a light-mode border color toward white so it stays visible on a dark node. */
function lightenForDark(hex) {
  const raw = String(hex || '').replace('#', '');
  if (!/^[0-9a-fA-F]{6}$/.test(raw)) return hex;
  const value = Number.parseInt(raw, 16);
  const mix = (channel) => Math.round(channel + (255 - channel) * 0.45);
  const channels = [mix((value >> 16) & 255), mix((value >> 8) & 255), mix(value & 255)];
  return `#${channels.map((channel) => channel.toString(16).padStart(2, '0')).join('')}`;
}

/** Display color for a node color index, or '' while node colors are disabled. */
export function datasetColorAt(colorIndex) {
  if (!NODE_COLORS_ENABLED) return '';
  const parsed = Number.parseInt(String(colorIndex ?? ''), 10);
  const index = Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
  const color = DATASET_BORDER_COLORS[index % DATASET_BORDER_COLORS.length];
  return isDarkTheme() ? lightenForDark(color) : color;
}

export const promptColorAt = datasetColorAt;

/** Store only opaque hex colors, including values typed into the color picker. */
export function normalizeNodeColor(value) {
  const hex = String(value ?? '').trim().toLowerCase();
  if (/^#[0-9a-f]{6}$/.test(hex)) return hex;
  if (/^#[0-9a-f]{3}$/.test(hex)) return '#' + [...hex.slice(1)].map((digit) => digit + digit).join('');
  return '';
}

/** Unmodified color for editing and comparison; accepts a saved node or a canvas element. */
export function nodeBaseColor(node) {
  const data = node?.dataset;
  const custom = normalizeNodeColor(data ? data.nodeColor : node?.color);
  if (custom) return custom;
  const rawIndex = data ? (data.datasetColorIndex ?? data.promptColorIndex) : node?.colorIndex;
  const parsed = Number.parseInt(String(rawIndex ?? ''), 10);
  const index = Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
  return DATASET_BORDER_COLORS[index % DATASET_BORDER_COLORS.length];
}

/** Custom colors stay exactly as selected, while automatic colors adapt to the theme. */
export function nodeDisplayColor(node) {
  if (!NODE_COLORS_ENABLED) return '';
  const color = nodeBaseColor(node);
  if (normalizeNodeColor(node?.dataset ? node.dataset.nodeColor : node?.color)) return color;
  return isDarkTheme() ? lightenForDark(color) : color;
}

/** Pick a lightly used palette color, always avoiding the previous Prompt version's color. */
export function nextNodeColorIndex(nodes, lastIndex = -1, avoidColor = '') {
  const counts = DATASET_BORDER_COLORS.map(() => 0);
  for (const node of nodes) {
    const index = DATASET_BORDER_COLORS.indexOf(nodeBaseColor(node));
    if (index >= 0) counts[index] += 1;
  }
  const excluded = normalizeNodeColor(avoidColor);
  const candidates = DATASET_BORDER_COLORS.map((color, index) => ({ color, index }))
    .filter(({ color }) => color !== excluded);
  const minimum = Math.min(...candidates.map(({ index }) => counts[index]));
  const start = (lastIndex + 1 + counts.length) % counts.length;
  for (let offset = 0; offset < counts.length; offset += 1) {
    const index = (start + offset) % counts.length;
    if (DATASET_BORDER_COLORS[index] !== excluded && counts[index] === minimum) return index;
  }
  return candidates[0].index;
}
