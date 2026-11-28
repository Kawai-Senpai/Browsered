export function enableDrawing(image, canvas, draw, undo) {
  const strokes = [];
  let context;
  let active;
  const lineWidth = Math.max(3, Math.round(Math.min(image.naturalWidth, image.naturalHeight) / 150));

  function paint(from, to) {
    context.beginPath();
    if (from.x === to.x && from.y === to.y) {
      context.arc(to.x, to.y, lineWidth / 2, 0, 2 * Math.PI);
      context.fill();
    } else {
      context.moveTo(from.x, from.y);
      context.lineTo(to.x, to.y);
      context.stroke();
    }
  }

  function position(event) {
    const box = canvas.getBoundingClientRect();
    return {
      x: Math.max(0, Math.min(canvas.width, (event.clientX - box.left) * canvas.width / box.width)),
      y: Math.max(0, Math.min(canvas.height, (event.clientY - box.top) * canvas.height / box.height)),
    };
  }

  draw.addEventListener('click', () => {
    const drawing = draw.getAttribute('aria-pressed') !== 'true';
    if (drawing && !context) {
      canvas.width = image.naturalWidth;
      canvas.height = image.naturalHeight;
      context = canvas.getContext('2d');
      context.lineWidth = lineWidth;
      context.lineJoin = context.lineCap = 'round';
      context.strokeStyle = context.fillStyle = '#e02b32';
    }
    canvas.hidden = false;
    canvas.classList.toggle('drawing', drawing);
    draw.setAttribute('aria-pressed', String(drawing));
  });

  canvas.addEventListener('pointerdown', (event) => {
    if (active || event.button !== 0 || !event.isPrimary) return;
    const point = position(event);
    const points = [point];
    active = { pointerId: event.pointerId, points };
    strokes.push(points);
    paint(point, point);
    canvas.setPointerCapture(event.pointerId);
    undo.disabled = true;
  });
  function extendStroke(event) {
    if (active?.pointerId !== event.pointerId) return;
    const point = position(event);
    const previous = active.points.at(-1);
    if (point.x === previous.x && point.y === previous.y) return;
    paint(previous, point);
    active.points.push(point);
  }
  canvas.addEventListener('pointermove', extendStroke);
  canvas.addEventListener('pointerup', extendStroke);
  // Implicit release follows pointerup and pointercancel.
  canvas.addEventListener('lostpointercapture', (event) => {
    if (active?.pointerId !== event.pointerId) return;
    active = undefined;
    undo.disabled = false;
  });
  undo.addEventListener('click', () => {
    if (active || !strokes.length) return;
    strokes.pop();
    context.clearRect(0, 0, canvas.width, canvas.height);
    for (const points of strokes) {
      for (const [index, point] of points.entries()) paint(points[index - 1] ?? point, point);
    }
    undo.disabled = strokes.length === 0;
  });
  draw.disabled = false;

  return {
    hasStrokes: () => strokes.length > 0,
    exportPng() {
      const output = new OffscreenCanvas(canvas.width, canvas.height);
      const context = output.getContext('2d');
      context.drawImage(image, 0, 0);
      context.drawImage(canvas, 0, 0);
      return output.convertToBlob({ type: 'image/png' });
    },
  };
}
