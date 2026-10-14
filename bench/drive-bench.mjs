import { spawn } from 'node:child_process';
import http from 'node:http';

const GD = '/tmp/geckodriver';
const FF = '/Applications/Firefox.app/Contents/MacOS/firefox';

const results = {};
http.createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method === 'OPTIONS') return res.end();
  if (req.method === 'POST' && req.url === '/result') {
    let b = '';
    req.on('data', c => b += c);
    req.on('end', () => {
      const r = JSON.parse(b);
      results[r.run] = r;
      res.end('ok');
    });
  } else res.end();
}).listen(8377);

const gd = spawn(GD, ['--port', '4444'], { stdio: ['ignore', 'ignore', 'pipe'] });
gd.stderr.on('data', d => {
  const s = String(d);
  if (/Script terminated|Error/i.test(s) && !/GPU|glean|crashreport|PrivateBrowsing/.test(s))
    process.stderr.write('[gd] ' + s);
});
await new Promise(r => setTimeout(r, 2000));

const wd = async (m, p, b) => (await fetch(`http://127.0.0.1:4444${p}`, {
  method: m, headers: { 'Content-Type': 'application/json' },
  body: b && JSON.stringify(b),
})).json();

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function session(label, xpis) {
  const { value: sess } = await wd('POST', '/session', {
    capabilities: { alwaysMatch: { 'moz:firefoxOptions': { binary: FF } } },
  });
  const sid = sess.sessionId || sess;
  console.log(`\n### ${label} — session ${sid.slice(0, 8)}`);
  for (const path of xpis)
    console.log('  install', path.split('/').pop(), '->', (await wd('POST', `/session/${sid}/moz/addon/install`, { path, temporary: true })).value);

  const deadline = Date.now() + 240000;
  while (!results[label] && Date.now() < deadline) await sleep(1000);
  if (results[label]) {
    console.log(results[label].lines.join('\n'));
    console.log('status:', results[label].status);
  } else console.log('  TIMEOUT');

  await wd('DELETE', `/session/${sid}`).catch(() => {});
  await sleep(2000); // let processes drain before next session
}

await session('ftt', ['/tmp/ftt.xpi']);
await session('tst', ['/tmp/bench-ext.xpi', '/tmp/tst-4.4.9.xpi']);

gd.kill();
process.exit(0);
