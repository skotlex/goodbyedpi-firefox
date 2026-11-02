'use strict';
const test = require('node:test');
const assert = require('node:assert');
const vm = require('node:vm');
const { normalizeDomain, parseDomainList, buildPac, strategyArgs, STRATEGIES } = require('../src/scope.js');

// Firefox 가 PAC 에 제공하는 함수만 넣어 실제 스크립트를 평가한다
function route(pac, host) {
  const context = vm.createContext({
    isPlainHostName: (h) => !h.includes('.'),
    dnsDomainIs: (h, d) => h.endsWith(d),
  });
  vm.runInContext(pac, context);
  return context.FindProxyForURL(`https://${host}/`, host);
}

const PROXY = 'SOCKS5 127.0.0.1:5000; DIRECT';

test('전체 적용은 모든 공개 사이트를 프록시로 보내고 실패 시 직접 연결로 넘어간다', () => {
  const pac = buildPac(5000, 'all', ['ignored.com']);
  assert.strictEqual(route(pac, 'youtube.com'), PROXY);
  assert.strictEqual(route(pac, 'ignored.com'), PROXY);
});

test('특정 사이트만 적용은 목록과 하위 도메인만 프록시로 보낸다', () => {
  const pac = buildPac(5000, 'include', ['youtube.com']);
  assert.strictEqual(route(pac, 'youtube.com'), PROXY);
  assert.strictEqual(route(pac, 'www.youtube.com'), PROXY);
  assert.strictEqual(route(pac, 'notyoutube.com'), 'DIRECT');
  assert.strictEqual(route(pac, 'naver.com'), 'DIRECT');
});

test('특정 사이트 제외는 목록과 하위 도메인만 직접 연결한다', () => {
  const pac = buildPac(5000, 'exclude', ['naver.com']);
  assert.strictEqual(route(pac, 'naver.com'), 'DIRECT');
  assert.strictEqual(route(pac, 'mail.naver.com'), 'DIRECT');
  assert.strictEqual(route(pac, 'notnaver.com'), PROXY);
  assert.strictEqual(route(pac, 'youtube.com'), PROXY);
});

test('로컬 주소는 어떤 범위에서도 프록시로 보내지 않는다', () => {
  for (const scope of ['all', 'exclude']) {
    const pac = buildPac(5000, scope, []);
    for (const host of ['localhost', 'intranet', '127.0.0.1', '10.1.2.3', '192.168.0.1', '172.16.0.1', '172.31.255.1', '169.254.1.1', 'nas.local', '::1', '[::1]']) {
      assert.strictEqual(route(pac, host), 'DIRECT', host);
    }
    assert.strictEqual(route(pac, '172.32.0.1'), PROXY);
  }
});

test('도메인 입력은 주소를 붙여 넣어도 호스트 이름으로 정리한다', () => {
  assert.strictEqual(normalizeDomain('  YouTube.com '), 'youtube.com');
  assert.strictEqual(normalizeDomain('https://www.youtube.com:443/watch?v=1'), 'www.youtube.com');
  assert.strictEqual(normalizeDomain('*.googlevideo.com'), 'googlevideo.com');
  assert.strictEqual(normalizeDomain('.example.org.'), 'example.org');
  assert.strictEqual(normalizeDomain('한글.kr'), 'xn--bj0bj06e.kr');
});

test('도메인으로 쓸 수 없는 입력은 거른다', () => {
  for (const bad of ['', 'localhost', 'not a domain', 'a"];alert(1);//.com', '[::1]']) {
    assert.strictEqual(normalizeDomain(bad), null, bad);
  }
});

test('목록 입력은 중복을 없애고 잘못된 줄을 따로 돌려준다', () => {
  const { domains, invalid } = parseDomainList('a.com\nA.com\r\n\n  b.org, c.net\nnot a domain');
  assert.deepStrictEqual(domains, ['a.com', 'b.org', 'c.net']);
  assert.deepStrictEqual(invalid, ['not a domain']);
});

test('전략은 프리셋 또는 직접 입력한 인수로 결정된다', () => {
  assert.strictEqual(strategyArgs({ strategy: 'light', customArgs: 'x' }), STRATEGIES.light.args);
  assert.strictEqual(strategyArgs({ strategy: 'custom', customArgs: '-s 2' }), '-s 2');
  assert.strictEqual(strategyArgs({ strategy: 'unknown', customArgs: '' }), STRATEGIES.recommended.args);
});
