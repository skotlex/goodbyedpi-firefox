#!/usr/bin/env node
'use strict';
// 실제 Firefox 와 실제 도우미로 전체 흐름을 검증한다. 임시 프로필을 쓰며 사용자 프로필은 건드리지 않는다.
// 도우미를 실제로 설치했다가 제거하므로, 이미 설치되어 있으면 끝날 때 다시 설치해 둔다.
//   node tests/e2e-firefox.js [결과 폴더]

const net = require('net');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawn, execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const EXT_DIR = path.join(ROOT, 'src');
const SETUP = path.join(EXT_DIR, 'native', 'GoodbyeDPI-Firefox-Setup.exe');
const EXT_ID = 'goodbyedpi-firefox@skotlex';
const FIREFOX = process.env.FIREFOX_BIN || 'C:\\Program Files\\Mozilla Firefox\\firefox.exe';
const INSTALL_DIR = path.join(process.env.LOCALAPPDATA, 'GoodbyeDPIFirefox');
const BACKEND = path.join(INSTALL_DIR, 'ciadpi.exe');
const HOST_KEY = 'HKCU:\\SOFTWARE\\Mozilla\\NativeMessagingHosts\\com.goodbyedpi.firefox';
const MARIONETTE_PORT = 28280;
const OUT = process.argv[2] || fs.mkdtempSync(path.join(os.tmpdir(), 'goodbyedpi-e2e-'));
const SITE_A = 'example.com';
const SITE_B = 'www.mozilla.org';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ps = (c) => execFileSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', c], { encoding: 'utf8' }).trim();
const sha256 = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');

let failures = 0;
function check(name, ok, detail) {
  if (!ok) failures++;
  console.log(`${ok ? '  ok ' : 'FAIL '} ${name}${detail !== undefined ? ` — ${typeof detail === 'string' ? detail : JSON.stringify(detail)}` : ''}`);
}
const section = (name) => console.log(`\n== ${name}`);

async function until(fn, timeoutMs, stepMs = 250) {
  const end = Date.now() + timeoutMs;
  for (;;) {
    const value = await fn();
    if (value) return value;
    if (Date.now() > end) return value;
    await sleep(stepMs);
  }
}

// 실행 중인 모든 ciadpi. 이 도우미의 것과 다른 프로그램의 것을 경로로 구분한다.
function ciadpiProcesses() {
  const out = ps(`Get-CimInstance Win32_Process -Filter "Name='ciadpi.exe'" | ForEach-Object { "$($_.ProcessId)|$($_.ExecutablePath)|$($_.CommandLine)" }`);
  return out ? out.split(/\r?\n/).map((l) => { const [pid, exe, cmd] = l.split('|'); return { pid: +pid, exe, cmd }; }) : [];
}
const ourBackend = () => ciadpiProcesses().filter((p) => p.exe.toLowerCase() === BACKEND.toLowerCase());
const otherBackends = () => ciadpiProcesses().filter((p) => p.exe.toLowerCase() !== BACKEND.toLowerCase()).map((p) => p.pid).sort();
const outboundConnections = (pid) => +ps(`@(Get-NetTCPConnection -OwningProcess ${pid} -State Established -ErrorAction SilentlyContinue | Where-Object { $_.RemotePort -eq 443 }).Count`);

// ---- Marionette ----------------------------------------------------------

