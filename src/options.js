'use strict';

const $ = (id) => document.getElementById(id);
// 준비 단계가 남아 있는 동안 도우미 설치를 감지하는 주기
const SETUP_POLL_MS = 2000;
const SETUP_PATH = 'native/GoodbyeDPI-Firefox-Setup.exe';

function send(type, payload) {
  return browser.runtime.sendMessage({ type, ...payload });
}

function buildStrategyChoices() {
  const entries = [...Object.entries(STRATEGIES).map(([id, s]) => [id, s.label]), ['custom', '직접 입력']];
  for (const [id, label] of entries) {
    const option = document.createElement('label');
    const radio = document.createElement('input');
    radio.type = 'radio';
    radio.name = 'strategy';
    radio.value = id;
    radio.addEventListener('change', syncVisibility);
    option.append(radio, label);
    $('strategies').append(option);
  }
}

function selected(name) {
  const radio = document.querySelector(`input[name="${name}"]:checked`);
  return radio ? radio.value : '';
}

function select(name, value) {
  for (const radio of document.querySelectorAll(`input[name="${name}"]`)) {
    radio.checked = radio.value === value;
  }
}

function syncVisibility() {
  const scope = selected('scope');
  $('scopeAll').classList.toggle('hidden', scope !== 'all');
  $('includeBox').classList.toggle('hidden', scope !== 'include');
  $('excludeBox').classList.toggle('hidden', scope !== 'exclude');
  $('customArgs').classList.toggle('hidden', selected('strategy') !== 'custom');
}

function fillForm({ settings }) {
  select('scope', settings.scope);
  select('strategy', settings.strategy);
  $('includeDomains').value = settings.includeDomains.join('\n');
  $('excludeDomains').value = settings.excludeDomains.join('\n');
  $('customArgs').value = settings.customArgs;
  syncVisibility();
}

function markStep(id, done, doneText) {
  $(id).classList.toggle('done', done);
  $(id).querySelector('.step-state').textContent = done ? doneText : '';
}

function renderStatus(state) {
  const ready = state.privateAllowed && state.helperReady;
  $('setup').classList.toggle('hidden', ready);
  markStep('stepPrivate', state.privateAllowed, '허용됨');
  markStep('stepHelper', state.helperReady, '설치됨');

  const { enabled, issue } = state.settings;
  if (!enabled) $('runtime').textContent = '꺼져 있습니다.';
  else $('runtime').textContent = state.running ? `우회 동작 중 · 포트 ${state.port}` : '다시 연결하는 중…';

  $('issue').classList.toggle('hidden', !issue);
  if (issue) $('issue').textContent = issue.detail ? `${issue.message} (${issue.detail})` : issue.message;
  return ready;
}

async function refresh() {
  const ready = renderStatus(await send('getState'));
  if (!ready) setTimeout(refresh, SETUP_POLL_MS);
}

for (const radio of document.querySelectorAll('input[name="scope"]')) {
  radio.addEventListener('change', syncVisibility);
}

// .exe 를 직접 링크하면 Firefox 가 열기/저장 대화 상자를 띄우므로 Blob 으로 바꿔 바로 내려받게 한다
$('download').addEventListener('click', async () => {
  const response = await fetch(browser.runtime.getURL(SETUP_PATH));
  const url = URL.createObjectURL(new Blob([await response.arrayBuffer()], { type: 'application/octet-stream' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = SETUP_PATH.split('/').pop();
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 60000);
});

$('form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const include = parseDomainList($('includeDomains').value);
  const exclude = parseDomainList($('excludeDomains').value);
  const invalid = [...include.invalid, ...exclude.invalid];
  $('invalid').classList.toggle('hidden', !invalid.length);
  $('invalid').textContent = invalid.length ? `도메인으로 인식하지 못해 저장하지 않았습니다: ${invalid.join(', ')}` : '';
  if (invalid.length) return;

  const state = await send('saveSettings', {
    patch: {
      scope: selected('scope'),
      includeDomains: include.domains,
      excludeDomains: exclude.domains,
      strategy: selected('strategy'),
      customArgs: $('customArgs').value.trim(),
    },
  });
  fillForm(state);
  renderStatus(state);
  $('saved').textContent = state.settings.issue ? '' : '저장했습니다.';
  setTimeout(() => { $('saved').textContent = ''; }, 2500);
});

buildStrategyChoices();
send('getState').then((state) => {
  fillForm(state);
  if (!renderStatus(state)) setTimeout(refresh, SETUP_POLL_MS);
});
