const buttons = [...document.querySelectorAll('button[data-mode]')];
const status = document.querySelector('#status');
for (const button of buttons) {
  button.addEventListener('click', async () => {
    buttons.forEach((item) => { item.disabled = true; });
    status.hidden = false;
    status.className = '';
    status.textContent = button.dataset.mode === 'region' ? 'Opening selection…' : 'Capturing…';
    try {
      const response = await chrome.runtime.sendMessage({ mode: button.dataset.mode });
      if (!response?.ok) throw new Error(response?.message || 'Screenshot failed. Try again.');
      window.close();
    } catch (error) {
      status.className = 'error';
      status.textContent = error.message;
      buttons.forEach((item) => { item.disabled = false; });
    }
  });
}
