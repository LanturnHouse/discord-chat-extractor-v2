# 개인정보처리방침 - 디스코드 채팅 추출기 v2

**한국어** | [English](#privacy-policy---discord-chat-extractor-v2-english)

- 시행일: 2026-10-08
- 적용 대상: 크롬 확장 프로그램 "디스코드 채팅 추출기 v2" (Discord Chat Extractor v2) 버전 2.0.1 이상
- 개발·배포: LanturnHouse (오픈소스, MIT 라이선스) - https://github.com/LanturnHouse/discord-chat-extractor-v2

---

## 1. 이 확장 프로그램은 무엇인가요

디스코드 웹 클라이언트(discord.com)에서 사용자가 고른 채널·DM의 채팅 기록을 **사용자의 컴퓨터에 파일로 저장**하는 크롬 확장 프로그램이에요. 사용자가 이미 로그인한 디스코드 계정으로 볼 수 있는 대화만 저장해요.

**비공식 도구입니다.** Discord Inc.와 제휴·후원·승인 관계가 없어요. "Discord"는 해당 회사의 상표예요.

## 2. 한눈에 보기

- 개발자의 서버가 **없어요.** 이 확장 프로그램은 사용자의 정보를 개발자에게 보내지 않고, 개발자는 사용자의 정보를 받거나 볼 수 없어요.
- 분석 도구, 광고, 추적, 원격 코드가 **없어요.** 모든 코드는 확장 프로그램 안에 들어 있고 소스가 공개되어 있어요.
- 디스코드 **로그인 토큰**(디스코드 웹 페이지가 요청에 붙이는 Authorization 값)을 읽어서 사용자의 계정으로 채팅을 불러와요. 토큰은 디스크에 쓰지 않고 **메모리에만** 두며, `discord.com` 요청 외에는 어디로도 보내지 않아요. 첫 실행 안내에서 **동의하기 전에는 읽지도 않아요**(5항).
- 채팅 내용은 **파일로만** 저장돼요. 확장 프로그램의 저장소에는 메시지를 저장하지 않아요.
- 정보를 팔지 않고, 사용자의 계정으로 디스코드에 보내는 요청 외에는 누구에게도 넘기지 않으며, 광고·신용 판단 등 다른 목적에 쓰지 않아요.
- 이 확장 프로그램을 쓰면 **디스코드 계정이 경고를 받거나 제한·정지될 수 있어요**(9항).

## 3. 다루는 정보와 쓰임

"다룬다"는 읽거나 잠깐이라도 보관하거나 사용하는 것을 모두 뜻해요. 아래 표가 이 확장 프로그램이 읽거나 저장하는 정보의 전부예요. (저장소 항목의 전체 목록은 소스 코드 `src/shared/storageKeys.ts`와 `src/background/store.ts`에서 볼 수 있어요.)

| 정보 | 어디서 얻나요 | 어디에 두나요 | 무엇에 쓰나요 | 얼마나 보관하나요 |
|---|---|---|---|---|
| **로그인 토큰** (디스코드 웹 페이지가 `discord.com`·`ptb.discord.com`·`canary.discord.com`의 `/api/` 로 보내는 요청의 `Authorization` 헤더 값)과 읽은 시각 | **동의한 뒤에만**, 크롬 `webRequest`로 헤더를 **읽기만** 해요(요청을 막거나 바꾸지 않아요). 디스코드 웹 페이지가 보낸 요청에서만 읽고, `Authorization` 외의 헤더는 쓰지도 저장하지도 않아요(쿠키 헤더는 크롬이 이 기능에 아예 주지 않아요). | 메모리 전용 저장소(`chrome.storage.session`). 이와 함께 확장 프로그램 자신의 백그라운드 작업자의 메모리에, 다운로드 중에는 작업을 실행하는 보이지 않는 문서의 메모리에도 있어요. 디스크에는 쓰이지 않아요. | 사용자의 계정으로 디스코드 API에 요청을 보내는 데만 써요(계정 확인, 서버 정보 읽기, 다운로드). | 크롬을 끄거나 확장 프로그램을 새로고침·업데이트·끄면 사라져요. 디스코드가 값을 거부(401)하면 바로 지워요. |
| **계정 정보**: 디스코드 사용자 ID, 사용자 이름, 표시 이름, 프로필 사진 주소 | 계정 확인 요청(`/users/@me`)의 응답 | 메모리 전용 저장소와 확장 프로그램 저장소(`chrome.storage.local`)의 "마지막으로 확인한 계정" | 지금 어느 계정인지 확인하고, 다운로드 목록·기록을 계정별로 나누고, 팝업에 보여 주는 데 써요. | 확장 프로그램을 삭제하기 전까지(저장소) |
| **채팅 내용**: 메시지 본문, 작성자 이름·ID, 첨부파일, 반응, 임베드, 스티커, 투표, 채널·서버 이름 등 | 사용자가 담은 채널·DM에서 디스코드 API(`discord.com`)로 읽어요. 첨부파일·이미지는 디스코드 CDN에서 받아요. | 처리하는 동안 메모리에만 있다가 **다운로드 폴더의 파일**로 저장돼요. 확장 프로그램 저장소에는 저장하지 않아요. | 사용자가 요청한 채팅 파일(TXT·HTML·Markdown·Excel·CSV·JSON·ZIP)을 만드는 데만 써요. | 파일은 사용자가 지울 때까지 사용자의 컴퓨터에 남아요. |
| **다운로드 목록**: 담은 채널·DM의 ID와 이름, 서버·카테고리 이름, 서버 아이콘 주소 또는 DM·그룹 DM 프로필 사진 주소, 채팅별 설정, 서버·카테고리 단위 설정, 마지막 결과(성공·실패 문구) | 사용자가 다운로드 버튼으로 담은 항목, 그리고 디스코드 페이지에 보이는 서버·채널 이름·ID와 프로필 사진 주소 | `chrome.storage.local` (계정별) | 팝업의 다운로드 목록을 보여 주고, 무엇을 어떤 설정으로 받을지 정하는 데 써요. | 사용자가 빼거나 [목록 비우기]를 누르거나 다운로드가 성공해 목록에서 빠질 때까지(실패한 항목은 남아요. 서버·카테고리 단위 설정은 그 서버·카테고리의 항목이 모두 빠질 때까지), 또는 확장 프로그램을 삭제할 때까지 |
| **열어 본 서버 정보**: 서버·카테고리 이름, 서버 아이콘 주소, 내 계정이 읽을 수 있는 채널 ID 목록, 기록한 시각 | 디스코드 웹 페이지에 보이는 서버 이름, 그리고 서버 정보 응답(`discord.com`). 버튼 표시가 켜져 있을 때 서버 화면을 열거나 카테고리·서버 버튼을 누르면 만들어져요. **목록에 아무것도 담지 않아도** 생겨요. | `chrome.storage.local` (계정별) | 카테고리·서버 버튼의 ✓ 표시를 계산하고, 팝업 목록에 서버·카테고리 이름과 아이콘을 보여 주는 데 써요. | **확장 프로그램을 삭제할 때까지.** 목록에서 빼거나 [목록 비우기]를 눌러도 지워지지 않아요(같은 서버를 다시 열면 그 서버의 기록만 새로 덮어써요). |
| **다운로드 기록**: 채팅 이름, 시각, 상태, 메시지 개수, 저장된 파일 이름, 적용된 설정, 오류 문구 (계정별 최대 200개) | 확장 프로그램이 만들어요. | `chrome.storage.local` | 기록 화면, 다시 받기, 폴더 열기에 써요. | [기록 지우기]를 누르거나 확장 프로그램을 삭제할 때까지 |
| **"새 메시지만 받기"용 마지막 메시지 ID** (채널별) | 마지막으로 성공한 다운로드에서 | `chrome.storage.local` | 지난번 이후의 메시지만 받는 데 써요. | 확장 프로그램을 삭제할 때까지(따로 지우는 버튼은 없어요) |
| **설정**: 형식·개수·기간·폴더 이름·시간대·언어·알림·버튼 표시, 첫 실행 안내에 동의한 시각, 팝업 목록에서 펼쳐 둔 서버·카테고리 | 사용자가 정한 값 | `chrome.storage.local` | 확장 프로그램을 사용자가 원하는 대로 동작시키는 데 써요. | 확장 프로그램을 삭제할 때까지 |
| **작업 상태**: 진행 중이거나 방금 끝난 다운로드의 채팅 이름(예: 서버 > #채널), 진행률, 저장된 파일 경로, 오류 문구, 다운로드 번호, 임시 파일(blob) 주소 | 확장 프로그램이 만들어요. | 메모리 전용 저장소 | 팝업의 진행 화면, 완료 알림, 임시 파일 정리에 써요. | 크롬을 끄거나 확장 프로그램을 새로고침·업데이트·끌 때까지 |
| **디스코드 화면 모양 값**: 테마 색상·언어, 버튼을 어울리게 그리려고 읽은 화면 클래스 이름 | 디스코드 웹 페이지의 화면(색상 값과 클래스 이름만) | `chrome.storage.local` | 팝업과 다운로드 버튼이 디스코드 화면과 비슷하게 보이게 해요. | 확장 프로그램을 삭제할 때까지 |
| **열린 디스코드 탭 상태**: 탭 번호, 버튼이 붙었는지 여부와 그 이유 문구, 보고한 시각 (탭 주소는 저장하지 않아요) | 콘텐츠 스크립트가 알려 줘요. | 메모리 전용 저장소 | 팝업에 버튼 상태를 알려 주는 데 써요. | 탭을 닫거나 크롬을 끌 때까지 |

- 콘텐츠 스크립트(디스코드 페이지에 버튼을 넣는 코드)는 디스코드 페이지의 **메시지 본문, 쿠키, 비밀번호, 로그인 토큰을 읽지 않아요.** 읽는 것은 서버·채널·DM의 이름과 ID, DM·그룹 DM 줄에 보이는 프로필 사진 주소, 현재 화면 주소와 탭 제목(서버·채널을 알아내는 데만 쓰고 저장하지 않아요), 테마 값과 클래스 이름이에요. 메시지는 화면에서 긁지 않고 디스코드 API에서 받아요. 콘텐츠 스크립트는 메모리 전용 저장소를 읽을 수 없어서 토큰에 접근할 수 없어요.
- 크롬에 이미 저장된 비밀번호·쿠키·방문 기록·북마크는 읽지 않아요. 다른 사이트의 주소도 읽지 않아요(권한이 없어요).
- 키 입력, 클릭, 스크롤, 마우스 위치를 기록하지 않아요.

## 4. 정보가 가는 곳

| 대상 | 무엇을 보내나요 | 왜 |
|---|---|---|
| **`discord.com`** (디스코드 API, HTTPS) | 로그인 토큰이 붙은 **읽기 요청**: 계정 확인, 채널·서버 정보, 권한 계산에 필요한 서버의 역할과 내 멤버 정보, 메시지, 스레드 검색. 쓰기 요청은 **첨부파일 링크 새로 받기** 한 가지뿐이에요. 메시지 보내기·수정·삭제, 반응 달기 같은 일은 하지 않아요. 요청은 쿠키 없이 보내고, 다른 주소로 넘어가는 응답(리다이렉트)은 오류로 처리해요. | 사용자의 계정으로 채팅을 불러오려고요. |
| **`cdn.discordapp.com`, `media.discordapp.net`** (디스코드 CDN) | 로그인 토큰을 **붙이지 않고** 첨부파일·이미지·프로필 사진을 내려받아요(첨부파일 저장은 크롬의 다운로드 기능이 처리해서, 크롬이 그 주소에 원래 보내는 쿠키가 따라갈 수 있어요). | 첨부파일 저장, 팝업의 프로필 사진·서버 아이콘 표시 |
| **사용자의 컴퓨터** | 만든 파일을 크롬 `downloads` API로 다운로드 폴더(기본 `Discord Export` 폴더)에 저장해요. | 결과 파일 저장 |
| **그 밖의 모든 곳** | **아무것도 보내지 않아요.** 개발자의 서버, 분석·통계 서비스, 광고 서비스, 원격 코드 서버가 없어요. | - |

- 디스코드가 위 요청으로 받은 정보를 어떻게 다루는지는 디스코드의 개인정보처리방침과 이용약관을 따라요. 이 확장 프로그램의 요청은 사용자의 브라우저에서 사용자의 계정으로 직접 나가요.
- 내보낸 **HTML 파일**을 열면 브라우저가 프로필 사진·이미지를 디스코드 서버 주소에서 불러와요(첨부파일을 함께 저장했다면 그 첨부는 컴퓨터에서 열려요). HTML 파일에는 스크립트가 들어 있지 않아요.
- 크롬 웹 스토어와 GitHub(소스 코드 사이트)는 이 확장 프로그램을 내려받는 곳일 뿐이에요. 확장 프로그램이 실행되면서 그곳으로 정보를 보내지 않아요.

## 5. 동의하기 전에는 아무것도 읽지 않아요

확장 프로그램을 처음 열면 이용약관과 위험, 그리고 **로그인 토큰을 읽는다는 사실**을 알리는 안내 화면이 나와요. [동의하고 시작]을 누르기 **전에는** 아래 일을 **하지 않아요.**

1. 디스코드 웹 페이지가 보내는 요청의 헤더(로그인 토큰 포함)를 열어 보지 않아요. 크롬에 요청을 지켜보는 기능이 등록되어 있어도, 동의 전에는 그 요청을 읽지 않고 바로 넘겨요.
2. `discord.com`에 요청을 하나도 보내지 않아요(계정 확인, 서버 정보 읽기, 메시지 읽기 모두).
3. 계정 정보와 서버·카테고리 정보를 저장하지 않아요. 디스코드 화면에 다운로드 버튼은 보일 수 있지만, 눌러도 "안내를 먼저 확인해 주세요"라는 문구만 나오고 아무것도 담기지 않아요. (버튼을 어울리게 그리려는 화면 모양 값과 버튼 상태 보고는 동의 전에도 다뤄요. 3항 마지막 두 행이고 개인 정보가 아니에요.)

**[동의하고 시작]을 누르면** 아래 동작이 시작돼요. 동의한 뒤 디스코드 웹 페이지가 보내는 다음 요청에서 바로 토큰이 읽혀서, 보통 몇 초 안에 계정이 표시돼요.

1. 디스코드 웹 페이지가 보내는 요청에서 **로그인 토큰을 읽어 메모리에 둬요**(`Authorization` 외의 헤더는 쓰지 않아요).
2. 어느 계정인지 확인하려고 `discord.com`에 요청(`/users/@me`)을 보내고, 응답의 계정 정보(ID·이름·프로필 사진 주소)를 저장해요. 새 로그인 토큰이 잡힐 때, 그리고 팝업을 열거나 확장 프로그램의 작업자가 다시 시작됐는데 확인된 계정이 아직 없을 때 필요하면 다시 보내요(같은 토큰은 10분, 거부된 토큰은 1분 동안 다시 묻지 않아요).
3. 서버 화면을 열면(버튼 표시가 켜져 있을 때) 카테고리·서버 버튼의 ✓ 표시를 계산하려고 그 서버의 **채널 목록·역할·내 멤버 정보**를 읽는 요청을 보내요(읽기 요청만, 같은 서버는 탭마다 약 5분에 한 번 꼴). 카테고리·서버 버튼을 누를 때도 같은 읽기 요청이 나가요. 이때 서버·카테고리 이름과 읽을 수 있는 채널 ID 목록이 저장돼요(3항 "열어 본 서버 정보").

3번의 요청이 싫다면 팝업에서 "디스코드에 버튼 표시"를 끄고 단축키(`Alt+Shift+D`)로 채팅을 담으세요. 1·2번은 확장 프로그램을 쓰는 동안 계속 필요해서 끌 수 없어요. 원하지 않으면 확장 프로그램을 끄거나 삭제하세요. 동의 기록이 지워지면(예: 확장 프로그램의 저장 데이터를 지울 때) 토큰과 계정도 바로 지워요.

## 6. 보관 기간과 삭제 방법

| 하고 싶은 일 | 방법 |
|---|---|
| 로그인 토큰 지우기 | 크롬을 끄거나, `chrome://extensions`에서 확장 프로그램을 끄거나 새로고침하세요. 메모리에만 있어서 그러면 사라져요. |
| 다운로드 목록 지우기 | 팝업의 [목록 비우기] 또는 줄마다 [빼기] |
| 다운로드 기록 지우기 | 기록 화면의 [기록 지우기] (저장된 파일은 지워지지 않아요) |
| 열어 본 서버 정보 지우기 | 따로 지우는 버튼이 없어요. 확장 프로그램을 삭제하면 함께 지워져요. 팝업에서 "디스코드에 버튼 표시"를 끄면 새로 쌓이지 않아요. |
| **확장 프로그램이 저장한 모든 데이터 지우기** | `chrome://extensions`에서 **확장 프로그램을 삭제**하세요. 설정·목록·기록·마지막 메시지 ID·계정 정보·열어 본 서버 정보가 함께 지워져요. |
| 이미 저장한 채팅 파일 지우기 | 자동으로 지워지지 않아요. 다운로드 폴더의 `Discord Export` 폴더(설정한 폴더 이름)를 직접 지우세요. |

개발자는 사용자의 정보를 갖고 있지 않아서 개발자 쪽에서 지울 데이터가 없어요.

## 7. 보안

- 로그인 토큰은 디스크에 쓰지 않고 `chrome.storage.session`(메모리 전용)과 확장 프로그램 자신의 작업 메모리에만 두며, 파일·기록·오류 메시지·로그에 남기지 않아요. 디스코드 페이지에 넣는 코드와 팝업은 토큰을 읽지 않아요.
- 토큰은 `discord.com/api` 아래 주소로 가는 요청에만 붙여요. 요청 주소는 허용 목록(계정, 채널·메시지, 서버·역할·내 멤버 정보, 스레드 검색, 첨부파일 링크 갱신)에 있는 것만 보내고, 쿠키는 보내지 않아요.
- 확장 프로그램 페이지의 콘텐츠 보안 정책은 외부 스크립트를 막고(`script-src 'self'`), 통신 대상을 디스코드 주소로 제한해요.
- 파일을 저장할 때 파일 이름은 안전한 상대 경로인지 다시 검사하고, 첨부파일은 디스코드 CDN 주소만 받아요.

그래도 컴퓨터를 다른 사람과 같이 쓰거나 저장한 채팅 파일이 민감하다면, 파일을 안전한 곳에 보관하고 다 쓴 뒤 지우세요. 파일 속 대화에는 다른 사람의 메시지와 개인정보가 들어 있을 수 있어요.

## 8. 판매·제공 없음, 사람의 열람 없음

- 사용자 정보를 **판매하거나 제3자에게 제공·이전하지 않아요.** 정보는 사용자의 계정으로 디스코드에 보내는 요청과 사용자의 컴퓨터 안의 파일·저장소 밖으로 나가지 않아요.
- 정보를 광고, 개인 맞춤 광고, 신용도 판단, 대출 심사, 데이터 중개 등에 쓰지 않아요.
- 개발자나 다른 사람이 사용자의 정보를 읽을 수단이 없어요(받는 서버가 없어요).

## 9. 디스코드 이용약관과 계정 위험

디스코드 이용약관은 사용자 계정을 자동화된 방식으로 쓰는 것을 허용하지 않아요. 이 확장 프로그램은 사용자의 로그인 정보로 사용자를 대신해 메시지를 요청하므로 여기에 해당할 수 있어요. **디스코드 계정이 경고를 받거나 제한·정지될 수 있고, 그 위험은 사용자 본인이 감수해야 해요.** 이 확장 프로그램이 안전하다거나 디스코드가 허용한다고 보증하지 않아요.

- 내 계정의 대화를 **개인 기록으로 보관하는 용도로만** 쓰고, 다른 사람의 대화와 개인정보를 허락 없이 공개하거나 퍼뜨리지 마세요.
- 많이 받을수록 위험이 커져요. 필요한 채팅만, 개수·기간·"새 메시지만 받기"로 줄여서 받으세요. 요청은 위험을 줄이려고 천천히 보내지만(메시지 요청 사이 약 0.7~1.5초, 채팅 사이 약 2~4초) 위험이 없어지지는 않아요.
- 잃으면 곤란한 계정이라면 쓰지 않기를 권해요.

## 10. 어린이

이 확장 프로그램은 어린이를 대상으로 하지 않아요. 어린이의 정보를 따로 모으지도 않아요. 확장 프로그램이 다루는 정보는 3항이 전부이고, 연령 제한은 디스코드의 이용약관을 따라요.

## 11. Chrome 웹 스토어 사용자 데이터 정책 (제한적 사용)

이 확장 프로그램이 받는 정보의 사용과 다른 곳으로의 전달은 **제한적 사용(Limited Use) 요건을 포함해 Chrome 웹 스토어 사용자 데이터 정책을 따릅니다.** 구체적으로 사용자 데이터는 (1) 사용자가 요청한 채팅 파일 저장이라는 이 확장 프로그램의 단일 목적을 제공하거나 개선하는 데만 쓰고, (2) 광고 플랫폼·데이터 중개인·정보 재판매업자에게 판매하거나 넘기지 않으며, (3) 신용도 판단이나 대출 목적에 쓰지 않고, (4) 사람이 읽지 않아요(개발자는 데이터를 받지 않아요). (5) 사용자 데이터가 디스코드로 전송되는 경우는 사용자가 요청한 채팅 저장이라는 단일 목적을 제공하는 데 필요한 요청에 한정돼요.

## 12. 방침 변경

이 문서를 바꾸면 위의 시행일을 고치고, 변경 내용은 저장소의 변경 기록(커밋 내역)에 남아요. 데이터를 다루는 방식이 달라지는 새 버전(예: 서버 도입, 분석 도구, 새로운 종류의 정보)은 그 버전을 내기 **전에** 이 방침과 크롬 웹 스토어 설명에 먼저 알리고, 필요한 동의를 다시 받아요.

## 13. 문의

질문, 오류 신고, 개인정보 관련 문의는 GitHub Issues에 남겨 주세요.

- https://github.com/LanturnHouse/discord-chat-extractor-v2/issues

이슈는 **누구나 볼 수 있는 곳**이에요. **로그인 토큰, 비밀번호, 개인정보, 다른 사람의 대화 내용은 절대 올리지 마세요**(문제를 찾는 데 필요하지 않아요).

---
---

# Privacy Policy - Discord Chat Extractor v2 (English)

[한국어](#개인정보처리방침---디스코드-채팅-추출기-v2) | **English**

- Effective date: 2026-10-08
- Applies to: the Chrome extension "Discord Chat Extractor v2" (Korean name: 디스코드 채팅 추출기 v2), version 2.0.1 and later
- Developer / publisher: LanturnHouse (open source, MIT License) - https://github.com/LanturnHouse/discord-chat-extractor-v2

---

## 1. What this extension is

A Chrome extension that **saves the chat history of the channels and DMs you pick on the Discord web client (discord.com) as files on your own computer.** It only saves conversations that the Discord account you are already signed in with can see.

**It is an unofficial tool.** It is not affiliated with, sponsored by or approved by Discord Inc. "Discord" is a trademark of its owner.

## 2. At a glance

- There is **no developer server.** The extension does not send your information to the developer, and the developer cannot receive or see it.
- There are **no analytics, ads, tracking or remote code.** All code is inside the extension and the source is public.
- It reads your Discord **login token** (the Authorization value the Discord web page attaches to its requests) and uses it to load chats with your account. The token is never written to disk and is kept **in memory only.** It is sent only to `discord.com` requests, nowhere else, and it is **not even read before you agree** on the first-run notice (Section 5).
- Chat content is saved **only as files.** The extension's storage does not keep messages.
- Your information is not sold, is not given to anyone except in the requests your account sends to Discord, and is not used for ads, credit decisions or any other purpose.
- Using this extension **can get your Discord account warned, restricted or banned** (Section 9).

## 3. Information handled and what it is used for

"Handled" means read, kept even briefly, or used. The table below is the complete list of what this extension reads or stores. (The full list of storage entries is in the source code: `src/shared/storageKeys.ts` and `src/background/store.ts`.)

| Information | Where it comes from | Where it is kept | What it is used for | How long it is kept |
|---|---|---|---|---|
| **Login token** (the `Authorization` header value of requests the Discord web page sends to `/api/` on `discord.com`, `ptb.discord.com` and `canary.discord.com`) and the time it was read | **Only after you agree**, through Chrome's `webRequest` API, which **only observes** the header (it does not block or change the request). Read only from requests sent by a Discord web page; headers other than `Authorization` are neither used nor stored (Chrome does not offer cookie headers to this feature at all). | Memory-only storage (`chrome.storage.session`). It is also in the memory of the extension's own background worker and, during a download, of the hidden document that runs the job. It is never written to disk. | Only to send requests to the Discord API as your account (account check, server information, downloads). | Gone when Chrome is closed or the extension is reloaded, updated or disabled. Removed at once if Discord rejects it (401). |
| **Account info:** Discord user ID, username, display name, avatar URL | The answer to the account check request (`/users/@me`) | Memory-only storage, and the "last verified account" in the extension storage (`chrome.storage.local`) | To know which account is in use, to keep the download list and history separate per account, and to show it in the popup. | Until you remove the extension (storage) |
| **Chat content:** message text, author names and IDs, attachments, reactions, embeds, stickers, polls, channel and server names, etc. | Read from the channels and DMs you added, through the Discord API (`discord.com`). Attachments and images come from Discord's CDN. | In memory while processing, then saved as **files in your download folder.** Not saved in the extension storage. | Only to build the chat files you asked for (TXT, HTML, Markdown, Excel, CSV, JSON, ZIP). | The files stay on your computer until you delete them. |
| **Download list:** IDs and names of the chats you added, server and category names, server icon URLs or DM and group DM avatar URLs, per-chat settings, server- and category-level settings, the last result (success or failure text) | Items you added with the download button; server and channel names, IDs and avatar URLs shown on the Discord page | `chrome.storage.local` (per account) | To show the popup's download list and decide what to download and with which settings. | Until you remove the items, press "clear list", or the download succeeds and the item leaves the list (failed items stay; server- and category-level settings stay until none of their items are left), or until you remove the extension |
| **Servers you have opened:** server and category names, server icon URL, the IDs of the channels your account can read, and the time recorded | The server name shown on the Discord page and the server info answers (`discord.com`). Created when, with button display on, you open a server or press a category or server button - **even if you add nothing to the list.** | `chrome.storage.local` (per account) | To work out the ✓ marks of the category and server buttons and to show server and category names and icons in the popup list. | **Until you remove the extension.** Removing items or pressing "clear list" does not delete it (opening the same server again only overwrites that server's record). |
| **Download history:** chat name, time, status, message count, saved file names, settings used, error text (up to 200 per account) | Created by the extension | `chrome.storage.local` | The history screen, re-download and open-folder. | Until you press "clear history" or remove the extension |
| **Last message ID per channel** (for "new messages only") | The last successful download | `chrome.storage.local` | To download only messages newer than last time. | Until you remove the extension (there is no separate delete button) |
| **Settings:** format, count, date range, folder name, time zone, language, notifications, button display, the time you agreed to the first-run notice, and which servers and categories are expanded in the popup list | Values you choose | `chrome.storage.local` | To make the extension behave the way you set it. | Until you remove the extension |
| **Job state:** chat names of the running or just-finished download (e.g. server > #channel), progress, saved file paths, error text, download IDs and temporary file (blob) addresses | Created by the extension | Memory-only storage | The popup's progress screen, the completion notification and cleaning up temporary files. | Until Chrome is closed or the extension is reloaded, updated or disabled |
| **Look of the Discord page:** theme colors and language, and class names read from the page so the button can be drawn to match | The Discord web page (only color values and class names) | `chrome.storage.local` | Lets the popup and the download button look like the Discord page. | Until you remove the extension |
| **State of open Discord tabs:** tab id, whether the buttons were attached, the reason text and the time of the report (the tab address is not stored) | Reported by the content script | Memory-only storage | To show the button status in the popup. | Until the tab is closed or Chrome is closed |

- The content script (the code that adds the buttons to the Discord page) does **not read message text, cookies, passwords or the login token** from the page. It reads the names and IDs of servers, channels and DMs, the avatar URLs shown on DM and group DM rows, the current page address and the tab title (used only to work out the server and channel, not stored), and theme values and class names. Messages are not scraped from the screen; they come from the Discord API. The content script cannot read the memory-only storage, so it has no access to the token.
- It does not read passwords, cookies, browsing history or bookmarks stored in Chrome. It does not read the addresses of other sites (it has no permission for them).
- It does not record keystrokes, clicks, scrolling or mouse position.

## 4. Where information goes

| Destination | What is sent | Why |
|---|---|---|
| **`discord.com`** (Discord API, HTTPS) | **Read requests** carrying the login token: account check, channel and server info, the server's roles and your own member info (to work out permissions), messages, thread search. The only write request is **refreshing attachment links.** It does not send, edit or delete messages or add reactions. Requests are sent without cookies, and an answer that redirects to another address is treated as an error. | To load chats with your account. |
| **`cdn.discordapp.com`, `media.discordapp.net`** (Discord CDN) | Attachments, images and avatars are downloaded **without** the login token (saving attachments is done by Chrome's download feature, so cookies that Chrome normally sends to that address may go along). | Saving attachments; showing avatars and server icons in the popup. |
| **Your computer** | The files it builds are saved with Chrome's `downloads` API into your download folder (default subfolder `Discord Export`). | Saving the result files. |
| **Anywhere else** | **Nothing is sent.** There is no developer server, analytics service, ad service or remote code server. | - |

- How Discord handles what it receives through these requests is governed by Discord's privacy policy and terms. The requests go from your browser to Discord directly, as your account.
- When you open an exported **HTML file**, your browser loads avatars and images from Discord's servers (attachments you chose to save open from your computer). The HTML file contains no scripts.
- The Chrome Web Store and GitHub are only places to download the extension. The running extension sends nothing to them.

## 5. Before you agree, nothing is read

When you first open the extension, a notice about the Terms of Service, the risks and **the fact that it reads your login token** appears. **Before** you click the agree button, it does **none** of the following:

1. It does not open the headers (the login token included) of the requests the Discord web page sends. Even though Chrome has the request-observing feature registered, before you agree the requests are passed over without being read.
2. It sends no request at all to `discord.com` (no account check, no server info, no messages).
3. It stores no account info and no server or category info. The download buttons may be visible on the Discord page, but clicking one only shows a note asking you to read the notice first, and nothing is added. (Look-of-the-page values used to draw the button to match, and the button-status report, are handled even before you agree. They are the last two rows of Section 3 and are not personal information.)

**Once you click the agree button,** the following starts. The login token is read from the next request the Discord web page sends after you agree, so the account usually shows within a few seconds.

1. It **reads the login token** from the requests the Discord web page sends and keeps it in memory (headers other than `Authorization` are not used).
2. It sends a request to `discord.com` (`/users/@me`) to find out which account it is, and stores the account info (ID, name, avatar URL) from the answer. It sends it again when needed: when a new login token is captured, and when you open the popup or the extension's worker restarts while no verified account exists yet (the same token is not asked about again for 10 minutes, a rejected token not for 1 minute).
3. When you open a server (with button display on) it reads that server's **channel list, roles and your own member info** to work out the ✓ marks of the category and server buttons (read requests only, about once every 5 minutes per server per tab). The same read requests are sent when you press a category or server button. The server and category names and the IDs of the channels you can read are stored (Section 3, "Servers you have opened").

If you do not want the requests in item 3, turn off "Show buttons on Discord" in the popup and add chats with the shortcut (`Alt+Shift+D`). Items 1 and 2 are needed whenever the extension is in use and cannot be turned off; if you do not want them, disable or remove the extension. If the record of your agreement is erased (for example when the extension's stored data is cleared), the token and the account are removed at once.

## 6. Retention and how to delete

| What you want | How |
|---|---|
| Remove the login token | Close Chrome, or disable or reload the extension at `chrome://extensions`. It is only in memory, so it disappears. |
| Clear the download list | "Clear list" in the popup, or remove rows one by one |
| Clear the download history | "Clear history" on the history screen (saved files are not deleted) |
| Clear the records of servers you opened | There is no separate button. They are deleted when you remove the extension. Turning off "Show buttons on Discord" in the popup stops new ones from piling up. |
| **Delete everything the extension stored** | **Remove the extension** at `chrome://extensions`. Settings, list, history, last message IDs, account info and the records of servers you opened are deleted with it. |
| Delete chat files already saved | They are not deleted automatically. Delete the `Discord Export` folder (or the folder name you set) in your download folder yourself. |

The developer holds none of your information, so there is nothing to delete on the developer's side.

## 7. Security

- The login token is never written to disk. It is kept only in `chrome.storage.session` (memory only) and in the extension's own working memory, and is never written to files, the history, error messages or logs. The code injected into the Discord page and the popup do not read the token.
- The token is attached only to requests to addresses under `discord.com/api`. A request address is sent only if it is on an allow list (account, channel and messages, server, roles and own member info, thread search, attachment link refresh), and no cookies are sent.
- The content security policy of the extension pages blocks external scripts (`script-src 'self'`) and limits connections to Discord addresses.
- When saving, file names are checked again to be safe relative paths, and attachments are accepted only from Discord's CDN addresses.

Still, if you share the computer or the saved chat files are sensitive, keep the files somewhere safe and delete them when you are done. The conversations in the files may contain other people's messages and personal data.

## 8. No sale or sharing, no human access

- Your information is **not sold and not given or transferred to third parties.** It does not leave your computer except as the requests your account sends to Discord and the files and storage on your own machine.
- It is not used for ads, personalized ads, credit decisions, lending, data brokering or similar purposes.
- Neither the developer nor anyone else has a way to read your information (there is no receiving server).

## 9. Discord's Terms of Service and account risk

Discord's Terms of Service do not allow using a user account in an automated way. This extension requests messages on your behalf with your login information, so it can fall under that. **Your Discord account can be warned, restricted or banned, and you accept that risk yourself.** This extension does not claim that it is safe or that Discord permits it.

- Use it **only to keep a personal record** of the conversations of your own account, and do not publish or spread other people's conversations or personal data without their permission.
- The more you download, the higher the risk. Download only the chats you need and keep the amount small with the count, date range and "new messages only" options. Requests are sent slowly to reduce the risk (about 0.7-1.5 s between message requests and 2-4 s between chats), but that does not remove it.
- If you cannot afford to lose the account, do not use this extension.

## 10. Children

This extension is not directed at children and does not separately collect children's information. The information it handles is exactly what Section 3 lists, and age limits follow Discord's Terms of Service.

## 11. Chrome Web Store User Data Policy (Limited Use)

The use of information received by this extension, and its transfer to any other place, **adheres to the Chrome Web Store User Data Policy, including the Limited Use requirements.** Specifically, user data is (1) used only to provide or improve this extension's single purpose of saving the chats you request as files, (2) not sold or transferred to advertising platforms, data brokers or information resellers, (3) not used to determine creditworthiness or for lending purposes, and (4) not read by humans (the developer receives no data). (5) Data is sent to Discord only in requests that are necessary to provide the single purpose the user asked for, saving chats.

## 12. Changes to this policy

When this document changes, the effective date above is updated and the change is recorded in the repository's history (commits). For a new version that changes how data is handled (for example a server, analytics, or a new kind of information), this policy and the Chrome Web Store description are updated **before** that version is released, and any required consent is asked for again.

## 13. Contact

For questions, bug reports and privacy-related requests, please open an issue on GitHub:

- https://github.com/LanturnHouse/discord-chat-extractor-v2/issues

Issues are **public.** **Never post your login token, passwords, personal information or other people's conversations** (they are not needed to find a problem).
