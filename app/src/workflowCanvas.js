/**
 * Workflow canvas (node-based editor surface).
 */

export function buildWorkflowCanvas(root) {
  const canvas = document.createElement('div');
  canvas.className = 'workflow-canvas';
  root.appendChild(canvas);
}
