# 디스코드 채팅 추출기 V2 — 구현 계획

> 이 문서가 V2의 단일 기준이다. **§5 계약은 메인 에이전트(Opus)만 바꾼다.** 구현 에이전트는 계약 변경이 필요하면 직접 고치지 말고 보고서에 "계약 변경 제안"으로 남긴다.
> v1 원본: https://github.com/LanturnHouse/discord-chat-extractor (V2 코어 이식의 참고용. V2 저장소에서는 수정하지 않는다)
> 변경 이력: 2026-10-06 1차 승인 → 2차 변경(설정 모달 제거, 공통 설정 + 항목별 ⚙, 버튼 토글, 기본 포맷 HTML) → 3차(서버 헤더 버튼) → 4차(행 버튼 항상 표시·맨 오른쪽, 카테고리·서버 버튼 토글+체크 표시, 팝업 브랜드 버튼 글자색) → 5차(팝업 목록을 서버›카테고리›채널 트리로, 서버·카테고리 설정, 한 줄 압축).

## 1. 목표

크롬 MV3 확장. discord.com 웹 화면의 채널·DM 행에 다운로드 버튼을 넣는다. 버튼을 누르면 그 채팅이 **공통 설정**으로 다운로드 목록에 바로 담기고, 다시 누르면 빠진다. 툴바 팝업에서 현재 계정, 목록, 공통 설정, 항목별 설정(⚙)을 관리하고 한 번에 다운로드한다. v1에서 검증된 코어(API 클라이언트, rate limit, 6개 포맷 작성기, 파일명, ZIP, 목 데이터, 테스트)를 이식한다.

## 2. 확정 사항 (사용자 승인)

| 항목 | 결정 |
|---|---|
| 버튼 위치 | (4차) 채널·DM·카테고리·스레드·음성 행 아이콘 영역의 **맨 오른쪽**. 디스코드가 호버 때 띄우는 아이콘(초대·편집·X·채널 만들기 등)은 우리 버튼 **왼쪽**에 나타나므로 호버해도 우리 버튼은 움직이지 않는다 |
| 버튼 표시 | (4차) **항상 보임**(호버 불필요). 모양·색·크기는 옆 디스코드 아이콘의 클래스를 복사해 맞춘다 |
| 버튼 동작 | 클릭 = 공통 설정으로 즉시 목록에 추가(아이콘이 체크로 바뀜). 다시 클릭 = 목록에서 제거(토글). **디스코드 위 설정창 없음** |
| 서버 버튼 | 서버 이름 헤더의 사람+(서버에 초대하기) 바로 왼쪽에 **붙어서**(헤더가 `space-between`이므로 `margin-left:auto`). 네이티브 초대 버튼처럼 항상 보임. 클릭 = 그 서버에서 내가 볼 수 있는 텍스트·공지·포럼·미디어 채널 전부를 공통 설정으로 추가, 전부 담겨 있으면 체크 표시이고 누르면 전부 제거(토글) |
| 공통 설정 | 팝업의 공통 설정 패널(v1 옵션 창 디자인). 기본값: 개수 200(‘전체’ 가능), 기간 미설정, 포맷 **HTML(다크 테마)** |
| 항목별 설정 | 팝업 목록 ⚙에서 채널마다 따로 설정. 손대지 않은 항목은 상위 설정(카테고리 → 서버 → 공통)을 계속 따라감. 따로 설정한 항목은 "개별 설정" 표시 + [상위 설정으로 되돌리기] |
| 목록 트리 (5차) | 팝업 목록은 Discord 사이드바 같은 트리: 서버(아이콘·이름) ▸ 카테고리(폴더 아이콘·이름) ▸ 채널. 서버·카테고리는 기본 접힘, 클릭하면 펼침. 개별로 담은 채널도 자동으로 소속 서버·카테고리 아래에 묶임. 하위가 하나뿐이면 한 줄로 압축(`서버 › #채널`). DM은 평평한 줄 |
| 서버·카테고리 설정 (5차) | 서버·카테고리 줄에도 ⚙. 저장하면 아래 전부에 한 번에 적용(아래의 개별 설정·하위 카테고리 설정은 지워짐, 개수는 저장 전에 안내). 이후 같은 서버·카테고리에 담는 채널도 그 설정을 따름. 우선순위: 채널 개별 > 카테고리 > 서버 > 공통 |
| 개수+기간 | 기간 안에서 **최신 N개** |
| 여러 개 저장 | 개별 파일 기본, "ZIP 하나로 받기" 옵션 |
| 활성화 | 디스코드를 열면 자동으로 버튼 표시, 팝업 토글로 끔 |

추가 기능 1~18 전부 포함:
1 다운로드 시작(팝업 [전체 다운로드] + 항목별 ▶) · 2 진행률·취소·툴바 배지 · 3 실패 처리·재시도 · 4 디스코드 탭 없음 안내 · 5 계정별 목록 · 6 첨부파일 저장 · 7 설정 화면(공통 설정 + 앱 설정) · 8 ZIP 옵션 · 9 완료 알림+폴더 열기 · 10 스레드·포럼 포함 · 11 첫 실행 약관·위험 안내 · 12 내용 옵션(봇/시스템/반응/임베드) · 13 카테고리 버튼 = 하위 채널 전부 공통 설정으로 추가 · 14 증분 백업(지난번 이후만) · 15 단축키 = 보고 있는 채팅 토글 · 16 다운로드 기록 · 17 (4차에서 폐지: 버튼이 항상 보임) · 18 영어 UI

