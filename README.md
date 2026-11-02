# GoodbyeDPI for Firefox

Firefox 트래픽만 로컬 [ByeDPI](https://github.com/hufrea/byedpi)(`ciadpi`) 프록시로 보내 DPI 차단을 우회하는 확장입니다. 다른 프로그램의 통신에는 영향을 주지 않으며, 현재 Windows 만 지원합니다.

## 동작 방식

```
팝업 토글 → background.js → 도우미(goodbyedpi-host.exe) → ciadpi.exe
                  └→ Firefox 프록시 설정 (PAC: SOCKS5 127.0.0.1:자동포트; DIRECT)
```

- **내장**: `ciadpi` 는 도우미 실행 파일에, 도우미는 확장 패키지에 들어 있어 외부 다운로드가 없습니다. 다만 확장은 프로그램을 직접 실행할 수 없어 최초 1회 설치 파일 실행이 필요합니다.
- **자동 포트**: 켤 때마다 OS 에서 빈 포트를 받고, SOCKS5 응답을 확인한 뒤에만 프록시를 적용합니다.
- **끊김 방지**: `ciadpi` 가 죽어도 PAC 의 `DIRECT` 폴백으로 접속이 유지되고, 1분 안에 새 포트로 복구합니다. 복구에 실패하면 프록시를 해제하고 꺼진 상태로 돌아갑니다.
- **적용 범위**: 전체, 특정 사이트만 적용, 특정 사이트만 제외를 고를 수 있습니다.

## 사용하기

1. 확장을 설치합니다. 정식 Firefox 는 서명된 확장만 영구 설치할 수 있습니다. 개발 중에는 `about:debugging` → 이 Firefox → 임시 부가 기능 로드에서 `src/manifest.json` 을 고릅니다.
2. `about:addons` 에서 이 확장의 *사생활 보호 창에서 실행* 을 허용합니다. Firefox 가 프록시 설정을 바꾸는 확장에 요구하는 권한입니다.
3. 자동으로 열리는 준비 화면에서 설치 파일을 받아 한 번 실행합니다. 관리자 권한은 필요 없습니다.
4. 팝업의 토글을 켭니다.

도우미는 Windows 설정의 *설치된 앱* 에서 제거할 수 있습니다.

## 개발

| 명령 | 내용 |
|---|---|
| `npm install` | 커밋 hook 활성화 |
| `npm run build:host` | `native-host/Host.cs` 를 컴파일해 `src/native/` 에 넣기 |
| `npm test` | PAC·도메인 단위 테스트 |
| `npm run test:e2e` | 실제 Firefox 와 도우미로 전체 흐름 검증 (도우미를 실제로 설치·제거함) |
| `npm run lint:ext` | Mozilla 검사 도구 실행 |
| `npm run package` | 배포용 패키지를 `dist/` 에 생성 |

서명은 [AMO API 키](https://addons.mozilla.org/developers/addon/api/key/)를 발급받아 실행합니다.

```
npx web-ext@8 sign --source-dir src --channel unlisted --api-key <키> --api-secret <비밀값>
```

`ciadpi.exe` 의 출처와 교체 방법은 [vendor/byedpi/SOURCE.md](vendor/byedpi/SOURCE.md) 에 있습니다.
