'use strict';

const $ = (id) => document.getElementById(id);
const toggle = $('toggle');

function send(type, payload) {
  return browser.runtime.sendMessage({ type, ...payload });
}

function scopeHint(settings) {
  if (settings.scope === 'all') return '모든 사이트에 우회를 적용합니다.';
  if (settings.scope === 'include') {
    const count = settings.includeDomains.length;
    return count ? `목록의 ${count}개 사이트에만 적용합니다.` : '목록이 비어 있어 우회되는 사이트가 없습니다.';
  }
  const count = settings.excludeDomains.length;
  return count ? `목록의 ${count}개 사이트를 뺀 나머지에 적용합니다.` : '목록이 비어 있어 모든 사이트에 적용합니다.';
}

function statusText(state) {
  if (!state.settings.enabled) return '꺼져 있습니다.';
  return state.running ? `우회 동작 중 · 포트 ${state.port}` : '다시 연결하는 중…';
}

function render(state) {
  const { settings } = state;
  toggle.setAttribute('aria-checked', String(settings.enabled));
  toggle.disabled = false;
  $('status').textContent = statusText(state);

  const issue = settings.issue;
  $('issue').classList.toggle('hidden', !issue);
  if (issue) $('issue').textContent = issue.detail ? `${issue.message} (${issue.detail})` : issue.message;

  $('setup').classList.toggle('hidden', state.privateAllowed && state.helperReady);

  for (const radio of document.querySelectorAll('input[name="scope"]')) {
    radio.checked = radio.value === settings.scope;
  }
  $('scopeHint').textContent = scopeHint(settings);
}

toggle.addEventListener('click', async () => {
  const value = toggle.getAttribute('aria-checked') !== 'true';
  toggle.disabled = true;
  $('status').textContent = value ? '켜는 중…' : '끄는 중…';
  render(await send('setEnabled', { value }));
});

for (const radio of document.querySelectorAll('input[name="scope"]')) {
  radio.addEventListener('change', async () => {
    render(await send('saveSettings', { patch: { scope: radio.value } }));
  });
}

function openOptions(event) {
  event.preventDefault();
  browser.runtime.openOptionsPage();
  window.close();
}

$('openOptions').addEventListener('click', openOptions);
$('openSetup').addEventListener('click', openOptions);

send('getState').then(render);