class Marionette {
  constructor() { this.buffer = Buffer.alloc(0); this.id = 0; this.waiting = {}; }
  connect() {
    return new Promise((resolve, reject) => {
      let tries = 0;
      const attempt = () => {
        const socket = net.connect(MARIONETTE_PORT, '127.0.0.1');
        socket.once('error', () => { if (++tries > 60) reject(new Error('Marionette 연결 실패')); else setTimeout(attempt, 500); });
        socket.once('connect', () => {
          this.socket = socket;
          let greeted = false;
          socket.on('data', (data) => {
            this.buffer = Buffer.concat([this.buffer, data]);
            for (;;) {
              const colon = this.buffer.indexOf(58);
              if (colon < 0) return;
              const length = +this.buffer.slice(0, colon).toString();
              if (this.buffer.length < colon + 1 + length) return;
              const packet = JSON.parse(this.buffer.slice(colon + 1, colon + 1 + length).toString());
              this.buffer = this.buffer.slice(colon + 1 + length);
              if (!greeted) { greeted = true; resolve(); continue; }
              const waiter = this.waiting[packet[1]];
              if (waiter) {
                delete this.waiting[packet[1]];
                if (packet[2]) waiter.reject(new Error(packet[2].message || JSON.stringify(packet[2])));
                else waiter.resolve(packet[3]);
              }
            }
          });
        });
      };
      attempt();
    });
  }
  command(name, params = {}) {
    const id = ++this.id;
    const body = JSON.stringify([0, id, name, params]);
    return new Promise((resolve, reject) => {
      this.waiting[id] = { resolve, reject };
      this.socket.write(`${Buffer.byteLength(body)}:${body}`);
    });
  }
}

let mn;
const inPage = async (script, args = []) => (await mn.command('WebDriver:ExecuteScript', { script, args })).value;
async function inChrome(script, args = []) {
  await mn.command('Marionette:SetContext', { value: 'chrome' });
  try { return (await mn.command('WebDriver:ExecuteScript', { script, args })).value; }
  finally { await mn.command('Marionette:SetContext', { value: 'content' }); }
}
const proxyPrefs = () => inChrome(`return {
  type: Services.prefs.getIntPref('network.proxy.type'),
  url: Services.prefs.getCharPref('network.proxy.autoconfig_url', ''),
};`);
const setPacPref = (url) => inChrome(`Services.prefs.setIntPref('network.proxy.type', 2); Services.prefs.setCharPref('network.proxy.autoconfig_url', arguments[0]);`, [url]);
const pacPort = (url) => { const m = decodeURIComponent(url).match(/SOCKS5 127\.0\.0\.1:(\d+)/); return m ? +m[1] : null; };

async function screenshot(name) {
  const { value } = await mn.command('WebDriver:TakeScreenshot', { full: true });
  fs.writeFileSync(path.join(OUT, `${name}.png`), Buffer.from(value, 'base64'));
}

async function visit(url) {
  const started = Date.now();
  try {
    await mn.command('WebDriver:Navigate', { url });
    return { ok: true, ms: Date.now() - started };
  } catch (error) {
    return { ok: false, ms: Date.now() - started, error: error.message };
  }
}

// ---- 경유 여부를 기록하는 SOCKS5 프록시 ------------------------------------

function startRecordingProxy() {
  const seen = [];
  const clients = new Set();
  const server = net.createServer((client) => {
    clients.add(client);
    client.on('close', () => clients.delete(client));
    client.on('error', () => {});
    client.once('data', () => {
      client.write(Buffer.from([5, 0]));
      client.once('data', (req) => {
        let host;
        let domainName = false;
        let offset;
        if (req[3] === 3) { const n = req[4]; host = req.slice(5, 5 + n).toString(); offset = 5 + n; domainName = true; }
        else if (req[3] === 1) { host = [...req.slice(4, 8)].join('.'); offset = 8; }
        else { client.destroy(); return; }
        const port = req.readUInt16BE(offset);
        seen.push({ host, domainName });
        const upstream = net.connect(port, host, () => {
          client.write(Buffer.from([5, 0, 0, 1, 0, 0, 0, 0, 0, 0]));
          upstream.pipe(client);
          client.pipe(upstream);
        });
        upstream.on('error', () => client.destroy());
      });
    });
  });
  // Firefox 가 기존 터널을 재사용하면 CONNECT 가 새로 오지 않으므로 시험마다 터널을 끊는다
  const reset = () => { seen.length = 0; for (const client of clients) client.destroy(); };
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ port: server.address().port, seen, reset, close: () => server.close() })));
}

