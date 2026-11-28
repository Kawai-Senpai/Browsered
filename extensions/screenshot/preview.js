import { takeCapture } from './captures.js';
import { enableDrawing } from './drawing.js';

const copy = document.querySelector('#copy');
const save = document.querySelector('#save');
const status = document.querySelector('#status');
const preview = document.querySelector('#capture');

async function displayCapture() {
  const capture = await takeCapture(location.hash.slice(1));
  if (!capture) throw new Error('This preview has expired. Take another screenshot.');
  const url = URL.createObjectURL(capture.image);
  preview.src = url;
  await preview.decode();
  preview.parentElement.hidden = false;
  const drawing = enableDrawing(preview, document.querySelector('#ink'),
    document.querySelector('#draw'), document.querySelector('#undo'));
  save.href = url;
  save.download = capture.filename;
  save.hidden = false;
  copy.addEventListener('click', async () => {
    try {
      const image = drawing.hasStrokes() ? drawing.exportPng() : capture.image;
      await navigator.clipboard.write([new ClipboardItem({ 'image/png': image })]);
      status.textContent = 'Image copied to clipboard.';
    } catch {
      status.textContent = 'The image could not be copied. Keep this tab focused and try again.';
    }
  });
  save.addEventListener('click', async (event) => {
    if (!drawing.hasStrokes()) return;
    event.preventDefault();
    try {
      const link = document.createElement('a');
      link.href = URL.createObjectURL(await drawing.exportPng());
      link.download = capture.filename.replace(/\.png$/, '-annotated.png');
      link.click();
      setTimeout(() => URL.revokeObjectURL(link.href), 30_000);
    } catch {
      status.textContent = 'The annotated image could not be saved. Try again.';
    }
  });
  document.addEventListener('keydown', (event) => {
    if (!(event.ctrlKey || event.metaKey) || event.key.toLowerCase() !== 'c' || String(getSelection())) return;
    event.preventDefault();
    copy.click();
  });
  copy.disabled = false;
  copy.focus();
}

displayCapture().catch((error) => { status.textContent = error.message; });