추가 UX 규칙 (메인 에이전트 결정):
- 버튼을 누른 결과는 디스코드 화면 하단에 작은 토스트로 알린다(추가됨/제거됨/N개 추가/오류).
- (4차) 카테고리·서버 버튼도 토글이다: 그 그룹에서 내가 볼 수 있는 채널이 **전부** 목록에 있으면 아이콘이 체크이고, 누르면 그 채널들을 전부 뺀다. 하나라도 빠져 있으면 다운로드 아이콘이고, 누르면 빠진 것만 추가한다. 내가 볼 수 없는 채널(역할·권한 덮어쓰기로 계산한 VIEW_CHANNEL·READ_MESSAGE_HISTORY 없음)은 계산·추가 모두에서 제외한다.
- 체크 상태는 콘텐츠가 `LOCAL.groups(계정)`(bg가 권한 계산 후 기록하는 그룹별 채널 목록)과 목록을 비교해 계산한다. 콘텐츠는 서버 화면을 볼 때 `queue/groupInfo`로 bg에 그룹 정보 갱신을 요청한다(서버당 5분에 한 번).
- (5차) 서버·카테고리 그룹 줄의 ▶ = 그 그룹에 담긴 채널 전부 다운로드, ✕ = 담긴 채널 전부 목록에서 빼기(인라인 확인), ⚙ = 그룹 설정. 그룹 줄은 "전체"(볼 수 있는 채널이 전부 담김)/"N개"(일부)를 표시.
- 성공적으로 끝난 항목은 목록에서 자동 제거되고 기록(#16)에 남는다. 실패·부분·취소 항목은 목록에 남아 재시도할 수 있다.
- 파일명 기본값: `Discord Export/예시서버 - 일반 (2026-10-06).html`, DM은 `Discord Export/DM - 이름 (2026-10-06).html`.

## 3. 아키텍처

| 컨텍스트 | 위치 | 역할 |
|---|---|---|
| 콘텐츠 스크립트 | `src/content` (discord.com 탭, isolated world, IIFE 단일 파일) | 행·서버 버튼 주입·툴팁·토스트, 클릭 시 `queue/toggle`·`queue/addCategory`·`queue/addGuild`, 그룹 정보 요청(`queue/groupInfo`), 테마 토큰 수집, 단축키 처리, 주입 상태 보고. **API 호출 없음** |
| 백그라운드 SW | `src/background` (ES module 단일 파일) | 로그인 확인(v1 토큰 모듈), 계정 확인, 목록·설정·기록 저장(**유일한 쓰기 주체**), 카테고리 하위 채널 조회, 작업 시작/취소, chrome.downloads, 배지, 알림, 단축키, 오프스크린 수명 관리 |
| 오프스크린 문서 | `src/offscreen` (reason `BLOBS`) | 다운로드 엔진: v1 API 클라이언트로 메시지 수집 → 포맷 변환 → Blob → blob URL |
| 팝업 | `src/popup` (React) | 계정, 목록(▶/⚙/✕), 공통 설정 패널, 항목 편집, 진행률, 앱 설정, 기록, 약관 안내 |

흐름:
- 추가/제거: 행 버튼 클릭 → 콘텐츠가 `queue/toggle`(대상 정보) → bg가 `dce.queue.<계정>`에 `settings: null`(공통 설정 따름)로 추가하거나 제거 → storage.onChanged로 콘텐츠(아이콘 체크)·팝업 반영 → 콘텐츠가 토스트 표시.
- 카테고리: 콘텐츠가 `queue/addCategory` → bg가 `GET /api/v9/guilds/<id>/channels`로 하위 채널(`parent_id` 일치, 타입 0·5·15·16)을 찾아, 볼 수 있는 것이 전부 담겨 있으면 전부 제거, 아니면 안 담긴 것만 추가. 결과와 함께 `LOCAL.groups`도 갱신.
- 서버: 콘텐츠가 `queue/addGuild` → bg가 같은 채널 목록 + 역할(`/guilds/<id>/roles`) + 내 멤버 정보(`/users/@me/guilds/<id>/member`, 실패 시 `/guilds/<id>/members/@me`)로 권한을 계산해(v1 `permissions.ts`) 볼 수 있는 타입 0·5·15·16 채널 중 안 담긴 것만 위치 순서대로 추가(전부 담겨 있으면 전부 제거). 서버 정보는 `GET /guilds/<id>`(소유자 id, 이름, 역할 폴백). 카테고리 추가도 같은 권한 필터를 쓴다.
- 그룹 정보: 콘텐츠가 `queue/groupInfo` → bg가 같은 데이터(60초 캐시)로 서버 전체·카테고리별 볼 수 있는 채널 목록을 `LOCAL.groups(계정)`에 기록(그 서버의 기존 그룹 항목은 교체).
- 다운로드: 팝업 `job/start` → bg가 각 항목의 유효 설정(`resolveEffectiveSettings`: 항목 개별 > 카테고리 > 서버 > 공통, §5.4)을 확정해 오프스크린 생성 → `engine/run` → 엔진이 v1 API 클라이언트로 디스코드 API를 직접 호출(v1과 동일, host_permissions) → 파일 생성 → `engine/saveBlob` → bg가 `chrome.downloads.download` → 완료 후 `engine/revoke`.
- 디스코드 탭은 로그인 상태 확인에만 필요하다. 다운로드 중에 탭을 닫아도 작업은 계속된다.
- 인증 처리는 v1의 토큰 모듈(`src/background/token.ts`)과 저장 방식(`chrome.storage.session`)을 그대로 쓴다. 인증 값은 bg와 엔진 메모리에만 있고 콘텐츠·팝업은 모른다.

## 4. 디스코드 DOM (2026-10-06 실측: 한국어 UI, `html.theme-dark.theme-midnight.visual-refresh`)

해시 접미사(`_c69b6d`, `__2ea32` 등)는 빌드마다 바뀔 수 있다 → 항상 `[class*="이름_"]` 부분 일치 + 구조 + `href`/`data-list-item-id`로 찾는다. aria-label은 현지화되므로 판별에 쓰지 않는다(로그·디버그 용도만).

채널 목록 컨테이너: `ul[aria-label="채널"]`(class `content_*`). 첫 `li`는 "이벤트" 버튼 행(무시).

채널 행 (예: 일반)
```
li.containerDefault_c69b6d[data-dnd-name="일반"]          ← 선택 시 + .selected_c69b6d
  div.iconVisibility_c69b6d.wrapper__2ea32                    ← 선택 시 + .selectedChannel_c69b6d.modeSelected__2ea32
    [div.unread__2ea32 …]                                     ← 안 읽음 표시(선택적)
    div
      a.link__2ea32[role=link][data-list-item-id="channels___<channelId>"][href="/channels/<guildId>/<channelId>"][aria-label="일반 (채팅 채널)"]
        div.linkTop__2ea32
          div.iconContainer__2ea32[role=img][aria-label="텍스트 icon"] > svg.icon__2ea32
          span.hiddenVisually_b18fe2 "텍스트"
          div.name__2ea32.overflow_b0dfc2 > span "일반"
          span (display:none)
          div.children__2ea32 (display:flex)                  ← ★ 아이콘 영역. (4차) 우리 버튼은 여기 **마지막 자식**, 항상 보임
            span
              div.iconItem_c69b6d.iconBase_c69b6d.iconNoChannelInfo_c69b6d[role=button][tabindex=0][aria-label="채널로 초대하기"]
                svg.actionIcon_c69b6d (16px)
            span.hiddenVisually_b18fe2 "채널로 초대하기"
```
- `iconItem` 은 평소 `display:none`, 행 호버 또는 선택 상태에서 `display:block`. → 우리 버튼 div에 **네이티브 `iconItem` 요소의 className을 그대로 복사**하고 svg에는 `actionIcon` className을 복사하면 호버 규칙·선택 규칙·크기·색이 디스코드와 동일해진다.
- 채널 편집(톱니)은 권한이 있을 때만 있다. 순서는 [초대, 편집] → (4차) 우리 버튼은 그 뒤(맨 오른쪽). 미러링한 `iconItem` 클래스는 평소 `display:none`이므로 우리 버튼에만 `display:block !important`를 주는 자체 클래스를 더한다.
- 행에 네이티브 아이콘이 하나도 없으면: 다른 행에서 배운 클래스(캐시, `dce.classCache`) 사용 → 그것도 없으면 폴백 CSS로 흉내: `[class*="iconVisibility_"]:hover .dce-row-btn, [class*="iconVisibility_"]:focus-within .dce-row-btn, li[class*="selected_"] .dce-row-btn { display:block }`, 기본 `display:none`.
- 채널 이름은 `li[data-dnd-name]` 값 사용(접두어 "읽지 않은"·접미어 없음). 서버 이름은 `document.title`의 마지막 `|` 조각(예: `(8) Discord | #공지 | 예시서버`)으로 채우고, bg/엔진이 API로 보정한다.

카테고리 행 (#13)
```
li.containerDefault__29444[data-dnd-name="ACT"]
  div.iconVisibility__29444.wrapper__29444.wrapperCommon__29444.clickable__29444
    div.mainContent__29444[role=button][aria-label="ACT (카테고리)"][data-list-item-id="channels___<categoryId>"][tabindex=-1]   (aria-expanded는 하위 요소)
      h3.name__29444 > div.overflow_b0dfc2 "ACT"
      svg.icon__29444 (접기 화살표 12px)
    div.children__29444 (평소 display:none, 호버 시 표시 — 관리자용 "채널 만들기"(addButton_*) 자리)
```
- 판별: `li` 안에 `[data-list-item-id^="channels___"]`가 있는데 그것이 `a[href]`가 아니고 `aria-expanded`를 가진 요소가 있으면 카테고리. (4차) `children_*` 컨테이너는 호버 때만 보이므로 우리 버튼은 그 **바깥**, `iconVisibility_*`/`wrapper_*` 줄의 마지막 자식으로 넣어 항상 보이게 한다(호버 때 나타나는 "채널 만들기"는 우리 버튼 왼쪽). 모양은 채널 아이콘 클래스 캐시 또는 폴백 CSS(16px, `--interactive-icon-default`→hover).

서버 이름 헤더 (채널 목록 위, 2026-10-06 실측)
```
nav.container__2637a[aria-label="예시서버 (서버)"]
  header.header_f37cb1 (flex)
    div.headerContent_f37cb1.primaryInfo_f37cb1 (flex)
      div.guildDropdown_f37cb1[role=button][aria-label="예시서버, 서버 활동"][aria-expanded]   ← 서버 메뉴(누르면 드롭다운 열림)
        div.guildBadgeAndName_f37cb1 > (부스트 배지…) + h2.name_f37cb1 "예시서버"
        div.headerChildren_f37cb1 > svg (화살표)
      span                                                                               ← 툴팁 래퍼
        div.inviteButton_f37cb1[role=button][tabindex=0][aria-label="서버에 초대하기"] (32×32 flex) > svg (20×20)   ← ★ 우리 버튼은 이 span 바로 앞
```
- 서버 ID는 URL `/channels/<guildId>/…`에서, 서버 이름은 `h2[class*="name_"]`(없으면 `document.title` 마지막 조각).
- 우리 버튼: `span > div` 구조로 넣고 div에 `inviteButton_*` className 복사, svg 20px. 초대 버튼이 없으면(초대 권한 없음) `headerContent_*`의 끝에 붙이고 폴백 CSS(32×32, `--interactive-icon-default` → hover `--interactive-icon-hover`).
- 클릭이 `guildDropdown`으로 전파되면 서버 메뉴가 열리므로 반드시 차단. DM 홈(`/channels/@me`)에는 이 헤더가 없다.

DM 행 (예: 친구)
```
li.channel__972a0.dm__972a0.container_e45859[role=listitem]
  div.interactive_f88cfd.interactive__972a0
    a.link__972a0.channelNameFade__972a0[data-list-item-id="private-channels-uid_11___<channelId>"][href="/channels/@me/<channelId>"][aria-label="친구 (다이렉트 메시지), 온라인"][tabindex=-1]
      div.layout__20a53 > div.avatar__20a53 (…) + div.content__20a53 > … div.name__20a53 > div.overflowTooltip… "친구"
    div.iconsContainer__972a0 (display:flex)                  ← ★ (4차) 우리 버튼은 closeButton 뒤 = 마지막 자식, 항상 보임
      div.closeButton__972a0.reducedClickTarget__972a0[role=button][tabindex=0][aria-label="개인 메시지 닫기"]   ← 평소 display:none, 행 호버 시 display:flex, opacity .7
        div > svg.closeIcon__972a0[role=img] (16px)
```
- `uid_11`의 숫자는 목록 위치라 불안정 → 채널 ID는 반드시 `href`에서 파싱.
- 우리 버튼 div에 closeButton className 복사, svg에 closeIcon className 복사.
- DM 표시 이름: 행 안 이름 요소 텍스트(없으면 aria-label 첫 쉼표/괄호 앞).

추가 사실 (디스코드 공개 번들 build 629779, 2026-10-05 분석 — 실측과 일치):
- 두 사이드바 모두 가상화 리스트: 화면 밖 행은 언마운트, 스크롤 시 `li` 재생성, 서버 전환 시 목록 재구성. `li`가 살아 있어도 `children_*`만 다시 만들어질 수 있음 → 매 패스마다 우리 버튼이 **실제로 있는지** 확인(마커 속성은 최적화용일 뿐).
- 채널 ID 필터: `data-list-item-id`의 `___` 뒤가 `/^\d+$/`인 것만("채널 & 역할" 같은 일반 행은 `channels___channels-<guildId>`). 카테고리는 `aria-expanded` 보유.
- 음성/스테이지 행: `a`에 href 없음, `role=button`. 아이콘 순서 [채팅 열기, 음성으로 초대하기, 편집, 정보] → (4차) 마지막 자리. ID는 `data-list-item-id`에서.
- 스레드 행: `li > ul[role=group]` 안, 링크가 `div[role=button]`(href 없음), `data-list-item-id="channels___<threadId>"`, 클래스 `typeThread_*`, 네이티브 아이콘 없음 → 클래스 캐시/폴백 CSS 사용.
- 포럼·공지 채널은 텍스트 채널과 같은 행 구조(포럼은 개수 배지가 `children_`에 있을 수 있음).
- DM `iconsContainer_*`에는 즐겨찾기 아이콘·"손 흔들기"(waveButton)가 먼저 올 수 있음 → 반드시 `closeButton_*` 바로 앞에 삽입(없으면 맨 끝). 새 친구 DM은 closeButton이 아예 없을 수 있음. 그룹 DM의 X는 "그룹 나가기"(확인 모달을 띄움) — 우리 클릭이 절대 그쪽으로 전파되면 안 됨.
- DM 닫기 버튼 표시 규칙: `.closeButton{display:none}` → `.channel:hover`, `:focus-within`에서 flex. 채널 아이콘: `.iconVisibility:hover/:focus/:focus-within`, 선택 행, 연결된 음성 행(`alwaysShown_*`)에서 표시.
- 해시가 1년 넘게 그대로인 경우도 있지만 모듈이 수정되면 바뀜 → 클래스 이름 하드코딩 금지.
- `<html>` 클래스는 React-Helmet이 관리 → 우리가 클래스를 추가하지 말 것.
- SPA 이동: pushState 라우터. isolated world에서는 `history.pushState` 패치가 안 보임 → MutationObserver만으로 충분(필요 시 `navigation` 이벤트, `popstate`).

테마 변수(실측, `<html>`의 computed style, 값은 `color-mix(...)` 문자열): `--background-base-low|lower|lowest`, `--background-surface-high|higher|highest`, `--background-mod-subtle|normal|strong|muted`, `--border-subtle|normal|strong`, `--brand-500`, `--brand-560`, `--control-brand-foreground`, `--text-default|muted|strong|subtle|link`, `--icon-default|muted|strong`, `--interactive-muted`, `--input-background-default`, `--input-border-default|hover|active`, `--modal-background`, `--modal-footer-background`, `--radius-xs|sm|md|lg`, `--status-danger|positive|warning`, `--font-primary`, `--channels-default`. 아이콘·버튼용: `--interactive-text-default|hover|active`, `--interactive-icon-default|hover|active`, `--interactive-background-hover|active|selected`, `--channel-icon`. 채널 actionIcon 색 = `--interactive-text-default`→hover→active(선택 행은 `--icon-strong`), DM 닫기 아이콘 = `currentColor`(`--text-muted`, 선택 시 `--text-default`), 불투명도 .7→1. (`--interactive-normal/hover`, `--text-normal`, `--header-primary`, `--background-modifier-*`는 현재 정의가 없음 — 쓰지 말 것.)

## 5. 계약 (메인 에이전트 소유)

### 5.1 `src/shared/types.ts`
```ts
export type ExportFormat = 'txt' | 'html' | 'md' | 'xlsx' | 'csv' | 'json';
export const EXPORT_FORMATS: readonly ExportFormat[] = ['html', 'txt', 'md', 'xlsx', 'csv', 'json'];

export type ChatKind = 'guild-channel' | 'thread' | 'forum' | 'dm' | 'group-dm';

export interface ChatTarget {
  kind: ChatKind;
  channelId: string;
  guildId: string | null;        // DM/그룹 DM은 null
  guildName: string | null;      // 예: "예시서버"
  channelName: string;           // '#' 없는 채널명 또는 DM 표시 이름
  parentId?: string | null;      // 카테고리 id(채널) 또는 부모 채널 id(스레드)
  parentName?: string | null;
  channelType?: number;          // 알면 디스코드 채널 타입(0,2,4,5,10,11,12,13,15,16,1,3)
  iconUrl?: string | null;       // 목록 표시용 DM 아바타/서버 아이콘
}

export interface ContentOptions {
  includeBots: boolean;          // 기본 true
  includeSystem: boolean;        // 기본 true
  includeReactions: boolean;     // 기본 true
  includeEmbeds: boolean;        // 기본 true
}

export interface ExportSettings {
  count: number | null;          // null = 전체. 기본 200. 정수 1..1_000_000
  from: string | null;           // ISO8601 UTC, 포함 하한(시작일 00:00:00.000 로컬). null = 무제한
  to: string | null;             // ISO8601 UTC, 포함 상한(종료일 23:59:59.999 로컬). null = 지금
  format: ExportFormat;          // 기본 'html'
  htmlTheme: 'dark' | 'light';   // HTML일 때만 의미. 기본 'dark'
  includeAttachments: boolean;   // #6 기본 false
  includeThreads: boolean;       // #10 기본 false (포럼/미디어 채널은 항상 스레드 단위)
  incremental: boolean;          // #14 기본 false
  content: ContentOptions;       // #12
}

export interface QueueItem {
  key: string;                   // = target.channelId (계정 안에서 유일)
  target: ChatTarget;
  settings: ExportSettings | null; // null = 공통 설정(AppSettings.common)을 따름. 값이 있으면 개별 설정
  addedAt: number;               // epoch ms
  lastResult?: { status: 'partial' | 'failed' | 'cancelled'; message: string; at: number } | null; // 재시도 표시용
}

/** 작업 시작 시 유효 설정을 확정한 항목 (settings = item.settings ?? common) */
export interface ResolvedQueueItem {
  key: string;
  target: ChatTarget;
  settings: ExportSettings;
}

export interface AccountInfo {
  id: string;
  username: string;
  globalName: string | null;
  avatarUrl: string;             // 기본 아바타 포함 완성된 CDN URL
}

export interface AppSettings {
  common: ExportSettings;        // 공통 다운로드 설정 (#7)
  showButtons: boolean;          // 기본 true
  showQueuedIndicator: boolean;  // 사용 안 함(4차 변경: 버튼이 항상 보임). 값은 무시
  zipAll: boolean;               // #8 기본 false
  folderName: string;            // 기본 "Discord Export"
  dateInFileName: boolean;       // 기본 true
  timeZone: string;              // 'auto' 또는 IANA
  notifyOnComplete: boolean;     // #9 기본 true
  language: 'auto' | 'ko' | 'en';// #18 기본 'auto' (앱 화면 + 내보낸 파일 고정 문구)
  consentAt: number | null;      // #11 동의 시각
}

export type ItemStatus = 'waiting' | 'running' | 'paused' | 'done' | 'partial' | 'failed' | 'cancelled';
export type ItemPhase = 'resolving' | 'messages' | 'threads' | 'attachments' | 'writing' | 'saving';
export type ErrorKind = 'auth' | 'forbidden' | 'not-found' | 'rate-limited' | 'blocked' | 'network' | 'server' | 'cancelled' | 'interrupted' | 'unknown';

export interface ItemProgress {
  key: string;
  label: string;                 // 예: "예시서버 > #일반" / "친구"
  status: ItemStatus;
  phase: ItemPhase | null;
  fetched: number;
  expected: number | null;       // 개수 제한이 있으면 그 값
  error: { kind: ErrorKind; message: string } | null;
  files: string[];               // 저장된 상대 경로
}

export interface JobState {
  jobId: string;
  accountId: string;
  startedAt: number;
  finishedAt: number | null;
  state: 'running' | 'paused' | 'done' | 'cancelled' | 'failed';
  pausedReason: 'rate-limit' | null;
  zip: boolean;
  items: ItemProgress[];
}

export interface HistoryEntry {
  id: string;
  accountId: string;
  target: ChatTarget;
  settings: ExportSettings;      // 실제로 쓰인 유효 설정
  finishedAt: number;
  status: 'done' | 'partial' | 'failed';
  messageCount: number;
  files: { filename: string; downloadId: number | null }[];
  error: string | null;
}

export interface InjectHealth { ok: boolean; reason: string | null; checkedAt: number }

/** 유효 설정이 어디서 왔는지 (5차): 항목 개별 > 카테고리 > 서버 > 공통 */
export type SettingsSource = 'item' | 'category' | 'guild' | 'common';

/** 카테고리·서버 버튼의 체크 상태 계산용: 그룹 안에서 내가 볼 수 있는 채널 목록 (bg가 권한 계산 후 기록) */
export interface GroupInfo {
  kind: 'category' | 'guild';
  guildId: string;
  channelIds: string[];          // 볼 수 있는 타입 0·5·15·16 채널, 사이드바 순서
  updatedAt: number;             // epoch ms
  name?: string | null;          // (5차) 서버/카테고리 이름 — 팝업 트리 표시용
  iconUrl?: string | null;       // (5차) 서버 아이콘 URL(64px png). 카테고리는 없음
}

export interface ThemeTokens {
  scheme: 'dark' | 'light';
  themeClasses: string[];        // 예: ['theme-dark','theme-midnight']
  vars: Record<string, string>;  // §4 변수 이름 → computed 값
  lang: string;                  // document.documentElement.lang (예: 'ko')
  capturedAt: number;
}
```

### 5.2 `src/shared/storageKeys.ts`
```ts
// chrome.storage.session — 메모리 전용. 접근 레벨 TRUSTED_CONTEXTS(기본) 유지 → 콘텐츠 스크립트는 읽을 수 없음
export const SESSION = {
  token: 'dce.token',
  tokenCapturedAt: 'dce.tokenCapturedAt',
  account: 'dce.account',            // AccountInfo | null (현재 토큰의 계정)
  job: 'dce.job',                    // JobState | null
  injectHealth: 'dce.injectHealth',  // Record<string(tabId), InjectHealth>
} as const;
// chrome.storage.local — 콘텐츠 스크립트도 읽기 가능. 쓰기는 bg만 (예외: theme, classCache는 콘텐츠가 직접 씀)
export const LOCAL = {
  settings: 'dce.settings',                                   // AppSettings
  queue: (accountId: string) => `dce.queue.${accountId}`,     // QueueItem[]
  history: (accountId: string) => `dce.history.${accountId}`, // HistoryEntry[] 최신순, 최대 200
  lastExported: (accountId: string) => `dce.lastExported.${accountId}`, // Record<channelId, messageId>
  lastAccount: 'dce.lastAccount',                             // AccountInfo | null
  theme: 'dce.theme',                                         // ThemeTokens
  classCache: 'dce.classCache',                               // { channelIcon?: string; channelSvg?: string; dmButton?: string; dmSvg?: string }
  groups: (accountId: string) => `dce.groups.${accountId}`,   // Record<groupId(카테고리 id 또는 서버 id), GroupInfo>
  groupSettings: (accountId: string) => `dce.groupSettings.${accountId}`, // (5차) Record<groupId(서버 id 또는 카테고리 id), ExportSettings> 서버·카테고리 설정
  uiExpanded: 'dce.ui.expanded',                              // (5차) string[] 팝업 트리에서 펼친 그룹 id. UI 전용이라 팝업이 직접 기록
} as const;
```
- 팝업은 trusted context라 session을 읽을 수 있지만 `SESSION.token`, `SESSION.tokenCapturedAt`은 **읽지 않는다**.

### 5.3 `src/shared/messages.ts` (`chrome.runtime.sendMessage`)
모든 런타임 메시지에 `to` 필드가 있다. 수신자는 자기 `to`가 아니면 무시하고 응답하지 않는다.
```ts
export type BgError = 'no-account' | 'no-consent' | 'busy' | 'empty' | 'invalid' | 'forbidden-path' | 'http' | 'unknown';
export type BgResponse<T = undefined> = { ok: true; data: T } | { ok: false; error: BgError; message?: string };

export interface StatusSnapshot {
  account: AccountInfo | null;       // 현재 토큰 기준 확인된 계정. null = 아직 없음
  lastAccount: AccountInfo | null;
  discordTabs: number;               // 열린 디스코드 탭 수 (chrome.tabs.query URL 필터)
  health: InjectHealth | null;       // 가장 최근 보고
  job: JobState | null;
}

/** popup / content → background */
export type ToBackground =
  | { to: 'bg'; type: 'queue/toggle'; target: ChatTarget }              // 콘텐츠 행 버튼·단축키 → BgResponse<{ queued: boolean }>
  | { to: 'bg'; type: 'queue/addCategory'; guildId: string; guildName: string | null; categoryId: string; categoryName: string } // #13 토글 → BgResponse<{ added: number; skipped: number; removed: number }>
  | { to: 'bg'; type: 'queue/addGuild'; guildId: string; guildName: string | null }                   // 서버 버튼 토글 → BgResponse<{ added: number; skipped: number; removed: number }>
  | { to: 'bg'; type: 'queue/groupInfo'; guildId: string; guildName: string | null }                 // 콘텐츠가 서버를 볼 때 → bg가 LOCAL.groups 갱신 → BgResponse
  | { to: 'bg'; type: 'queue/upsert'; item: QueueItem }                 // 팝업 ⚙ 저장(settings null = 상위 설정(카테고리→서버→공통)을 따르도록 되돌리기)
  | { to: 'bg'; type: 'queue/setGroupSettings'; kind: 'guild' | 'category'; guildId: string; groupId: string; settings: ExportSettings | null } // (5차) 서버·카테고리 ⚙ 저장 → BgResponse<{ cleared: number }>
  | { to: 'bg'; type: 'queue/removeMany'; keys: string[] }               // (5차) 그룹 ✕ → BgResponse<{ removed: number }>
  | { to: 'bg'; type: 'queue/remove'; key: string }
  | { to: 'bg'; type: 'queue/clear' }
  | { to: 'bg'; type: 'settings/patch'; patch: Partial<AppSettings> }   // common은 통째로 교체
  | { to: 'bg'; type: 'job/start'; keys: string[] | 'all' }             // → BgResponse<{ jobId: string }>
  | { to: 'bg'; type: 'job/cancel' }
  | { to: 'bg'; type: 'history/rerun'; id: string }                     // → BgResponse<{ jobId: string }>
  | { to: 'bg'; type: 'history/clear' }
  | { to: 'bg'; type: 'downloads/show'; downloadId: number | null }     // null = 기본 다운로드 폴더
  | { to: 'bg'; type: 'discord/open' }
  | { to: 'bg'; type: 'status/get' }                                    // → BgResponse<StatusSnapshot>
  | { to: 'bg'; type: 'inject/health'; health: InjectHealth };

/** background → content (chrome.tabs.sendMessage) */
export type ToContent =
  | { to: 'content'; type: 'shortcut/toggleCurrent' };

/** background ↔ offscreen */
export interface EngineJob {
  jobId: string;
  accountId: string;
  authorization: string;                           // bg 세션 저장값 그대로. 엔진 메모리에만, 로그·에러·파일 금지
  items: ResolvedQueueItem[];
  settings: AppSettings;
  lastExported: Record<string, string>;
  locale: 'ko' | 'en';
  timeZone: string;                                // 'auto'를 이미 실제 IANA로 풀어서 전달
}
export type ToOffscreen =
  | { to: 'offscreen'; type: 'engine/run'; job: EngineJob }
  | { to: 'offscreen'; type: 'engine/cancel'; jobId: string }
  | { to: 'offscreen'; type: 'engine/revoke'; url: string };
export type FromOffscreen =
  | { to: 'bg'; type: 'engine/ready' }
  | { to: 'bg'; type: 'engine/authError'; jobId: string }            // 401 → bg가 같은 값일 때만 세션 인증값 삭제
  | { to: 'bg'; type: 'engine/progress'; job: JobState }
  | { to: 'bg'; type: 'engine/saveBlob'; jobId: string; itemKey: string | null; url: string; filename: string }  // → BgResponse<{ downloadId: number }>
  | { to: 'bg'; type: 'engine/saveUrl'; jobId: string; itemKey: string; url: string; filename: string }         // 첨부(개별 파일 모드) → BgResponse<{ downloadId: number }>
  | { to: 'bg'; type: 'engine/itemDone'; jobId: string; entry: HistoryEntry; lastMessageId: string | null }
  | { to: 'bg'; type: 'engine/finished'; jobId: string; state: JobState['state'] }
  | { to: 'bg'; type: 'engine/keepalive'; jobId: string };            // 20초마다 (긴 대기 중 SW 유지)
```
- 오프스크린은 `chrome.runtime`만 쓸 수 있다 → 저장소 접근 없음. 필요한 값은 전부 `EngineJob`으로 받는다.
- `filename`은 다운로드 폴더 기준 상대 경로이며 엔진이 세그먼트별로 이미 정리(§6.6)해서 보낸다. bg는 한 번 더 검증한다.

### 5.4 `src/shared/defaults.ts`
`DEFAULT_CONTENT_OPTIONS`(전부 true), `DEFAULT_EXPORT_SETTINGS`(count 200, from/to null, format `'html'`, htmlTheme `'dark'`, includeAttachments/includeThreads/incremental false, content 기본), `DEFAULT_APP_SETTINGS`(common = DEFAULT_EXPORT_SETTINGS, 나머지는 §5.1 기본값), `DISCORD_ORIGINS = ['https://discord.com','https://ptb.discord.com','https://canary.discord.com']`, `API_BASE_PATH = '/api/v9'`. 허용 목록(§8)은 `src/shared/allowlist.ts`. 유효 설정 헬퍼 `resolveItemSettings(item, common)`도 여기 둔다.

### 5.5 `src/shared/groups.ts` (5차, 메인 소유 — bg와 팝업이 같은 규칙을 쓰도록 순수 함수로 제공)
- `categoryIdOf(item, groups)`: `groups`(= `LOCAL.groups`)에서 `kind==="category"`이고 같은 `guildId`이며 `channelIds`에 `item.key`가 있는 그룹 id. 없으면, 항목 종류가 `guild-channel`/`forum`이고 `target.parentId`가 있을 때만 그 값. 서버가 없거나(DM) 그 외는 `null`.
- `belongsToGroup(item, kind, groupId, groups)`: `kind==="guild"` → `item.target.guildId === groupId`, `kind==="category"` → `categoryIdOf(item, groups) === groupId`.
- `resolveEffectiveSettings(item, common, groupSettings, groups)` → `{ settings, source }`: `item.settings`(source `item`) → `groupSettings[categoryIdOf]`(`category`) → `groupSettings[target.guildId]`(`guild`) → `common`(`common`). 항상 깊은 복사본.
- `pruneGroupSettings(groupSettings, items, groups)`: 담긴 항목이 하나도 없는 그룹의 설정 항목을 뺀 새 객체.
- `isGroupComplete(group, queuedKeys)`: 그룹 정보에 채널이 1개 이상 있고 전부 `queuedKeys`에 있음.

## 6. 다운로드 엔진 규칙

6.1 메시지 수집 (`GET /channels/{id}/messages`, limit ≤100, 응답은 항상 최신순)
- 하한 ID `lo` = max(SF(from) − 1, 증분 시 lastExported[channelId]) (없으면 없음, 배타적). 상한: `to`가 있으면 `before = SF(toMs + 1)`, 없으면 before 없이 최신부터.
- `before` 커서로 과거로 걸어가며 `id > lo`인 것만 모은다. 종료: 개수 도달 / `lo` 이하 메시지 등장 / 빈 페이지 / 커서가 더 안 나아감.
- 결과는 오래된→최신 정렬로 작성기에 넘긴다. 개수+기간 = 기간 안 최신 N개. 개수 null + 기간 없음 = 채널 전체(UI에서 경고).
- SF(ms) = (BigInt(ms) − 1420070400000n) << 22n.
6.2 속도·제한
- 메시지 페이지 요청 사이 0.7~1.5초 무작위 간격, 항목 사이 2~4초. 모든 요청은 직렬.
- 429: `retry_after`(JSON) > `Retry-After` > 1초, `global`이면 모든 경로 정지. 사용자 계정은 `X-RateLimit-Remaining/Reset-After`가 없을 수 있음(있으면 존중).
- JSON이 아닌 400/403 = `blocked`: 30·60·120초 대기 후 실패 처리.
- 403 + JSON code 50001/50013 = `forbidden`, 404/10003 = `not-found`, 401 = `auth`(bg에 알려 같은 값일 때만 삭제).
6.3 실패·취소
- 사용자 취소: 진행 중 항목은 버리고 `cancelled`. 이미 끝난 항목 파일은 그대로. ZIP 모드면 끝난 항목만 담아 "(부분)" ZIP 저장.
- 그 외 실패: 받은 데이터가 있으면 `(부분)` 접미어로 저장하고 `partial`, 없으면 `failed`. 어느 쪽이든 다음 항목으로 계속.
- 오프스크린이 사라지면(브라우저 재시작 등) bg가 시작 시 `running` 작업을 `failed(interrupted)`로 정리.
- 유효 설정은 작업 시작 시점에 확정한다(진행 중 공통 설정을 바꿔도 그 작업에는 영향 없음).
6.4 스레드·포럼 (#10)
- 사용자 계정은 `/threads/active` 불가. `GET /channels/{id}/threads/search?archived=<true|false>&sort_by=last_message_time&sort_order=desc&limit=25&offset=…`(offset ≤ 9975, `has_more`). 202(인덱스 준비 중)는 `retry_after` 후 재시도.
- 포럼(15)/미디어(16): 게시글(스레드)마다 별도 파일(ZIP이면 폴더). 텍스트 채널 + `includeThreads`: 채널 파일 + 스레드별 파일. 스레드 조회는 요청이 많아지므로 기본 꺼짐, UI에 경고.
6.5 첨부파일 (#6)
- CDN 서명 URL(`ex`/`is`/`hm`)은 24시간 후 만료 → 페이지를 받은 직후 저장. 개별 모드: `engine/saveUrl`로 bg가 CDN URL을 바로 `chrome.downloads`. ZIP 모드: 오프스크린이 CDN에서 직접 fetch(host_permissions) 해 ZIP에 담음. 6시간 넘게 지난 URL은 `POST /api/v9/attachments/refresh-urls`(최대 50개) 후 저장.
- 저장 위치: `<파일 기본 이름>_files/<attachmentId>_<원래이름>`. 작성기는 첨부 ID → 로컬 상대 경로 맵을 받아 html/md는 로컬 경로로 링크, txt/csv/xlsx/json은 로컬 경로를 같이 적는다.
6.6 파일명 (v1 `filename.ts` 규칙 확장)
- 개별: `<folderName>/<서버> - <채널>[ (YYYY-MM-DD)].<ext>`, DM `<folderName>/DM - <이름>…`, 스레드 `<서버> - <부모> - <스레드>…`, 부분 저장은 ` (부분)` 추가.
- ZIP: `<folderName>/Discord Export YYYY-MM-DD HHmm.zip`, 내부 구조는 v1 그대로(`서버/카테고리/채널.ext`, `Direct Messages/이름.ext`).
- 세그먼트마다 금지문자 `<>:"/\|?*`·제어문자·bidi 제거, 예약 이름(CON, PRN, AUX, NUL, COM1–9, LPT1–9, 확장자 포함) 앞에 `_`, 앞뒤 공백·점 제거, 앞 점 제거, `%`→`_`, 세그먼트 80자, 전체 180자 이하. `conflictAction: 'uniquify'`, `saveAs: false`.
6.7 증분(#14)·기록(#16)
- 항목이 `done`으로 끝날 때만 `lastExported[channelId] = 최대 메시지 ID` 갱신(`partial`은 갱신 안 함).
- `done` 항목은 목록에서 제거하고 기록에 추가. `partial/failed/cancelled`는 목록에 남기고 `lastResult` 기록.

## 7. UI 명세

7.1 행 버튼 (콘텐츠)
- 아이콘: 미담김 = 다운로드 화살표, 담김 = 체크. 네이티브 크기(16px)·색 그대로(클래스 복사). 아이콘은 직접 그린 단순 SVG(24×24 viewBox, `currentColor`).
- 툴팁(디스코드 모양, 위쪽 말풍선): "다운로드 목록에 추가" / "다운로드 목록에서 빼기". 카테고리: "이 카테고리 채널 전부 추가".
- 서버 헤더 버튼: 항상 보임, 초대 버튼 바로 왼쪽에 붙음(우리 span에 `margin-left:auto`), 네이티브 초대 버튼과 같은 모양·색·크기. 툴팁·아이콘은 체크 상태에 따라 "이 서버 채널 전부 추가"(⤓) / "이 서버 채널 전부 빼기"(✓). 클릭 → `queue/addGuild`, 토스트 "채널 N개를 추가했어요" / "채널 N개를 목록에서 뺐어요" / "이 서버에는 담을 채널이 없어요".
- 카테고리 버튼: 같은 규칙("이 카테고리 채널 전부 추가/빼기", ⤓/✓).
- 클릭·Enter·Space → `queue/toggle`(채널·DM) 또는 `queue/addCategory`(카테고리). `pointerdown/mousedown/mouseup/click/dragstart/keydown` 전파 차단 + 기본 동작 차단, `draggable=false`.
- 토스트(디스코드 모양, 화면 하단 중앙, 2.5초): "다운로드 목록에 추가했어요 · 공통 설정" / "목록에서 뺐어요" / "채널 N개를 추가했어요" / "디스코드 계정을 확인하는 중이에요. 잠시 후 다시 눌러 주세요"(no-account) / 기타 오류.
- (4차) 모든 행 버튼은 항상 보이므로 #17 옵션은 폐지(설정 화면에서 제거, 값은 무시).
- 표시 토글 꺼짐: 주입한 노드 전부 제거, 옵저버 해제.
- 단축키(#15) `add-current-chat`(기본 `Alt+Shift+D`): bg → `shortcut/toggleCurrent` → 보고 있는 채팅을 토글 + 토스트.
7.2 팝업 (폭 380px, 최대 높이 600px)
- 첫 실행(#11): 약관·위험 안내 화면 → [동의하고 시작]. 동의 전에는 다운로드 불가.
- 헤더: 아바타·표시 이름·@아이디, 우측 [기록] [설정] 아이콘.
- 배너: 디스코드 탭 없음(#4, [디스코드 열기]) / 계정 확인 중 / 로그인 만료(디스코드 새로고침 안내) / 주입 실패(디스코드 업데이트로 버튼을 못 붙임).
- 토글: "디스코드에 버튼 표시".
- 목록(#1~3, 5차 트리 §7.2a): 채널 줄 `#일반` / DM `친구`, 보조줄 = 유효 설정 요약 `200개 · HTML · 기간 없음 (· 첨부 · 스레드 · 새 메시지만)` + 설정 출처 배지("공통 설정" / "서버 설정" / "카테고리 설정" / "개별 설정"), 우측 ▶ ⚙ ✕. 진행 중엔 항목별 진행 바와 상태, 실패 항목은 사유 + [재시도]. 빈 목록 안내: "디스코드에서 채널이나 DM에 마우스를 올리고 ⤓ 버튼을 누르세요".
- ⚙ → 항목 편집 화면: 공통 설정 패널과 같은 필드(언어·ZIP 제외), 처음 열면 현재 유효 설정이 채워짐. [공통 설정으로 되돌리기](개별 설정일 때만) [취소] [저장]. 저장 = `queue/upsert`(settings 값), 되돌리기 = `queue/upsert`(settings null).
- 바닥: v1과 같은 분할 버튼 `⤓ 전체 다운로드 [HTML] ▾` + [목록 비우기]. ▾ = 공통 설정 패널(7.3). 진행 중: 전체 진행률 + [취소].
- 앱 설정 화면(헤더 ⚙): 폴더 이름, 파일명에 날짜, 시간대(auto/IANA), 완료 알림, 단축키 표시+[변경](`chrome://extensions/shortcuts`), 약관 안내 다시 보기.
- 기록 화면(#16): 최신순, 이름·시각·개수·상태, [폴더 열기] [다시 받기], [기록 지우기].
- 배지(#2): 대기 중 = 목록 개수(0이면 빈칸), 실행 중 = `완료/전체`(4자 넘으면 `%`), 끝난 뒤 실패가 있으면 빨간 `!`(팝업 열면 해제).
- 알림(#9): 끝나면 "다운로드 완료"/"일부 실패" + "채팅 n개 · 메시지 m개", 버튼 [폴더 열기].
7.2a 목록 트리 (5차, 순수 함수 `buildQueueTree`로 구현하고 단위 테스트)
- 입력: 현재 계정의 `QueueItem[]`, `LOCAL.groups`(이름·아이콘·사이드바 순서·"전체" 판정), `LOCAL.groupSettings`, 펼침 상태(`LOCAL.uiExpanded`).
- 구조: 최상위 = 서버 그룹(서버 줄) 또는 DM 항목(평평한 줄, 그룹·압축 없음). 서버 그룹 아래 = 카테고리 그룹 / 카테고리 없는 채널(서버 바로 아래). 카테고리 그룹 아래 = 채널. 스레드·포럼 항목은 다른 채널과 같은 방식으로 `categoryIdOf`에 따라 놓고, 모르면 서버 바로 아래.
- 정렬: 최상위는 노드 안 항목의 가장 이른 `addedAt`. 서버 아래는 `LOCAL.groups[guildId].channelIds`의 사이드바 순서(카테고리는 그 안 첫 채널 위치), 정보가 없으면 `addedAt`.
- 서버·카테고리 그룹은 기본 접힘, 줄을 클릭하면 펼침/접힘(▸/▾ + `aria-expanded`). 펼침 상태는 `LOCAL.uiExpanded`에 팝업이 직접 저장.
- 그룹 줄: ▸/▾ · 아이콘(서버 = `GroupInfo.iconUrl` 이미지, 없으면 서버 이름 첫 글자 원형 / 카테고리 = 폴더 아이콘) · 이름 · 개수 칩("전체 N개" = `isGroupComplete`, 아니면 "N개") · 설정 배지(그룹 설정이 있으면 "서버 설정"/"카테고리 설정", 없으면 "공통 설정"; 하위에 개별 설정이 있으면 "개별 N" 칩 추가) · ▶ ⚙ ✕. 접힌 서버 줄 보조줄에 하위 채널 이름 몇 개("#시험, #토익 …"). 작업 중에는 그룹 줄에 합산 진행(완료/전체 + 막대).
- 하위 표시: 왼쪽 세로 안내선(`--border-subtle`)과 들여쓰기(1단계 16px, 2단계 32px). 채널 줄은 지금과 같은 모양.
- 한 줄 압축: 서버 또는 카테고리 그룹에 담긴 채널이 1개뿐이고, 그 그룹이 "전체"가 아니고, 그룹 자체 설정(`groupSettings[id]`)이 없으면 그룹 줄을 만들지 않고 그 채널 줄에 경로를 붙인다. 서버가 압축되면 `[서버아이콘] 서버이름 › #채널`(카테고리는 생략, 툴팁에 전체 경로). 서버는 풀려 있고 카테고리만 압축되면 서버 아래에 `[폴더] 카테고리이름 › #채널`. 압축된 줄의 ▶ ⚙ ✕ 는 그 채널의 것(그룹 설정은 편집할 수 없음).
- 그룹 동작: ▶ = 그 그룹에 담긴 채널 전부 `job/start{keys}`. ✕ = 인라인 확인("채널 N개를 목록에서 뺄까요?") 후 `queue/removeMany{keys}`. ⚙ = 그룹 설정 편집 화면.
- 그룹 설정 편집 화면: 항목 편집과 같은 SettingsPanel(언어·ZIP 제외). 제목 "서버 설정 · 예시서버" / "카테고리 설정 · ACT", 부제 "채널 N개에 적용돼요". 저장 전에, 아래의 개별 설정(서버면 하위 카테고리 설정도) 개수 M이 1 이상이면 "아래 개별 설정 M개가 이 설정으로 바뀌어요" 안내를 보인다. [저장] → `queue/setGroupSettings{settings}`(bg가 그룹 설정을 저장하고 하위 개별 설정과 하위 카테고리 설정을 지움, 지운 개수 `cleared` 반환). [상위 설정으로 되돌리기](그룹 설정이 있을 때만) → `settings: null`(그룹 설정만 삭제, 하위 개별 설정은 유지).
- 채널 ⚙의 되돌리기 라벨은 실제 상위에 따라 "카테고리 설정으로 / 서버 설정으로 / 공통 설정으로 되돌리기"(`queue/upsert` settings null).
- 대량 다운로드 확인(6차, 팝업 `src/popup/downloadRisk.ts`): 시작 동작(전체 다운로드, 그룹 ▶, 채팅 ▶, [재시도])이 아래 중 하나라도 해당하면 바로 시작하지 않고 인라인 확인(`계속 받기`/`취소`)을 띄운다 — 채팅 10개 초과, 시작일 없이 개수 제한도 없는 채팅(전체 메시지), 요청 메시지 합계 20,000 초과, 스레드 포함 채팅이 있고 채팅이 3개 초과(텍스트 채널만 집계). 채팅 하나만 받을 때는 '전체 메시지' 이유만 해당. 기록의 [다시 받기]는 묻지 않음. 한 번에 확인창 하나만 열림.
- 구현 확정 사항: `queue/setGroupSettings`에서 `kind: "guild"`이면 `groupId`는 `guildId`와 같아야 한다(아니면 `invalid`). 담긴 채널이 없는 그룹에 설정(non-null)을 저장하면 `empty`, `settings: null`은 항상 허용(정리만 하고 `cleared: 0`). 그룹 정보를 다시 기록할 때(채널이 다른 카테고리로 옮겨지거나 카테고리가 삭제된 경우)도 bg가 빈 그룹의 설정을 정리한다. 팝업은 서버·카테고리 줄 아래에 실패·부분·취소 항목이 있으면 접힌 상태에서도 "미완료 N" 칩으로 알리고, 진행 중 합산은 이미 목록에서 빠진 완료 항목도 센다.
- bg는 항목을 빼는 모든 경로(`queue/remove`, `queue/removeMany`, `queue/clear`, 성공한 항목 자동 제거, 콘텐츠 토글·카테고리·서버 제거)에서 `pruneGroupSettings`로 빈 그룹의 설정을 정리한다.
- 그룹 이름·아이콘: bg가 `queue/groupInfo`·`queue/addGuild`·`queue/addCategory` 처리 때 `GroupInfo.name`(서버 이름 / 카테고리 이름)과 `iconUrl`(`https://cdn.discordapp.com/icons/<서버id>/<hash>.png?size=64`, 애니메이션 해시 `a_`도 png로 요청, 아이콘 없으면 null)을 함께 기록한다.

7.3 공통 설정 패널 (사용자 제공 v1 옵션 창 디자인 재사용, 바뀌면 즉시 저장)
- 형식: 카드 6개(선택 카드 강조 + 체크): HTML "디스코드처럼 보이는 파일 · 읽기에 가장 좋아요 (권장)", TXT "일반 텍스트", Markdown "Notion · Obsidian · GitHub용", Excel (.xlsx) "Excel · 정렬하고 필터링", CSV "스프레드시트 · 데이터 분석용", JSON "프로그램용 전체 원본 데이터".
- HTML 테마: [다크][라이트] (HTML일 때만).
- 메시지 개수: 숫자(기본 200) + "전체".
- 기간: 시작일·종료일(`date`, 각각 지우기). "비워 두면 전체 기간을 내보내요." 개수와 같이 쓰면 "기간 안에서 최신 N개" 안내.
- 더보기: 첨부파일 함께 저장, 스레드 포함(요청이 많아진다는 경고), 새 메시지만(지난번 이후; 개수 제한과 같이 쓰면 사이가 빌 수 있다는 안내), 봇 메시지·시스템 메시지·반응·임베드 포함.
- 언어: [자동][한국어][English] — "앱 화면과 내보낸 파일 안의 고정 문구(항목 이름, 시스템 메시지 등) 언어가 함께 바뀌어요. 자동은 디스코드/브라우저 언어를 따라요."
- "ZIP 하나로 받기" 체크 — "체크하면 여러 채팅을 ZIP 파일 하나로 저장해요."
- 검증: 개수 1..1,000,000 정수, 시작 ≤ 종료.
7.4 테마·언어
- 콘텐츠가 §4 변수와 테마 클래스를 `dce.theme`에 저장 → 팝업이 CSS 변수로 적용(폴백: 디스코드 다크 팔레트).
- 언어(#18): 'auto'면 `dce.theme.lang` → 없으면 `chrome.i18n.getUILanguage()`. ko/en 문자열은 v1 `defineStrings` 방식(키 동등성 컴파일 검사). 내보낸 파일 문구도 같은 언어. 콘텐츠의 툴팁·토스트도 같은 규칙.

## 8. 보안·개인정보
- 인증 값은 `storage.session`(bg)과 엔진 메모리에만. 로그·에러 메시지·`storage.local`·파일에 절대 남기지 않는다(v1 redaction 유지).
- 엔진의 API 클라이언트는 허용 목록 경로만 호출(`TRANSPORT_ALLOWLIST` = HTTP 전송 계층 허용 목록): `^/api/v9/(users/@me|users/@me/guilds/\d+/member|channels/\d+(/messages|/threads/search|/threads/archived/public)?|guilds/\d+(/channels|/roles|/members/@me)?|attachments/refresh-urls)(\?.*)?$`, 메서드는 GET (POST는 `attachments/refresh-urls`만). bg의 직접 GET(`API_GET_ALLOWLIST`)은 `users/@me`, `channels/\d+`, `guilds/\d+`, `guilds/\d+/channels`, `guilds/\d+/roles`, `users/@me/guilds/\d+/member`, `guilds/\d+/members/@me`만.
- 메시지 발신자 검사: bg는 `sender.id === chrome.runtime.id`, 콘텐츠 발신은 `sender.url`이 디스코드 출처이고 `sender.tab`이 있는지 확인. 콘텐츠가 보낼 수 있는 메시지는 `queue/toggle`, `queue/addCategory`, `queue/addGuild`, `queue/groupInfo`, `inject/health`뿐.
- 원격 코드·분석·외부 전송 없음. 모든 라이브러리 로컬 번들. 클라이언트 헤더 위조 안 함(v1 원칙 유지).

## 9. 빌드·구조·개발 루프
```
src/
  manifest.ts      매니페스트 생성(dev/prod 분기)
  shared/          계약(§5)
  lib/             v1 코어 이식 + 확장 (discord/, export/, markdown/, message/)
  background/      SW
  offscreen/       offscreen.html + 엔진
  content/         콘텐츠 스크립트 (+ styles.css 인라인)
  ui/              공용 React(설정 패널, 컴포넌트, i18n, 테마)
  popup/           popup.html
tests/             src 구조 그대로
scripts/           generate-icons, verify-dist, pack, dev-server
```
- 스택: v1과 동일(Vite 8 + Rolldown, TypeScript 7 strict, React 19, zustand 5, fflate 0.8, Vitest 5 + jsdom). 새 런타임 의존성은 메인 에이전트 승인 없이 추가 금지.
- 출력: `dist/` = `manifest.json`, `background.js`(ES module 1파일), `content.js`(IIFE 1파일, CSS 인라인), `popup.html`, `offscreen.html` + 해시 자산, `icons/`, `_locales/{ko,en}`.
- 매니페스트: MV3, `default_locale: "ko"`, `minimum_chrome_version: "120"`, permissions `storage, webRequest, downloads, offscreen, notifications`, host_permissions `https://discord.com/*, https://ptb.discord.com/*, https://canary.discord.com/*, https://discordapp.com/*, https://cdn.discordapp.com/*, https://media.discordapp.net/*`(+dev: `http://localhost:5858/*`), content_scripts(디스코드 3개 출처, `document_idle`, top frame), `action.default_popup`, `commands.add-current-chat`(Alt+Shift+D), CSP `script-src 'self'; object-src 'self'` + `img-src 'self' data: blob: https://cdn.discordapp.com https://media.discordapp.net` + `connect-src 'self' https://discord.com https://*.discord.com https://cdn.discordapp.com https://media.discordapp.net`(+dev localhost). `web_accessible_resources` 없음.
- 개발 루프: `npm run dev` = 감시 빌드 + `scripts/dev-server.mjs`(포트 5858, `GET /build-id`). dev-server는 빌드 파일이 모두 있고 1.5초 조용해질 때까지 503. dev 빌드의 bg는 새 build-id가 2.5초 간격으로 두 번 연속 200일 때만, 그리고 직전 새로고침 후 20초가 지났을 때만(그 전 변경은 하나로 합침) 열린 디스코드 탭 ID를 `storage.local`에 적고 `chrome.runtime.reload()` → 재시작 시 그 탭들을 새로고침. prod 빌드에는 포함되지 않는다.

## 10. 테스트
- 단위: v1 lib 테스트 이식 + 신규(수집기 6.1 경계, 파일명, 필터, 첨부 맵, 스레드 페이징, 허용 목록, 큐 저장소·토글·카테고리 추가, 유효 설정 확정, 메시지 라우팅, DOM 주입은 §4 구조로 만든 jsdom 픽스처).
- `npm run typecheck`, `npm test`, `npm run build`, `npm run verify` 전부 통과가 각 단계 완료 조건.
- 실계정 QA는 개발자가 Claude in Chrome 등으로 직접. **그 세션에 개발자가 지정한 서버·DM만 사용하고, 다른 서버·DM은 열지도 읽지도 않는다.** 인증 값은 절대 읽지 않는다. 테스트 픽스처에는 실제 이름 대신 중립 이름을 쓴다.

## 11. 단계·담당 (메인 = Opus, 구현 = Sonnet 서브에이전트)

| 단계 | 내용 | 담당 | 선행 |
|---|---|---|---|
| P1a | 스캐폴드: git, 패키지, 빌드, 매니페스트, 계약 파일(§5), 엔트리 골격, 아이콘, 스크립트, dev 리로드, CLAUDE.md | Sonnet | — (완료) |
| P1a′ | 2차 변경 반영: 모달 페이지·프로토콜 제거, 계약·기본값·매니페스트·빌드·테스트 갱신 | Sonnet | P1a |
| P1b | v1 lib 이식 + 버그 수정 + HTTP 전송 계층 주입 + 수집기·필터·첨부 맵·스레드·refresh-urls·파일명 확장 | Sonnet | P1a′ |
| A1 | 백그라운드 SW 전체 + 오프스크린 골격(메시징, blob URL, 저장 요청) | Sonnet | P1a′ |
| B | 콘텐츠 스크립트 전체 (API 호출 없음) | Sonnet | P1a′ |
| C | 팝업·공용 UI(공통 설정 패널, 항목 편집)·i18n·목업 미리보기 | Sonnet | P1a′ |
| A2 | 오프스크린 엔진 파이프라인(lib 연결, 진행률, 부분 저장, ZIP, 첨부, 스레드, 기록·증분 보고) | Sonnet | P1b, A1 |
| B2 | 서버 헤더 버튼(콘텐츠) | Sonnet | B |
| A1b | `queue/addGuild` + 카테고리·서버 추가의 권한 필터(bg, lib permissions 사용) | Sonnet | P1b, A1 |
| 5차 | A1d bg(그룹 설정 저장·정리, `queue/setGroupSettings`·`queue/removeMany`, 유효 설정 확정, GroupInfo 이름·아이콘), C3 팝업(트리 UI, 그룹 설정 화면, 한 줄 압축) | Sonnet(워크플로우) | 4차 |
| 4차 | B3 콘텐츠(항상 표시·맨 오른쪽·서버 버튼 정렬·그룹 체크), A1c bg(카테고리·서버 토글, `LOCAL.groups`, `queue/groupInfo`), C2 팝업(브랜드 버튼 글자색 `--white`, #17 제거) | Sonnet(워크플로우) | A2 |
| P3 | 통합·빌드·테스트 정리 | 메인 + Sonnet | 전부 |
| P4 | 실계정 QA(지정한 서버·DM만) + 수정 | 메인 + Sonnet | P3, 사용자의 압축해제 로드 1회 |
| P5 | README·패키징 | Sonnet | P4 |

P1b·A1·B·C는 병렬(각자 git worktree). 디렉터리 소유: P1b=`src/lib, tests/lib`, A1=`src/background, src/offscreen, tests/background, tests/offscreen`, B=`src/content, tests/content`, C=`src/ui, src/popup, tests/ui, tests/popup`. 공유 파일(`src/shared`, `package.json`, `vite.config.ts`, `src/manifest.ts`, `scripts`, `public`, `docs`)은 메인(또는 메인이 지시한 P1a′)만 수정.
