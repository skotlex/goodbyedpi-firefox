'use strict';
// 적용 범위와 우회 전략 정의, 그리고 이를 PAC 스크립트로 바꾸는 순수 함수 모음.
// background 와 설정 화면이 함께 쓰고, 테스트는 Node 에서 불러온다.

const SETTINGS_DEFAULTS = {
  enabled: false,
  scope: 'all',            // all: 전체, include: 특정 사이트만 적용, exclude: 특정 사이트만 제외
  includeDomains: [],
  excludeDomains: [],
  strategy: 'recommended',
  customArgs: '',
};

const STRATEGIES = {
  recommended: { label: '권장', args: '-s 1 -d 3+s --mod-http=h,d --auto=torst -r 1+s' },
  light:       { label: '가벼움', args: '-s 1 -r 1+s' },
  strong:      { label: '강력', args: '-d 1 -f 0 --ttl 1 --auto=torst -r 1+s' },
};

function strategyArgs(settings) {
  if (settings.strategy === 'custom') return settings.customArgs;
  return (STRATEGIES[settings.strategy] || STRATEGIES.recommended).args;
}

function domainsForScope(settings) {
  if (settings.scope === 'include') return settings.includeDomains;
  if (settings.scope === 'exclude') return settings.excludeDomains;
  return [];
}

// 사용자가 붙여 넣은 주소를 호스트 이름으로 정리한다. 쓸 수 없는 값이면 null 을 돌려준다.
function normalizeDomain(raw) {
  const text = String(raw).trim().replace(/^\*\./, '').replace(/^\./, '');
  if (!text) return null;
  let host;
  try {
    host = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(text) ? text : `http://${text}`).hostname;
  } catch {
    return null;
  }
  host = host.replace(/\.$/, '');
  return /^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(host) ? host : null;
}

function parseDomainList(text) {
  const domains = [];
  const invalid = [];
  for (const line of String(text).split(/[\r\n,]+/)) {
    if (!line.trim()) continue;
    const domain = normalizeDomain(line);
    if (!domain) invalid.push(line.trim());
    else if (!domains.includes(domain)) domains.push(domain);
  }
  return { domains, invalid };
}

// 모든 범위가 'SOCKS5 ...; DIRECT' 를 쓴다. ciadpi 가 죽어도 브라우저가 직접 연결로 넘어가
// 인터넷이 끊기지 않게 하는 안전장치이며, 확장이 잠들어 있어도 PAC 자체로 동작한다.
function buildPac(port, scope, domains) {
  const proxied = `SOCKS5 127.0.0.1:${Number(port)}; DIRECT`;
  const whenListed = scope === 'exclude' ? 'DIRECT' : proxied;
  const otherwise = scope === 'include' ? 'DIRECT' : proxied;
  return [
    'function FindProxyForURL(url, host) {',
    '  host = host.toLowerCase();',
    '  if (isPlainHostName(host) || host === "localhost" || host === "::1" || host === "[::1]") return "DIRECT";',
    '  if (/\\.(local|localhost)$/.test(host)) return "DIRECT";',
    '  if (/^(127\\.|10\\.|192\\.168\\.|169\\.254\\.|172\\.(1[6-9]|2\\d|3[01])\\.)/.test(host)) return "DIRECT";',
    `  var domains = ${JSON.stringify(scope === 'all' ? [] : domains)};`,
    '  for (var i = 0; i < domains.length; i++) {',
    `    if (host === domains[i] || dnsDomainIs(host, "." + domains[i])) return ${JSON.stringify(whenListed)};`,
    '  }',
    `  return ${JSON.stringify(otherwise)};`,
    '}',
  ].join('\n');
}

function pacDataUrl(port, scope, domains) {
  return 'data:application/x-ns-proxy-autoconfig,' + encodeURIComponent(buildPac(port, scope, domains));
}

if (typeof module !== 'undefined') {
  module.exports = { SETTINGS_DEFAULTS, STRATEGIES, strategyArgs, domainsForScope, normalizeDomain, parseDomainList, buildPac, pacDataUrl };
}
