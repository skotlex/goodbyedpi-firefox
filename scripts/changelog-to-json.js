#!/usr/bin/env node
'use strict';
// CHANGELOG.md (Keep a Changelog 형식) → release-notes.json 변환 + 버전 동기화
// 영문/한글 섹션명 모두 인식 (### Added, ### 새로운 기능 등).
//
// 사용법
//   node changelog-to-json.js                    변환만 (버전 그대로)
//   node changelog-to-json.js --release          [Unreleased] → 다음 patch 로 확정 후 변환 (커밋 때 .githooks/pre-commit 이 호출)
//   node changelog-to-json.js --release --minor  minor 올림 (major 도 동일)

const fs   = require('fs');
const path = require('path');
const VERSION_FILES = require('./version-files');

const argv    = process.argv.slice(2);
const doRelease = argv.includes('--release');
const bumpLevel = argv.includes('--major') ? 'major' : argv.includes('--minor') ? 'minor' : 'patch';

const rootDir    = path.join(__dirname, '..');
const inputPath  = path.join(rootDir, 'CHANGELOG.md');
const outputPath = path.join(rootDir, 'release-notes.json');

if (!fs.existsSync(inputPath)) {
  console.warn(`[changelog-to-json] CHANGELOG.md 없음 — 빈 release-notes.json 생성`);
  fs.writeFileSync(outputPath, '{}', 'utf8');
  process.exit(0);
}

let md = fs.readFileSync(inputPath, 'utf8');

// ── 릴리스 승격 ────────────────────────────────────────────────────────────
// 수정할 때마다 버전이 하나씩 오른다. [Unreleased] 블록에 항목이 있으면 '직전 릴리스 + 1' 버전으로 확정하고
// 위에 빈 [Unreleased] 블록을 다시 둔다. 항목이 없으면 아무것도 하지 않는다.
// → 사람이 버전 숫자를 손댈 일이 없다.
function promoteUnreleased(text, level) {
  const nl = /\r\n/.test(text) ? '\r\n' : '\n';
  // CRLF 파일에서 헤더 줄의 \r 까지 먹으면 교체한 줄만 LF 로 남는다 — \r 은 매칭에서 제외
  const head = text.match(/^##\s*\[Unreleased\][^\r\n]*$/im);
  if (!head) {
    console.log('[changelog-to-json]   [Unreleased] 블록 없음 — 승격 생략');
    return null;
  }
  const rest    = text.slice(head.index + head[0].length);
  const nextIdx = rest.search(/^##\s*\[/m);
  const body    = nextIdx === -1 ? rest : rest.slice(0, nextIdx);
  if (!/^[-*]\s+\S/m.test(body)) {
    console.log('[changelog-to-json]   [Unreleased] 에 항목 없음 — 버전 유지');
    return null;
  }

  const d = new Date();
  const date = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

  // 직전 릴리스 버전 (Unreleased 바로 다음 버전 블록). 첫 릴리스면 0.0.0 기준으로 채번
  const after = nextIdx === -1 ? '' : rest.slice(nextIdx);
  const prev  = after.match(/^##\s*\[(\d+)\.(\d+)\.(\d+)\]/m);

  let [maj, min, pat] = prev ? [+prev[1], +prev[2], +prev[3]] : [0, 0, 0];
  if      (level === 'major') { maj++; min = 0; pat = 0; }
  else if (level === 'minor') { min++; pat = 0; }
  else                        { pat++; }

  const version = `${maj}.${min}.${pat}`;
  const replaced = `## [Unreleased]${nl}${nl}## [${version}] - ${date}`;
  const out = text.slice(0, head.index) + replaced + text.slice(head.index + head[0].length);
  fs.writeFileSync(inputPath, out, 'utf8');
  console.log(`[changelog-to-json] ✓ 릴리스 확정 — [Unreleased] → [${version}] (${date}, ${level})`);
  return out;
}

if (doRelease) {
  const promoted = promoteUnreleased(md, bumpLevel);
  if (promoted) md = promoted;
}

const result = {};
let latestVersion = null;   // CHANGELOG 최상단의 (Unreleased 제외) 첫 버전 — 버전 동기화용

// 버전 블록 분리: ## [버전] - 날짜
const blocks = md.split(/(?=^##\s*\[)/m).slice(1);

for (const block of blocks) {
  const headerMatch = block.match(/^##\s*\[([^\]]+)\]\s*-?\s*(\S*)/);
  if (!headerMatch) continue;
  const version = headerMatch[1].trim();
  const date    = (headerMatch[2] || '').trim();
  if (!version || version.toLowerCase() === 'unreleased') continue;
  if (!latestVersion) latestVersion = version;

  const sections = [];
  let curSection = null;
  const lines = block.split('\n').slice(1); // 헤더 제외
  for (const line of lines) {
    const sectMatch = line.match(/^###\s+(.+)/);
    if (sectMatch) {
      if (curSection && curSection.items.length) sections.push(curSection);
      const title = sectMatch[1].trim();
      curSection = { icon: iconFor(title), title, items: [] };
      continue;
    }
    const itemMatch = line.match(/^[-*]\s+(.+)/);
    if (itemMatch && curSection) curSection.items.push(itemMatch[1].trim());
  }
  if (curSection && curSection.items.length) sections.push(curSection);

  if (sections.length) {
    result[version] = { version, date, sections };
  }
}

function iconFor(title) {
  const t = title.toLowerCase();
  if (/added|new|기능|추가|새/.test(t))                  return '✨';
  if (/fixed|fix|버그|수정/.test(t))                     return '🐛';
  if (/changed|change|improved|improve|개선|변경/.test(t)) return '🔧';
  if (/removed|remove|삭제|제거/.test(t))                return '🗑';
  if (/security|보안/.test(t))                           return '🔒';
  if (/deprecated|폐기/.test(t))                         return '⚠';
  return '•';
}

fs.writeFileSync(outputPath, JSON.stringify(result, null, 2), 'utf8');
console.log(`[changelog-to-json] ✓ ${path.basename(outputPath)} 생성 — ${Object.keys(result).length}개 버전`);

// CHANGELOG 최상단 버전을 package.json·manifest.json 의 version 으로 동기화 — 아직 없는 파일은 건너뛴다
if (latestVersion) {
  for (const file of VERSION_FILES) {
    const filePath = path.join(rootDir, file);
    if (!fs.existsSync(filePath)) continue;
    const raw = fs.readFileSync(filePath, 'utf8');
    const json = JSON.parse(raw);
    if (json.version === latestVersion) {
      console.log(`[changelog-to-json]   ${file} version 변경 없음 (${latestVersion})`);
      continue;
    }
    const prev = json.version;
    json.version = latestVersion;
    // 원본 파일의 트레일링 newline 유지
    const trailingNl = /\n$/.test(raw) ? '\n' : '';
    fs.writeFileSync(filePath, JSON.stringify(json, null, 2) + trailingNl, 'utf8');
    console.log(`[changelog-to-json] ✓ ${file} version ${prev} → ${latestVersion}`);
  }
}
