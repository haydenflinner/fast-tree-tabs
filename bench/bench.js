'use strict';

const TST_ID = 'treestyletab@piro.sakura.ne.jp';

const statusEl = document.getElementById('status');
const outEl = document.getElementById('out');
const lines = [];
function out(s) { lines.push(s); outEl.textContent = lines.join('\n'); }

// --- FTT signal: 'painted' messages forwarded from the sidebar by our bg ---
const fttPaints = [];
browser.runtime.connect({ name: 'bench' }).onMessage.addListener(m => {
  if (m.type === 'painted') fttPaints.push(Date.now());
});

// --- TST signal: public API notifications (arrive via onMessageExternal) ---
let tstReady = false;
const tstEvents = [];
browser.runtime.onMessageExternal.addListener((msg, sender) => {
  if (sender.id !== TST_ID || !msg || typeof msg !== 'object') return;
  if (msg.type === 'ready') { tstReady = true; return; }
  tstEvents.push(Date.now());
});

async function tryRegisterTst() {
  try {
    const res = await browser.runtime.sendMessage(TST_ID, {
      type: 'register-self',
      name: 'ftt-bench',
      listeningTypes: ['created', 'moved', 'activated', 'attached', 'detached', 'removed', 'group'],
    });
    if (res && res.type === 'ready') tstReady = true;
    // TST may also reply async via sendMessage; the listener above catches it.
    await new Promise(r => setTimeout(r, 500));
    statusEl.textContent = tstReady
      ? 'TST detected — comparing against its API notification pipeline.'
      : 'TST did not answer register-self — benchmarking Fast Tree Tabs only.';
  } catch (e) {
    statusEl.textContent = 'TST not installed/responding — benchmarking Fast Tree Tabs only.';
  }
}

function waitQuiet(getLast, ms = 400, timeout = 15000) {
  return new Promise(resolve => {
    let last = getLast();
    const iv = setInterval(() => {
      const now = getLast();
      if (now !== last) { last = now; return; }
      clearInterval(iv); resolve();
    }, ms);
    setTimeout(() => { clearInterval(iv); resolve(); }, timeout);
  });
}

function summarize(name, stamps, t0, n) {
  if (stamps.length === 0) return `${name}: no signals received`;
  const first = stamps[0] - t0;
  const last = stamps[stamps.length - 1] - t0;
  return `${name}: ${stamps.length} signals | first +${first}ms | all ${n} ops settled +${last}ms`;
}

async function run(kind) {
  const n = parseInt(document.getElementById('n').value) || 100;
  const out0 = `\n=== ${kind} x ${n} @ ${new Date().toLocaleTimeString()} ===`;
  out(out0);

  fttPaints.length = 0; tstEvents.length = 0;
  const t0 = Date.now();
  let ids = [];

  if (kind === 'create') {
    ids = (await Promise.all(
      Array.from({ length: n }, () => browser.tabs.create({ url: 'about:blank', active: false }))
    )).map(t => t.id);
  } else {
    const tabs = await browser.tabs.query({ currentWindow: true });
    ids = tabs.slice(0, n).map(t => t.id);
    if (kind === 'activate')
      for (const id of ids) await browser.tabs.update(id, { active: true });
    if (kind === 'close')
      await browser.tabs.remove(ids);
  }
  const tCalls = Date.now();
  out(`api calls done: +${tCalls - t0}ms`);

  await waitQuiet(() => Math.max(fttPaints.at(-1) || 0, tstEvents.at(-1) || 0));
  out(summarize('FTT painted', fttPaints, t0, n));
  if (tstReady) out(summarize('TST notified', tstEvents, t0, n));
}

document.getElementById('create').addEventListener('click', () => run('create'));
document.getElementById('activate').addEventListener('click', () => run('activate'));
document.getElementById('close').addEventListener('click', () => run('close'));
tryRegisterTst();