// ---- 시나리오 ------------------------------------------------------------

async function openPopup(host) {
  await mn.command('WebDriver:Navigate', { url: `moz-extension://${host}/popup.html` });
  await until(() => inPage(`return document.getElementById('status').textContent !== '확인 중…';`), 15000);
}
async function openOptions(host) {
  await mn.command('WebDriver:Navigate', { url: `moz-extension://${host}/options.html` });
  await until(() => inPage(`return document.getElementById('runtime').textContent !== '확인 중…';`), 15000);
}
async function installExtension(allowPrivateBrowsing) {
  await mn.command('Addon:Install', { path: EXT_DIR, temporary: true, allowPrivateBrowsing });
  return inChrome(`return WebExtensionPolicy.getByID(arguments[0]).mozExtensionHostname;`, [EXT_ID]);
}
async function clickToggleAndWait(host) {
  await openPopup(host);
  const before = await inPage(`return document.getElementById('toggle').getAttribute('aria-checked');`);
  await inPage(`document.getElementById('toggle').click();`);
  await until(() => inPage(`return !document.getElementById('toggle').disabled && !/중…$/.test(document.getElementById('status').textContent);`), 20000);
  return { before, after: await inPage(`return document.getElementById('toggle').getAttribute('aria-checked');`) };
}
const popupText = (id) => inPage(`return document.getElementById(arguments[0]).textContent;`, [id]);

async function saveOptions(host, { scope, include, exclude, strategy, custom }) {
  await openOptions(host);
  await inPage(`
    const [scope, include, exclude, strategy, custom] = arguments;
    if (scope) document.querySelector('input[name="scope"][value="' + scope + '"]').click();
    if (include !== null) document.getElementById('includeDomains').value = include;
    if (exclude !== null) document.getElementById('excludeDomains').value = exclude;
    if (strategy) document.querySelector('input[name="strategy"][value="' + strategy + '"]').click();
    if (custom !== null) document.getElementById('customArgs').value = custom;
    document.getElementById('saved').textContent = '';
    document.querySelector('#form button[type=submit]').click();
  `, [scope || null, include ?? null, exclude ?? null, strategy || null, custom ?? null]);
  await until(() => inPage(`return document.getElementById('saved').textContent !== '' || !document.getElementById('issue').classList.contains('hidden') || !document.getElementById('invalid').classList.contains('hidden');`), 20000);
}

async function routes(proxy, pacUrl) {
  proxy.reset();
  const stamp = Date.now();
  const recordingPac = pacUrl.replace(/127\.0\.0\.1%3A\d+/g, `127.0.0.1%3A${proxy.port}`);
  // 1분마다 도는 감시 알람이 PAC 를 되돌릴 수 있어 접속 직전마다 다시 넣는다
  const visitThroughRecorder = async (url) => {
    await setPacPref(recordingPac);
    await sleep(800);
    return visit(url);
  };
  const a = await visitThroughRecorder(`https://${SITE_A}/?${stamp}`);
  const b = await visitThroughRecorder(`https://${SITE_B}/robots.txt?${stamp}`);
  return {
    loaded: a.ok && b.ok,
    errors: [a.error, b.error].filter(Boolean),
    a: proxy.seen.some((s) => s.host === SITE_A),
    b: proxy.seen.some((s) => s.host === SITE_B),
    remoteDns: proxy.seen.filter((s) => s.host === SITE_A || s.host === SITE_B).every((s) => s.domainName),
  };
}

