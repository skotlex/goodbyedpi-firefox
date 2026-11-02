'use strict';
// 토글 상태에 맞춰 도우미(ciadpi)와 Firefox 프록시 설정을 맞추고, 1분마다 이상 여부를 확인한다.
// 어떤 실패에서도 프록시를 걷어 내고 꺼진 상태로 돌아가 인터넷을 막지 않는 것을 원칙으로 한다.

const HOST_NAME = 'com.goodbyedpi.firefox';
// native-host/Host.cs 의 Protocol 과 짝을 이룬다
const HOST_PROTOCOL = 1;
const HOST_TIMEOUT_MS = 15000;
const WATCHDOG_ALARM = 'watchdog';

const ISSUE_MESSAGES = {
  'private-permission': '사생활 보호 창 실행 권한을 허용해야 켤 수 있습니다.',
  'host-missing': '도우미 프로그램이 설치되어 있지 않습니다.',
  'host-outdated': '도우미 프로그램이 오래되었습니다. 다시 설치해 주세요.',
  'host-timeout': '도우미 프로그램이 응답하지 않습니다.',
  'host-error': '도우미 프로그램에서 오류가 발생했습니다.',
  'proxy-conflict': '다른 확장 프로그램이 프록시 설정을 사용 중입니다.',
  'proxy-failed': '프록시 설정을 적용하지 못했습니다.',
};

async function getSettings() {
  return browser.storage.local.get({ ...SETTINGS_DEFAULTS, issue: null });
}

function issue(reason, detail) {
  return { ok: false, reason, message: ISSUE_MESSAGES[reason], detail: detail || '' };
}

// 토글·알람·브라우저 시작이 겹쳐도 상태를 어긋나게 만들지 않도록 한 번에 하나씩 처리한다
let queue = Promise.resolve();
function serial(task) {
  const run = queue.then(() => task());
  queue = run.catch(() => {});
  return run;
}

// ---- 도우미 -------------------------------------------------------------

async function callHost(message) {
  let timer;
  const timeout = new Promise((resolve) => {
    timer = setTimeout(() => resolve(issue('host-timeout')), HOST_TIMEOUT_MS);
  });
  try {
    const reply = await Promise.race([browser.runtime.sendNativeMessage(HOST_NAME, message), timeout]);
    if (reply.reason === 'host-timeout') return reply;
    if (reply.protocol !== HOST_PROTOCOL) return issue('host-outdated');
    return reply.ok ? reply : issue('host-error', reply.error);
  } catch (error) {
    const text = String((error && error.message) || error);
    return /no such native application/i.test(text) ? issue('host-missing') : issue('host-error', text);
  } finally {
    clearTimeout(timer);
  }
}

// ---- 프록시 -------------------------------------------------------------

async function applyProxy(port, settings) {
  const url = pacDataUrl(port, settings.scope, domainsForScope(settings));
  const current = await browser.proxy.settings.get({});
  if (current.levelOfControl === 'controlled_by_other_extensions') return issue('proxy-conflict');
  // 같은 설정을 다시 넣으면 PAC 를 불필요하게 새로 읽으므로 건너뛴다
  if (current.levelOfControl === 'controlled_by_this_extension' && current.value.autoConfigUrl === url) return { ok: true };
  try {
    await browser.proxy.settings.set({ value: { proxyType: 'autoConfig', autoConfigUrl: url, proxyDNS: true } });
    return { ok: true };
  } catch (error) {
    return issue('proxy-failed', String((error && error.message) || error));
  }
}

async function clearProxy() {
  try {
    await browser.proxy.settings.clear({});
  } catch {
    // 권한이 회수된 경우 Firefox 가 이미 설정을 되돌렸다
  }
}

// ---- 상태 전환 ----------------------------------------------------------

function showBadge(settings) {
  const text = settings.issue ? '!' : settings.enabled ? 'ON' : '';
  browser.action.setBadgeText({ text });
  browser.action.setBadgeBackgroundColor({ color: settings.issue ? '#c5362b' : '#0a7d6c' });
}

async function saveAndShow(patch) {
  await browser.storage.local.set(patch);
  showBadge(await getSettings());
}

// 켜진 상태를 실제와 맞춘다. 도우미의 start 는 멱등이라 정상이면 그대로, 죽었으면 새 포트로 다시 띄운다.
async function reconcile() {
  const settings = await getSettings();
  if (!settings.enabled) return { ok: true };

  let result;
  if (!(await browser.extension.isAllowedIncognitoAccess())) {
    result = issue('private-permission');
  } else {
    const backend = await callHost({ cmd: 'start', args: strategyArgs(settings) });
    result = backend.ok ? await applyProxy(backend.port, settings) : backend;
  }

  if (!result.ok) {
    await clearProxy();
    await browser.alarms.clear(WATCHDOG_ALARM);
    await saveAndShow({ enabled: false, issue: result });
    await callHost({ cmd: 'stop' });
    return result;
  }
  await browser.alarms.create(WATCHDOG_ALARM, { periodInMinutes: 1 });
  await saveAndShow({ issue: null });
  return result;
}

async function turnOff() {
  // 도우미가 망가져 있어도 끄기는 항상 성공해야 하므로 프록시부터 걷어 낸다
  await clearProxy();
  await browser.alarms.clear(WATCHDOG_ALARM);
  await saveAndShow({ enabled: false, issue: null });
  await callHost({ cmd: 'stop' });
}

async function readState() {
  const settings = await getSettings();
  const [privateAllowed, helper] = await Promise.all([
    browser.extension.isAllowedIncognitoAccess(),
    callHost({ cmd: 'status' }),
  ]);
  return {
    settings,
    privateAllowed,
    helperReady: helper.ok || !['host-missing', 'host-outdated'].includes(helper.reason),
    running: !!helper.running,
    port: helper.running ? helper.port : null,
  };
}

// ---- 이벤트 -------------------------------------------------------------

const HANDLERS = {
  async getState() {
    await reconcile();
    return readState();
  },
  async setEnabled({ value }) {
    if (value) {
      await browser.storage.local.set({ enabled: true });
      await reconcile();
    } else {
      await turnOff();
    }
    return readState();
  },
  async saveSettings({ patch }) {
    await browser.storage.local.set(patch);
    await reconcile();
    return readState();
  },
};

browser.runtime.onMessage.addListener((message) => {
  const handler = HANDLERS[message && message.type];
  return handler ? serial(() => handler(message)) : undefined;
});

browser.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === WATCHDOG_ALARM) serial(reconcile);
});

browser.runtime.onStartup.addListener(() => serial(reconcile));

browser.runtime.onInstalled.addListener(({ reason }) => {
  serial(reconcile);
  if (reason === 'install') browser.runtime.openOptionsPage();
});
