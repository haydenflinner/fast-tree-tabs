'use strict';

const KEYS = ['newTabNoOpener', 'insertChildAt', 'closeCollapsedClosesSubtree', 'animations', 'indentSize'];

async function restore() {
  const stored = await browser.storage.local.get(KEYS);
  for (const key of KEYS) {
    const el = document.getElementById(key);
    if (!el) continue;
    const value = stored[key];
    if (value === undefined) continue; // keep the HTML default
    if (el.type === 'checkbox') el.checked = !!value;
    else el.value = value;
  }
}

function save() {
  const patch = {};
  for (const key of KEYS) {
    const el = document.getElementById(key);
    if (!el) continue;
    patch[key] = el.type === 'checkbox' ? el.checked
               : el.type === 'number'   ? Math.max(4, Math.min(40, Number(el.value) || 16))
               : el.value;
  }
  browser.storage.local.set(patch);
}

document.addEventListener('DOMContentLoaded', restore);
for (const key of KEYS)
  document.getElementById(key).addEventListener('change', save);