(async () => {
  console.log(`결과 폴더: ${OUT}`);
  const wasInstalled = ps(`Test-Path '${HOST_KEY}'`) === 'True';
  if (wasInstalled) execFileSync(SETUP, ['--uninstall', '--silent']);
  if (wasInstalled) await sleep(4000);

  const others = otherBackends();
  const profile = path.join(OUT, 'profile');
  const downloads = path.join(OUT, 'downloads');
  fs.rmSync(profile, { recursive: true, force: true });
  fs.rmSync(downloads, { recursive: true, force: true });
  fs.mkdirSync(profile, { recursive: true });
  fs.mkdirSync(downloads, { recursive: true });
  fs.writeFileSync(path.join(profile, 'user.js'), [
    `user_pref("marionette.port",${MARIONETTE_PORT});`,
    `user_pref("browser.shell.checkDefaultBrowser",false);`,
    `user_pref("datareporting.policy.dataSubmissionEnabled",false);`,
    `user_pref("app.update.enabled",false);`,
    `user_pref("browser.download.folderList",2);`,
    `user_pref("browser.download.dir",${JSON.stringify(downloads)});`,
    `user_pref("browser.download.useDownloadDir",true);`,
    `user_pref("browser.download.always_ask_before_handling_new_types",false);`,
  ].join('\n'));

  const recording = await startRecordingProxy();
  const firefox = spawn(FIREFOX, ['-profile', profile, '-no-remote', '-new-instance', '-headless', '-marionette'], {
    stdio: 'ignore',
    env: { ...process.env, MOZ_REMOTE_ALLOW_SYSTEM_ACCESS: '1' },
  });
  mn = new Marionette();

  try {
    await mn.connect();
    await mn.command('WebDriver:NewSession', {});
    await mn.command('WebDriver:SetTimeouts', { pageLoad: 25000, script: 30000 });

    section('도우미 없이 켜기: 인터넷을 막지 않아야 한다');
    let host = await installExtension(true);
    let toggled = await clickToggleAndWait(host);
    check('토글이 꺼진 상태로 돌아옴', toggled.after === 'false', toggled);
    check('미설치 안내 표시', /설치되어 있지 않습니다/.test(await popupText('issue')), await popupText('issue'));
    check('프록시 미적용', (await proxyPrefs()).type !== 2, await proxyPrefs());
    check('인터넷 정상', (await visit(`https://${SITE_A}/`)).ok);
    await openPopup(host);
    await screenshot('popup-setup');

    section('내장 설치 파일 받기와 실행');
    await openOptions(host);
    await screenshot('options-setup');
    const link = await mn.command('WebDriver:FindElement', { using: 'css selector', value: '#download' });
    await mn.command('WebDriver:ElementClick', { id: Object.values(link.value)[0] });
    const downloaded = path.join(downloads, 'GoodbyeDPI-Firefox-Setup.exe');
    await until(() => fs.existsSync(downloaded) && fs.statSync(downloaded).size === fs.statSync(SETUP).size, 20000);
    const gotFile = fs.existsSync(downloaded);
    check('확장 패키지에서 파일을 받음', gotFile);
    check('내용이 내장 파일과 같음', gotFile && sha256(downloaded) === sha256(SETUP));
    execFileSync(gotFile ? downloaded : SETUP, ['--silent']);
    check('레지스트리 등록', ps(`Test-Path '${HOST_KEY}'`) === 'True');
    check('ciadpi 추출', fs.existsSync(BACKEND) && sha256(BACKEND) === sha256(path.join(ROOT, 'vendor', 'byedpi', 'ciadpi.exe')));
    check('라이선스 동봉', fs.existsSync(path.join(INSTALL_DIR, 'LICENSE-ByeDPI.txt')));
    const detected = await until(() => inPage(`return document.getElementById('setup').classList.contains('hidden');`), 10000);
    check('설정 화면이 설치를 자동 감지', detected);

    section('켜기: 자동 포트');
    toggled = await clickToggleAndWait(host);
    check('토글이 켜짐', toggled.after === 'true', toggled);
    const status = await popupText('status');
    check('상태에 포트 표시', /포트 \d+/.test(status), status);
    await screenshot('popup-on');
    let prefs = await proxyPrefs();
    const firstPort = pacPort(prefs.url);
    check('PAC 프록시 적용', prefs.type === 2 && !!firstPort, firstPort);
    check('고정 포트가 아님', firstPort !== 1080);
    check('PAC 에 직접 연결 폴백', decodeURIComponent(prefs.url).includes(`SOCKS5 127.0.0.1:${firstPort}; DIRECT`));
    let backend = ourBackend();
    check('ciadpi 1개 실행', backend.length === 1 && backend[0].cmd.includes(`-p ${firstPort}`), backend);
    await sleep(3000);
    check('호스트 종료 후에도 ciadpi 유지', ourBackend().length === 1);
    const live = await visit(`https://${SITE_B}/robots.txt?live`);
    check('사이트 접속', live.ok, live);
    check('트래픽이 ciadpi 를 경유', outboundConnections(backend[0].pid) > 0);
    check('Chrome 의 ciadpi 는 그대로', JSON.stringify(otherBackends()) === JSON.stringify(others), others);

    section('ciadpi 강제 종료: 인터넷이 끊기지 않고 자동 복구');
    ps(`Stop-Process -Id ${backend[0].pid} -Force`);
    const killedAt = Date.now();
    await sleep(500);
    const failover = await visit(`https://${SITE_A}/?failover`);
    check('종료 직후에도 사이트 접속', failover.ok, failover);
    const nextPage = await visit(`https://${SITE_B}/robots.txt?failover`);
    check('다음 접속은 지연 없음', nextPage.ok && nextPage.ms < 5000, nextPage);
    const recovered = await until(async () => {
      const b = ourBackend();
      const p = await proxyPrefs();
      return b.length === 1 && pacPort(p.url) !== firstPort && b[0].cmd.includes(`-p ${pacPort(p.url)}`) ? b[0] : null;
    }, 75000, 1000);
    check('감시 알람이 새 포트로 복구', !!recovered, recovered ? `${Math.round((Date.now() - killedAt) / 1000)}초, 포트 ${pacPort((await proxyPrefs()).url)}` : '');
    if (recovered) {
      const after = await visit('https://www.wikipedia.org/robots.txt?recovered');
      check('복구 후 다시 ciadpi 경유', after.ok && outboundConnections(recovered.pid) > 0, after);
    }

    section('적용 범위 3가지: 실제 라우팅');
    await saveOptions(host, { scope: 'include', include: `https://${SITE_A}/path\nbad domain` });
    check('잘못된 도메인은 저장을 막음', /bad domain/.test(await popupText('invalid')), await popupText('invalid'));
    await saveOptions(host, { scope: 'include', include: `https://${SITE_A}/path` });
    await screenshot('options-include');
    let route = await routes(recording, (await proxyPrefs()).url);
    check('특정 사이트만: 목록만 경유', route.loaded && route.a && !route.b, route);
    check('프록시가 DNS 를 처리', route.remoteDns);

    await saveOptions(host, { scope: 'exclude', exclude: SITE_A });
    await screenshot('options-exclude');
    route = await routes(recording, (await proxyPrefs()).url);
    check('특정 사이트 제외: 목록만 직접 연결', route.loaded && !route.a && route.b, route);

    await saveOptions(host, { scope: 'all' });
    await openPopup(host);
    await screenshot('popup-all');
    route = await routes(recording, (await proxyPrefs()).url);
    check('전체: 모두 경유', route.loaded && route.a && route.b, route);

    await saveOptions(host, {});
    await openPopup(host);
    await inPage(`document.querySelector('input[name="scope"][value="exclude"]').click();`);
    await until(async () => decodeURIComponent((await proxyPrefs()).url).includes(SITE_A), 10000);
    check('팝업에서 범위를 바꾸면 바로 적용', decodeURIComponent((await proxyPrefs()).url).includes(SITE_A));
    await inPage(`document.querySelector('input[name="scope"][value="all"]').click();`);
    await sleep(1000);

    section('우회 전략');
    for (const strategy of ['light', 'strong', 'recommended']) {
      await saveOptions(host, { strategy });
      const running = ourBackend();
      prefs = await proxyPrefs();
      const issueHidden = await inPage(`return document.getElementById('issue').classList.contains('hidden');`);
      check(`${strategy} 전략으로 실행`, running.length === 1 && running[0].cmd.includes(`-p ${pacPort(prefs.url)}`) && issueHidden, running[0] && running[0].cmd.replace(/^.*ciadpi\.exe"/, ''));
    }
    await saveOptions(host, { strategy: 'custom', custom: '-p 1234 -s 1' });
    check('포트 인수는 거부', /올바르지 않습니다/.test(await popupText('issue')), await popupText('issue'));
    prefs = await proxyPrefs();
    check('거부되면 프록시를 걷어 냄', prefs.type !== 2, prefs);
    await until(() => ourBackend().length === 0, 5000);
    check('거부되면 ciadpi 도 종료', ourBackend().length === 0);
    await saveOptions(host, { strategy: 'custom', custom: '--definitely-not-an-option' });
    toggled = await clickToggleAndWait(host);
    check('ciadpi 가 거부한 인수면 켜지지 않음', toggled.after === 'false', await popupText('issue'));
    check('이때도 프록시 미적용', (await proxyPrefs()).type !== 2);
    await saveOptions(host, { strategy: 'recommended' });

    section('켜기 / 끄기');
    toggled = await clickToggleAndWait(host);
    check('켜짐', toggled.after === 'true', toggled);
    toggled = await clickToggleAndWait(host);
    check('꺼짐', toggled.after === 'false', toggled);
    await until(() => ourBackend().length === 0, 5000);
    check('끄면 ciadpi 종료', ourBackend().length === 0);
    check('끄면 프록시 해제', (await proxyPrefs()).type !== 2, await proxyPrefs());
    await screenshot('popup-off');
    toggled = await clickToggleAndWait(host);
    check('다시 켜짐', toggled.after === 'true');

    section('확장 제거: Firefox 설정이 되돌아감');
    await mn.command('WebDriver:Navigate', { url: 'about:blank' });
    await mn.command('Addon:Uninstall', { id: EXT_ID });
    await sleep(1000);
    check('프록시 해제', (await proxyPrefs()).type !== 2, await proxyPrefs());
    check('인터넷 정상', (await visit(`https://${SITE_A}/?removed`)).ok);

    section('사생활 보호 창 권한 없음');
    host = await installExtension(false);
    toggled = await clickToggleAndWait(host);
    check('켜지지 않음', toggled.after === 'false', toggled);
    check('권한 안내 표시', /사생활 보호/.test(await popupText('issue')), await popupText('issue'));
    await screenshot('popup-no-private');
    await openOptions(host);
    await screenshot('options-no-private');
    check('프록시 미적용', (await proxyPrefs()).type !== 2);
    await mn.command('WebDriver:Navigate', { url: 'about:blank' });
    await mn.command('Addon:Uninstall', { id: EXT_ID });

    await mn.command('Marionette:Quit', {}).catch(() => {});
  } catch (error) {
    check('테스트 실행', false, error.stack);
  }

  recording.close();
  setTimeout(() => { try { firefox.kill(); } catch {} }, 3000);
  await sleep(4000);

  section('도우미 제거');
  execFileSync(SETUP, ['--uninstall', '--silent']);
  await until(() => !fs.existsSync(INSTALL_DIR), 10000, 500);
  check('프로세스 정리', ourBackend().length === 0);
  check('레지스트리 정리', ps(`Test-Path '${HOST_KEY}'`) === 'False');
  check('설치 폴더 삭제', !fs.existsSync(INSTALL_DIR));
  check('Chrome 의 ciadpi 는 그대로', JSON.stringify(otherBackends()) === JSON.stringify(others), otherBackends());
  if (wasInstalled) execFileSync(SETUP, ['--silent']);

  console.log(`\n${failures ? `실패 ${failures}건` : '모두 통과'}`);
  process.exit(failures ? 1 : 0);
})();
