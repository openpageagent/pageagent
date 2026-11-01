// Shared slot selection and displacement for both grids and vertical lists.
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  root.PageAgentSortLayout = api;
})(globalThis, function () {
  'use strict';

  function create(list, items, sourceIndex) {
    var listRect = list.getBoundingClientRect();
    var rects = items.map(function (item) {
      var rect = item.getBoundingClientRect();
      return { left: rect.left - listRect.left + list.scrollLeft,
        top: rect.top - listRect.top + list.scrollTop, width: rect.width, height: rect.height };
    });
    var rows = [];
    rects.forEach(function (rect, index) {
      var row = rows[rows.length - 1];
      if (!row || Math.abs(row.top - rect.top) > 1) {
        row = { top: rect.top, bottom: rect.top + rect.height, indices: [] };
        rows.push(row);
      }
      row.bottom = Math.max(row.bottom, rect.top + rect.height);
      row.indices.push(index);
    });
    var vertical = rows.length === items.length;
    var gap = rects.length > 1 ? rects[1].top - rects[0].top - rects[0].height : 0;
    var destinationIndex = sourceIndex;
    var sourceTop = rects[sourceIndex].top;
    list.classList.add('sort-layout');
    items.forEach(function (item) { item.classList.add('sort-item'); });

    function distance(value, start, end) { return Math.max(start - value, value - end, 0); }

    function destinationAt(clientX, clientY) {
      var bounds = list.getBoundingClientRect();
      var x = clientX - bounds.left + list.scrollLeft;
      var y = clientY - bounds.top + list.scrollTop;
      var nearestRow = rows[0], rowDistance = Infinity;
      rows.forEach(function (row) {
        var value = distance(y, row.top, row.bottom);
        if (value < rowDistance) { nearestRow = row; rowDistance = value; }
      });
      var destination = nearestRow.indices[0], columnDistance = Infinity;
      nearestRow.indices.forEach(function (index) {
        var rect = rects[index];
        var value = distance(x, rect.left, rect.left + rect.width);
        if (value < columnDistance) { destination = index; columnDistance = value; }
      });
      return destination;
    }

    function preview(index) {
      if (index === destinationIndex) return;
      destinationIndex = index;
      var order = items.map(function (_, itemIndex) { return itemIndex; });
      order.splice(sourceIndex, 1);
      order.splice(index, 0, sourceIndex);
      var top = rects[0].top;
      order.forEach(function (itemIndex, slot) {
        var original = rects[itemIndex];
        var targetLeft = vertical ? original.left : rects[slot].left;
        var targetTop = vertical ? top : rects[slot].top;
        if (itemIndex === sourceIndex) {
          // Keep the native drag source in place; only its preview follows the pointer.
          sourceTop = targetTop;
        } else {
          items[itemIndex].style.setProperty('--sort-shift-x', (targetLeft - original.left) + 'px');
          items[itemIndex].style.setProperty('--sort-shift-y', (targetTop - original.top) + 'px');
        }
        top += original.height + gap;
      });
    }

    function clear() {
      list.classList.remove('sort-layout');
      items.forEach(function (item) {
        item.classList.remove('sort-item');
        item.style.removeProperty('--sort-shift-x');
        item.style.removeProperty('--sort-shift-y');
      });
    }

    return { destinationAt: destinationAt, preview: preview, clear: clear,
      sourceTop: function () { return list.getBoundingClientRect().top - list.scrollTop + sourceTop; } };
  }

  return { create: create };
});
