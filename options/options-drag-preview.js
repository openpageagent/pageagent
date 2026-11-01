import { createDragPreview } from '../builtin-apps/shared/drag-preview.js';

const dragPreview = createDragPreview();
document.addEventListener('dragstart', event => {
  if (event.defaultPrevented) return;
  const handle = event.target.closest('.app-card-heading[draggable="true"], .node-card-heading[draggable="true"]');
  if (handle) dragPreview.start(event, handle.closest('.app-card, .node-card'));
});
