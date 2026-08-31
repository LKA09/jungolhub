# JungolHub

JUNGOL(정올)에서 문제를 제출해 **정답(Accepted)** 판정을 받으면 풀이 코드와 문제 정보를 GitHub 저장소에 자동 커밋하는 Chrome 확장 프로그램입니다.

BaekjoonHub의 핵심 아이디어인 **온라인 저지 판정 감지 → 문제/코드 파싱 → GitHub Git Data API 커밋** 흐름을 참고해 JUNGOL 전용으로 새로 구현한 프로젝트입니다.

## 현재 구현 상태

- Chrome Manifest V3
- JUNGOL 문제 번호/제목/문제·입력·출력 파싱
- 제출 요청에서 코드/언어를 가로채 캐시
- `fetch` / XHR 채점 응답의 Accepted 감지
- DOM의 정답 상태 칩 감지 fallback
- GitHub Fine-grained PAT 연결
- README + 소스코드를 같은 커밋으로 업로드
- 동일 문제/동일 코드 중복 업로드 방지
- 빈 저장소는 Contents API로 자동 초기화 fallback

기본 저장 경로:

```text
JUNGOL/
└── 1000. 두 정수 더하기 (A+B)/
    ├── README.md
    └── 1000.cpp
```

## 설치

1. 이 저장소를 내려받습니다.
2. Chrome에서 `chrome://extensions`를 엽니다.
3. **개발자 모드**를 켭니다.
4. **압축해제된 확장 프로그램을 로드합니다**를 누르고 프로젝트 폴더를 선택합니다.
5. JungolHub 아이콘을 눌러 GitHub 설정을 입력합니다.

## GitHub 설정

GitHub에서 Fine-grained Personal Access Token을 만들고 업로드 대상 저장소에 대해 최소한 다음 권한을 부여하세요.

- Repository access: 업로드할 저장소
- Contents: **Read and write**
- Metadata: Read-only (기본)

확장 프로그램 팝업에 아래처럼 설정합니다.

```text
Repository: LKA09/algorithm
Root folder: JUNGOL
Branch: (비워두면 기본 브랜치)
```

토큰은 `chrome.storage.local`에 저장되며 웹 페이지에는 노출하지 않습니다. 배포판에서는 GitHub OAuth 방식으로 교체하는 것이 권장됩니다.

## 동작 방식

JUNGOL은 SPA 형태로 제출/채점 UI가 갱신될 수 있기 때문에 두 경로를 동시에 사용합니다.

1. `page-hook.js`가 페이지의 `fetch`와 `XMLHttpRequest`를 관찰합니다.
2. 제출 요청에서 source code / language / problem id 후보 값을 수집합니다.
3. 채점/상태 응답에 `Accepted`, `AC`, `정답`, `통과` 등이 나타나면 content script에 알립니다.
4. 네트워크 응답을 놓친 경우 `MutationObserver`가 화면의 정답 상태 칩을 감지합니다.
5. `content.js`가 문제 정보와 소스코드를 합쳐 service worker로 전달합니다.
6. `background.js`가 GitHub Git Data API로 blob → tree → commit → ref 업데이트를 수행합니다.

## 지원 확장자

C, C++, C#, Python/PyPy, Java, JavaScript, TypeScript, Kotlin, Rust, Go, Swift, Ruby, PHP, OCaml, Haskell, Elixir를 기본 매핑합니다. 알 수 없는 언어는 `.txt`로 저장합니다.

## 개발/디버깅

JUNGOL에서 F12 → Console을 열고 `[JungolHub]` 로그를 확인할 수 있습니다.

확장 프로그램 service worker 로그는:

```text
chrome://extensions
→ JungolHub
→ 서비스 워커 검사
```

JUNGOL의 내부 API 필드명이 바뀌어 코드 캡처가 실패하면 `page-hook.js`의 `extractSubmission()` 후보 키를 추가하면 됩니다.

## 보안/배포 계획

MVP는 사용자가 직접 생성한 Fine-grained PAT를 사용합니다. Chrome Web Store에 공개 배포할 버전에서는 PAT 직접 입력 대신 GitHub OAuth/App 인증으로 변경하는 것을 권장합니다.

## License

MIT
