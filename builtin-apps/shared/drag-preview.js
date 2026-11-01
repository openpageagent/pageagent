// Visual preview only; each list keeps its existing native drag/drop ordering.
export function createDragPreview() {
  var preview = null;
  var frame = 0;
  var emptyImage = document.createElement('canvas');
  emptyImage.width = emptyImage.height = 1;
  emptyImage.setAttribute('aria-hidden', 'true');
  emptyImage.style.cssText = 'position:fixed;top:0;left:0;pointer-events:none';

  function clearPreview() {
    if (!preview) return;
    cancelAnimationFrame(frame);
    frame = 0;
    preview.source.removeEventListener('dragend', clearPreview);
    preview.node.remove();
    emptyImage.remove();
    preview = null;
    document.removeEventListener('dragover', movePreview, true);
    document.removeEventListener('dragleave', leavePreview);
    document.removeEventListener('drop', clearPreview, true);
    document.removeEventListener('dragend', clearPreview, true);
    window.removeEventListener('blur', clearPreview);
    window.removeEventListener('pagehide', clearPreview);
  }

  function start(event, source) {
    if (event.defaultPrevented || !event.dataTransfer) return;
    clearPreview();
    var rect = source.getBoundingClientRect();
    var node = source.cloneNode(true);
    node.classList.remove('app-dragging', 'dragging', 'is-dragging', 'sort-item');
    node.classList.add('sort-drag-preview');
    node.setAttribute('aria-hidden', 'true');
    node.inert = true;
    node.removeAttribute('id');
    node.removeAttribute('draggable');
    node.querySelectorAll('[id], [draggable]').forEach(function (child) {
      child.removeAttribute('id');
      child.removeAttribute('draggable');
    });
    node.style.margin = '0';
    node.style.transition = 'none';
    node.style.transform = 'none';
    node.style.left = rect.left + 'px';
    node.style.top = rect.top + 'px';
    node.style.width = rect.width + 'px';
    node.style.height = rect.height + 'px';
    // A preview inside a modal must stay in the dialog's top layer.
    (source.closest('dialog[open]') || document.body).append(node, emptyImage);
    preview = { node: node, source: source, startX: event.clientX, startY: event.clientY, x: event.clientX, y: event.clientY };
    source.addEventListener('dragend', clearPreview, { once: true });
    document.addEventListener('dragover', movePreview, true);
    document.addEventListener('dragleave', leavePreview);
    document.addEventListener('drop', clearPreview, true);
    document.addEventListener('dragend', clearPreview, true);
    window.addEventListener('blur', clearPreview);
    window.addEventListener('pagehide', clearPreview);
    // Suppress the browser snapshot, whose rectangular backdrop can cover rounded corners.
    event.dataTransfer.setDragImage(emptyImage, 0, 0);
  }

  function movePreview(event) {
    if (!preview) return;
    if (!preview.source.isConnected) { clearPreview(); return; }
    preview.node.style.visibility = '';
    if (preview.x === event.clientX && preview.y === event.clientY) return;
    preview.x = event.clientX;
    preview.y = event.clientY;
    if (frame) return;
    frame = requestAnimationFrame(function () {
      frame = 0;
      preview.node.style.transform = 'translate3d(' + (preview.x - preview.startX) + 'px,' + (preview.y - preview.startY) + 'px,0)';
    });
  }

  function leavePreview(event) {
    if (preview && !event.relatedTarget && (event.clientX <= 0 || event.clientY <= 0
        || event.clientX >= window.innerWidth || event.clientY >= window.innerHeight)) {
      preview.node.style.visibility = 'hidden';
    }
  }

  return { start: start, clear: clearPreview };
}
