'use strict';

const TST_ID = 'treestyletab@piro.sakura.ne.jp';

const statusEl = document.getElementById('status');
const outEl = document.getElementById('out');
const lines = [];
function out(s) { lines.push(s); outEl.textContent = lines.join('\n'); }

// --- FTT signal: 'painted' messages forwarded from the sidebar by our bg ---
const fttPaints = [];
try {
  browser.runtime.connect({ name: 'bench' }).onMessage.addListener(m => {
    if (m.type === 'painted') fttPaints.push(Date.now());
  });
} catch (e) { /* standalone bench ext has no bench port — fine */ }

// --- TST signal: public API notifications (arrive via onMessageExternal) ---
let tstReady = false;
const tstEvents = [];        // [{t, type}]
let tstInternalUuid = null;  // parsed from sender.url -> open its sidebar in a tab
browser.runtime.onMessageExternal.addListener((msg, sender) => {
  if (sender.id !== TST_ID || !msg || typeof msg !== 'object') return;
  if (sender.url) {
    const m = /^moz-extension:\/\/([^/]+)\//.exec(sender.url);
    if (m) tstInternalUuid = m[1];
  }
  if (msg.type === 'ready') { tstReady = true; return; }
  tstEvents.push({ t: Date.now(), type: msg.type });
});

async function tryRegisterTst() {
  // TST's backend ignores external messages until its init completes; a slow
  // init (or watchdog kill) means ping stays falsy — wait it out.
  // 'Receiving end does not exist' can mean not-installed OR installed-but-
  // background-still-loading, so keep probing; give up only if it's persistent.
  let up = false, lastErr = null, everConnected = false;
  const start = Date.now();
  while (!up && Date.now() - start < (everConnected ? 120000 : 30000)) {
    try {
      const r = await browser.runtime.sendMessage(TST_ID, { type: 'ping' });
      everConnected = true;
      if (r === true) up = true;
    } catch (e) {
      lastErr = e;
      if (everConnected) break; // was reachable, now throwing — broken
    }
    if (!up) await new Promise(r => setTimeout(r, 2000));
  }
  if (!up) {
    statusEl.textContent = everConnected
      ? 'TST installed but backend never came up in 120s — benchmarking Fast Tree Tabs only.'
      : `TST not reachable (${lastErr ? lastErr.message : 'never connected'}) — benchmarking Fast Tree Tabs only.`;
    return false;
  }
  for (let attempt = 0; attempt < 30 && !tstReady; attempt++) {
    try {
      const res = await browser.runtime.sendMessage(TST_ID, {
        type: 'register-self',
        name: 'ftt-bench',
        listeningTypes: [
          'ready', 'new-tab-processed',
          'tabs-rendered', 'tabs-unrendered',
          'tree-attached', 'tree-detached',
        ],
      });
      if (res && typeof res === 'object') tstReady = true;
    } catch (e) {
      if (attempt === 9) out('TST register-self error: ' + (e && e.message || e));
      await new Promise(r => setTimeout(r, 1000)); // TST bg may still be initializing
    }
  }
  await new Promise(r => setTimeout(r, 500)); // 'ready' may arrive async, carrying sender.url
  statusEl.textContent = tstReady
    ? 'TST detected — comparing against its API notification pipeline.'
    : 'TST did not answer register-self — benchmarking Fast Tree Tabs only.';
  return tstReady;
}

// Open the FTT sidebar in a regular tab so 'painted' signals flow even when
// the real sidebar panel isn't open (automation can't click toolbar UI).
async function openSidebarTab() {
  try {
    const r = await fetch(browser.runtime.getURL('sidebar/sidebar.html'));
    if (r.ok)
      await browser.tabs.create({ url: browser.runtime.getURL('sidebar/sidebar.html'), active: false });
  } catch (e) { /* standalone ext has no sidebar page — fine */ }
}

// Open TST's sidebar page in a tab — IS_SIDEBAR is a URL check, so it runs
// the full render pipeline and broadcasts tabs-rendered on rAF, same as ours.
async function openTstSidebarTab() {
  if (!tstInternalUuid) return false;
  try {
    await browser.tabs.create({
      url: `moz-extension://${tstInternalUuid}/sidebar/sidebar.html`,
      active: false,
    });
    return true;
  } catch (e) { return false; }
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

function summarizeTst(filter, label, t0, n) {
  const stamps = tstEvents.filter(e => !filter || filter === e.type).map(e => e.t).sort((a, b) => a - b);
  return summarize(`TST ${label}`, stamps, t0, n);
}

function tstTypeCounts() {
  const c = {};
  for (const e of tstEvents) c[e.type] = (c[e.type] || 0) + 1;
  return Object.entries(c).map(([k, v]) => `${k}:${v}`).join(' ');
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
    window.__lastCreated = ids;
  } else {
    // close exactly what we created — FTT moves burst tabs under the active
    // tab, so positional slicing could eat the sidebar/bench tabs instead
    ids = window.__lastCreated && window.__lastCreated.length
      ? window.__lastCreated.slice(0, n)
      : (await browser.tabs.query({ currentWindow: true })).slice(-n).map(t => t.id);
    if (kind === 'activate')
      for (const id of ids) await browser.tabs.update(id, { active: true });
    if (kind === 'close')
      await browser.tabs.remove(ids);
  }
  const tCalls = Date.now();
  out(`api calls done: +${tCalls - t0}ms`);

  await waitQuiet(() => Math.max(fttPaints.at(-1) || 0, (tstEvents.at(-1) || {}).t || 0));
  out(summarize('FTT painted', fttPaints, t0, n));
  if (tstReady) {
    out(summarizeTst('tabs-rendered', 'tabs-rendered (rAF render, like our painted)', t0, n));
    out(summarizeTst('tabs-unrendered', 'tabs-unrendered (rAF removal)', t0, n));
    out(summarizeTst('new-tab-processed', 'new-tab-processed (bg pipeline)', t0, n));
    out(summarizeTst(null, 'all notifications', t0, n));
    out(`TST notify type counts: ${tstTypeCounts()}`);
  }
}

document.getElementById('create').addEventListener('click', () => run('create'));
document.getElementById('activate').addEventListener('click', () => run('activate'));
document.getElementById('close').addEventListener('click', () => run('close'));

// autorun mode: launched by the bg when bench/autorun exists in the package.
// Runs the suite once, then POSTs results to the local collector.
const AUTO = new URLSearchParams(location.search).has('auto');
const COLLECTOR = 'http://127.0.0.1:8377/result';

async function autoRun() {
  window.__benchDone = false;
  let runTag = 'tst';
  try {
    const hasSidebar = await fetch(browser.runtime.getURL('sidebar/sidebar.html')).then(r => r.ok).catch(() => false);
    runTag = hasSidebar ? 'ftt' : 'tst';
    const tstOk = await tryRegisterTst();
    await openSidebarTab();
    if (tstOk) {
      const opened = await openTstSidebarTab();
      out(`TST sidebar-in-tab: ${opened ? 'opened' : 'FAILED (no uuid / blocked)'}`);
    }
    await new Promise(r => setTimeout(r, 2000)); // let sidebars settle
    await run('create');
    await new Promise(r => setTimeout(r, 500));
    await run('close');
  } catch (e) {
    out('autorun failed: ' + (e && e.message || e));
  }
  window.__benchResult = { run: runTag, status: statusEl.textContent, lines };
  window.__benchDone = true;
  fetch(COLLECTOR, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(window.__benchResult),
  }).catch(() => {});
}

if (AUTO) autoRun(); else tryRegisterTst();
