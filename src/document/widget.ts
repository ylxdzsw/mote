export const WIDGET_SCREENSHOT_PLACEHOLDER = `data:image/svg+xml,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="340" height="220" viewBox="0 0 340 220"><rect width="340" height="220" fill="#eeeeee"/><g fill="none" stroke="#999999" stroke-width="2"><rect x="150" y="94" width="40" height="32" rx="2"/><circle cx="161" cy="103" r="3"/><path d="m152 122 12-11 7 6 8-9 9 14"/></g></svg>')}`

export const DEFAULT_WIDGET_HTML = `<button id="counter" type="button">Count: <span>0</span></button>
<style>
  #counter { border: 1px solid #9eb392; border-radius: 6px; padding: 8px 12px; background: #e9efdf; color: #355b43; cursor: pointer; }
</style>
<script>
  const button = document.querySelector('#counter');
  const count = button.querySelector('span');
  let value = 0;
  button.addEventListener('click', () => { count.textContent = String(++value); });
</script>`
