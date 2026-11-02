# ByeDPI (ciadpi.exe)

- 프로젝트: https://github.com/hufrea/byedpi (MIT, `LICENSE` 참고)
- 버전: v0.17.3 공식 릴리스
- 원본: [`byedpi-17.3-x86_64-w64.zip`](https://github.com/hufrea/byedpi/releases/download/v0.17.3/byedpi-17.3-x86_64-w64.zip)
- zip SHA-256: `70d2c94147193cb915f9c6eb5144b8d404dacbcfa90bda2383b6b211afafa456` (GitHub 공개 해시와 일치)
- `ciadpi.exe` SHA-256: `eb53ceeeb981cc6735ac24bb1e51e725280b86630e80fdf19ddc4ee4a5b54ef4` (zip 안의 파일과 바이트 단위로 일치)
- 코드 서명: 없음 (공식 릴리스 자체가 서명되어 있지 않다)

업데이트할 때는 [공식 릴리스](https://github.com/hufrea/byedpi/releases)의 `x86_64-w64` 압축 파일에서
`ciadpi.exe` 를 꺼내 덮어쓰고, 이 문서를 갱신한 뒤 `npm run build:host` 와 `npm run test:e2e` 를 실행한다.
