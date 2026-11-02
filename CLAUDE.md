# goodbyedpi-firefox

Firefox 플러그인. 플러그인 소스는 `src/` 에 두고, manifest 는 `src/manifest.json` 이다.

## 도우미

- `native-host/Host.cs` 를 고치면 `npm run build:host` 로 `src/native/` 의 실행 파일을 다시 만들어 함께 커밋한다
- 메시지 규격을 바꾸면 `Host.cs` 의 `Protocol` 과 `src/background.js` 의 `HOST_PROTOCOL` 을 함께 올린다
- 프록시·도우미 동작을 바꾸면 `npm test` 와 `npm run test:e2e` 로 검증한다

## 커밋 정책

- 개발 작업을 완료하면 검증 후 사용자에게 묻지 않고 **commit 까지 수행**한다. **push 는 하지 않는다** (사용자가 직접 push). 사용자가 해당 작업에서 commit 하지 말라고 하면 그 요청을 따른다
- 커밋 메시지는 변경 결과를 요약한 **한글**로 작성한다 (파일 경로·식별자는 영어 그대로 가능). 원인과 구현 세부는 본문에 적는다
- 이번 작업에 해당하는 파일만 선별해 stage 한다. 함께 수정한 문서와 새로 만든 파일은 누락하지 않고, 작업과 무관한 기존 변경은 포함하지 않는다
- 후속 수정도 `--amend` 하지 않고 **새 커밋**으로 남긴다 — 수정마다 버전이 하나씩 올라야 하기 때문이다
- `main` 브랜치에서 작업한다. 다른 브랜치라면 임의로 전환하지 말고 사용자에게 알린다

## 버전 관리

**수정(커밋)할 때마다 patch 버전이 하나씩 오른다.** 버전의 원본은 [CHANGELOG.md](CHANGELOG.md) 최상단 버전 블록이며, `package.json`·`src/manifest.json` 의 `version` 은 여기에 맞춰 자동 동기화된다. 버전 번호·날짜를 직접 쓰지 않는다.

- `src/` 를 수정하면 **`CHANGELOG.md` 의 `## [Unreleased]` 블록에 항목을 추가**한 뒤 함께 커밋한다
- 커밋 때 `.githooks/pre-commit` 이 `[Unreleased]` 를 `## [다음 버전] - 오늘날짜` 로 확정하고, 바뀐 버전 파일을 같은 커밋에 넣는다. 같은 날 여러 번 커밋해도 합치지 않고 각각 새 버전이 된다
- `src/` 를 수정했는데 `[Unreleased]` 가 비어 있으면 커밋이 거부된다. `src/` 를 건드리지 않는 커밋(문서·스크립트)은 버전이 오르지 않는다
- minor/major 는 사용자 확인 후 커밋 전에 `npm run release:minor` / `npm run release:major` 로 확정한다
- 새 클론에서는 `npm install` 로 hook 을 활성화한다 (`core.hooksPath` 설정)
- `release-notes.json` 은 CHANGELOG 변환 산출물이므로 직접 수정하지 않는다

## CHANGELOG 작성

- **분류**: `### 새로운 기능` / `### 편의성 개선` / `### 버그 수정` / `### 내부 변경` 중 맞는 섹션에 한글 항목(`- 내용`)으로 작성한다. 사용자가 체감하지 않는 `src/` 수정은 `### 내부 변경` 에 적는다
- **분량**: 한 항목은 결과 중심 1줄, 공백 포함 80자 이내. 구현 원리·원인 분석은 커밋 메시지에 적는다
