/** Static text material for the demo corpus: conversational sentences, long texts and one sample per markdown feature. */

export const KO_SENTENCES: readonly string[] = [
  '오늘 배포하고 나서 로그 확인해봤는데 에러 없이 잘 돌아가는 것 같아요.',
  '혹시 TypeScript strict 모드에서 이 타입 에러 나는 분 계신가요?',
  '점심 뭐 드실래요? 저는 칼국수 먹으러 갈 생각입니다.',
  'PR 올렸습니다. 시간 되실 때 리뷰 부탁드려요 🙏',
  '어제 말씀하신 버그는 재현이 안 되는데 브라우저 버전 알려주실 수 있나요?',
  '회의 시간을 3시로 옮겨도 괜찮을까요?',
  '와 이거 진짜 깔끔하네요. 어떻게 하신 거예요?',
  '캐시 때문인 것 같아요. 강력 새로고침 한 번 해보세요.',
  '주말에 스터디 하실 분 손 들어주세요 ✋',
  '방금 빌드가 깨졌는데 누가 main에 푸시했나요?',
  '이 라이브러리는 번들 크기가 너무 커서 다른 걸로 바꾸는 게 좋겠어요.',
  '감사합니다! 덕분에 해결했어요.',
  '내일 데모 준비는 다 됐나요?',
  '그 부분은 제가 다시 확인해보고 말씀드릴게요.',
  '테스트 커버리지가 80%를 넘었습니다. 다들 고생하셨어요!',
  '새벽에 장애 알림이 와서 깜짝 놀랐는데 지금은 복구됐습니다.',
  '문서 업데이트했으니 한번 읽어봐 주세요.',
  '이번 스프린트 회고는 금요일 오후에 진행합니다.',
  '저도 같은 문제였는데 node 버전을 올리니까 해결됐어요.',
  '이 함수 이름이 너무 헷갈려서 리네임 제안드립니다.',
  '로컬에서는 되는데 CI에서만 실패해요. 환경 변수 문제일까요?',
  '디자인 시안 공유드립니다. 의견 편하게 남겨주세요.',
  '다음 주부터 재택근무 일정이 바뀐다고 하네요.',
  '린트 규칙을 조금 완화하는 게 어떨까요? 너무 엄격해서 생산성이 떨어져요.',
  '혹시 이 에러 메시지 의미 아시는 분 계세요? 구글링해도 안 나오네요.',
  '어제 올린 스크린샷 보셨나요? 레이아웃이 살짝 깨지는 것 같아요.',
  '커피 한 잔 하면서 천천히 얘기해봐요 ☕',
  '버전 업데이트 후에 설정이 초기화됐는데 저만 그런가요?',
  '이슈 번호 #482 확인 부탁드립니다.',
  '좋은 아침입니다! 오늘도 힘내봐요 💪',
];

export const EN_SENTENCES: readonly string[] = [
  'Just pushed a fix for the flaky test, can someone take a look?',
  'Has anyone tried the new release yet? The changelog looks huge.',
  'I think we should split this into two PRs, it is getting hard to review.',
  'Lunch at 12:30? There is a new ramen place around the corner.',
  "That's a great point, I hadn't considered the edge case with empty arrays.",
  'Can confirm, I can reproduce this on Firefox as well.',
  'Thanks for the quick turnaround!',
  'Heads up: staging will be down for maintenance tonight.',
  'Is it just me or is CI slower than usual today?',
  'We should probably add a regression test for that.',
  'Sorry, I was out yesterday. Catching up on the thread now.',
  'The docs are out of date, I will send a PR later today.',
  'Looks good to me, shipping it.',
  'Anyone up for a quick call to go over the design?',
  'I rebased on main and the conflict is gone.',
  'Does this work with the latest Node LTS?',
  'Good morning everyone! Coffee first, then standup.',
  'I tried clearing the cache but it did not help.',
  'Let us revisit this after the release, there is too much going on right now.',
  'Our bundle size grew by 40 KB, looking into what changed.',
  'Great demo yesterday, the feedback from the team was really positive.',
  'Could you share the repro steps? I cannot trigger it locally.',
  'The migration finished without errors, all rows are accounted for.',
  'I will take the on-call shift this weekend if someone covers Monday.',
  'Typo in the README, fixing it now.',
  'Which timezone are we using for the release schedule?',
  'This is exactly what I was looking for, thank you!',
  'Let me double-check and get back to you.',
  'Can we get a second pair of eyes on issue #482?',
  'Happy Friday! Anything fun planned for the weekend?',
];

export const KO_CASUAL: readonly string[] = [
  '오늘 저녁에 시간 돼?',
  '방금 집 도착했어 ㅋㅋ',
  '그 영화 봤어? 진짜 재밌더라',
  '주말에 뭐해? 약속 없으면 같이 나가자',
  '아 맞다 그거 깜빡했다 ㅠㅠ',
  '내일 몇 시에 만날까?',
  '지금 통화 가능해?',
  '밥은 먹었어?',
  '와 대박 소식 들었어?',
  '사진 보내줄게 잠깐만',
  '알겠어 그럼 그때 보자!',
  '고마워 진짜 큰 도움이 됐어',
  '너무 피곤하다... 오늘은 일찍 잘래',
  '비 오는데 우산 챙겼어?',
  '이번 휴가 계획 세웠어?',
  '그 노래 들어봤어? 요즘 계속 듣고 있어',
  '생일 축하해!!! 🎂',
  '커피 마시러 갈래?',
  '잠깐만 회의 끝나고 연락할게',
  '아니 그게 아니라 내 말은...',
];

export const EN_CASUAL: readonly string[] = [
  'hey, are you free tonight?',
  'just got home lol',
  'did you see that movie? it was so good',
  'what are you up to this weekend?',
  'oh no I totally forgot about that',
  'what time should we meet tomorrow?',
  'can you talk right now?',
  'have you eaten yet?',
  'omg did you hear the news',
  'sending you the photos, one sec',
  'ok see you then!',
  'thanks so much, that really helped',
  'so tired... going to bed early tonight',
  'it is pouring outside, did you bring an umbrella?',
  'any vacation plans yet?',
  'have you heard that song? been on repeat all week',
  'happy birthday!!! 🎂',
  'wanna grab a coffee?',
  'give me a sec, I will text you after this meeting',
  'no that is not what I meant...',
];

export const SHORT_KO: readonly string[] = ['ㅇㅇ', 'ㅋㅋㅋ', 'ㅋㅋㅋㅋㅋㅋ', 'ㅎㅎ', '넵', '굿', '확인했습니다', '감사합니다!', 'ㄱㄱ', '헐', '오 좋네요', 'ㅠㅠ', '넹', '+1'];
export const SHORT_EN: readonly string[] = ['lol', 'ok', 'thx', '👍', 'nice', '+1', 'same', 'makes sense', 'yep', 'nope', 'ty!', 'lgtm', 'haha', 'hmm', 'wow'];

export const LONG_KO = [
  '안녕하세요, 여러분. 이번 주 스프린트 회고를 정리해서 공유드립니다.',
  '먼저 잘된 점입니다. 배포 파이프라인을 정리하면서 평균 빌드 시간이 14분에서 6분으로 줄었고, 테스트 커버리지도 꾸준히 올라 이제 80%를 넘겼습니다. 특히 신규 입사자분들이 온보딩 문서만 보고도 로컬 환경을 30분 안에 세팅할 수 있었다는 피드백이 인상 깊었습니다.',
  '아쉬운 점도 있었습니다. 장애 대응 과정에서 로그를 한곳에서 볼 수 없어 원인 파악에 시간이 오래 걸렸고, 일부 서비스는 여전히 알림이 너무 많아 중요한 알림이 묻히는 문제가 있었습니다. 다음 스프린트에서는 알림 기준을 재정비하고 로그 수집을 통합하는 작업을 우선순위로 두려고 합니다.',
  '마지막으로, 의견이 있으시면 스레드에 편하게 남겨주세요. 읽고 반영하겠습니다. 감사합니다!',
].join('\n\n');

export const LONG_EN = [
  'Hi everyone, here is a summary of what happened in this sprint.',
  'First, the good news: after cleaning up the deployment pipeline our average build time dropped from 14 minutes to 6, and test coverage kept climbing and is now above 80%. New teammates told us they could set up a local environment in under half an hour using only the onboarding docs, which was great to hear.',
  'There were rough spots too. During the incident last Thursday we could not see all logs in one place, so finding the root cause took far longer than it should have, and a few services still send so many alerts that the important ones get buried. For the next sprint we will prioritise cleaning up alert thresholds and consolidating log collection.',
  'If you have thoughts, please drop them in the thread below. Thanks for reading!',
].join('\n\n');

export const LONG_MIXED = [
  '## 릴리즈 안내 / Release notes',
  '이번 릴리즈에는 다음 변경 사항이 포함되어 있습니다. / This release contains the following changes:',
  '- 내보내기 속도 개선 (Faster exports)\n- 큰 채널에서 메모리 사용량 감소 (Lower memory use on huge channels)\n- 이모지 렌더링 버그 수정 (Fixed emoji rendering)',
  '업그레이드 전에 **반드시** 백업해 주세요. Please back up before upgrading.',
  '문의는 <https://example.org/support> 로 남겨주세요.',
].join('\n\n');

/** Text of about 1,950 characters: just below the 2,000-character message limit. */
export function nearLimitText(pool: readonly string[]): string {
  const parts: string[] = [];
  let length = 0;
  for (let i = 0; length < 1900; i++) {
    const sentence = pool[i % pool.length];
    parts.push(sentence);
    length += sentence.length + 1;
  }
  return parts.join(' ').slice(0, 1990);
}

/** Message bodies with unusual characters: the data that breaks naive text handling. */
export const MULTILINGUAL: readonly string[] = [
  '안녕하세요! Hello 👋 こんにちは 你好 Привет 🇰🇷🇺🇸🇯🇵 — 한국어, English, 日本語, 中文, русский',
  'مرحبا بالعالم! هذا نص عربي مع English في المنتصف ثم עוד טקסט בעברית: שלום עולם',
  'zero​width‌space‍joiners﻿ and a soft­hyphen are invisible but still characters',
  '👨‍👩‍👧‍👦 family, 👍🏽 skin tone, 🏳️‍🌈 flag, ❤️‍🔥 fire heart, 1️⃣ keycap, ©️ symbol, 🧑‍💻 technologist',
  `Decomposed Hangul: ${'한글 테스트'.normalize('NFD')} / combining accent: é ñ / stacked: Z̵̈á̶l̷g̵o̶`,
  'ＦＵＬＬＷＩＤＴＨ　ｔｅｘｔ，漢字、かな、カナ、한글　(ideographic space)',
  `${'A'.repeat(180)} <- 180 characters without a space, then a long URL: https://example.com/${'path-segment/'.repeat(14)}end`,
  '  leading spaces\n\n\nthree blank lines above, trailing spaces below  \n\ttab-indented line with non-breaking spaces',
  '😀😃😄😁😆😅🤣😂🙂🙃😉😊😇🥰😍🤩😘😗☺️😚😙🥲😋😛😜🤪😝🤑🤗🤭🤫🤔🤐🤨😐😑😶😏😒🙄😬🤥😌😔😪🤤😴😷',
];

/** One entry per markdown feature (and a few nasty combinations). Index = `markdown` variant. */
export const MARKDOWN_SAMPLES: readonly string[] = [
  '**굵은 글씨**, *기울임*, __밑줄__, ~~취소선~~, ||스포일러||, `인라인 코드` 테스트',
  '**bold** *italic* _also italic_ __underline__ ~~strike~~ ||spoiler|| `code`',
  '***굵은 기울임*** / __*밑줄+기울임*__ / **__굵은 밑줄__** / ~~**취소선+굵게**~~ / ||**스포일러 속 굵게**|| / ***__~~전부 다~~__***',
  'Inline code: `const answer = 42;` and with backticks inside: ``use `code` here`` and `**not bold**`',
  ['```ts', 'interface User {', '  id: string;', '  name: string;', '}', '', 'export function greet(user: User): string {', '  return `안녕하세요, ${user.name}!`;', '}', '```'].join('\n'),
  ['```python', 'def fib(n: int) -> int:', '    """Return the n-th Fibonacci number."""', '    a, b = 0, 1', '    for _ in range(n):', '        a, b = b, a + b', '    return a', '', 'print([fib(i) for i in range(10)])', '```'].join('\n'),
  ['```', 'plain code block without a language', '**not bold** *not italic* <@123> :not_emoji:', '    indented line', '```'].join('\n'),
  ['```json', '{', '  "name": "demo",', '  "tags": ["a", "b"],', '  "nested": { "ok": true, "n": null }', '}', '```'].join('\n'),
  ['코드는 이렇게 쓰면 돼요:', '```js', "console.log('hello');", '```', '실행해보세요!'].join('\n'),
  '```single line fenced block```',
  '> 한 줄 인용문입니다',
  ['> 첫째 줄', '> 둘째 줄', '> 셋째 줄', '', '인용 뒤에 이어지는 본문'].join('\n'),
  ['>>> 여기부터 끝까지 전부 인용입니다', '둘째 줄도 인용이고 **굵은 글씨**도 가능해요', '셋째 줄'].join('\n'),
  ['# 제목 1', '## 제목 2', '### 제목 3', '일반 텍스트', '-# 작은 글씨 (subtext)'].join('\n'),
  ['- 사과', '- 바나나', '  - 노란 바나나', '  - 초록 바나나', '- 포도'].join('\n'),
  ['1. 첫 번째', '2. 두 번째', '3. 세 번째', '   - 하위 항목'].join('\n'),
  ['* star item', '* another star item', '', '- dash item', '- another dash item'].join('\n'),
  '[Example Domain](https://example.com) 과 [문서](https://example.org/docs "툴팁 제목") 과 [embed 없음](<https://example.com/no-embed>)',
  'https://example.com/path?query=1&b=2#hash 그리고 <https://example.org/angle> 와 www.example.com (autolink 아님) 와 http://localhost:5173/app.html?mock=1.',
  '\\*별표 이스케이프\\* \\_\\_밑줄\\_\\_ \\`백틱\\` \\> 인용 아님 1\\. 목록 아님 \\\\ 백슬래시 \\|\\|스포일러 아님\\|\\| \\~\\~취소 아님\\~\\~',
  ['# **굵은 제목**', '> 인용 안의 *기울임* 과 `code`', '- 목록 안의 [링크](https://example.com)'].join('\n'),
  '||스포일러 1|| 중간 텍스트 ||스포일러 **굵게** 2|| ||여러 줄\n스포일러||',
  '__underline__ vs _italic_ vs **bold** vs ***bold-italic*** vs __***all three***__',
  'Malformed: snake_case_words and 2*3*4 and **unclosed bold and *unclosed italic and __unclosed underline and `unclosed code',
  '**한글 굵게** *English italic* 🎉 ~~취소~~ `코드` ||스포일러|| :tada: 와 이모지 코드는 그대로 표시',
  ['```html', '<div class="a">&amp; <script>alert(1)</script></div>', '```'].join('\n'),
  ['| a | b |', '|---|---|', '| 1 | 2 |', '', '(Discord does not render tables)'].join('\n'),
  [
    '```ts',
    ...Array.from({ length: 24 }, (_, i) => `export const value${String(i).padStart(2, '0')} = (input: number): number => input * ${i + 1} + ${i % 7};`),
    '```',
  ].join('\n'),
];

/** Link previews: [url, title, description, provider]. All hosts are reserved example domains. */
export const LINKS: readonly (readonly [string, string, string, string])[] = [
  ['https://example.com/blog/shipping-a-chrome-extension', 'Shipping a Chrome extension without a build server', 'A walkthrough of packaging, versioning and publishing a Manifest V3 extension from your laptop.', 'Example Blog'],
  ['https://example.org/docs/streams', 'Streams: the complete guide', 'Everything you need to know about readable, writable and transform streams, with runnable examples.', 'Example Docs'],
  ['https://example.net/news/open-source-funding', '오픈소스 후원 모델, 지금 어떻게 바뀌고 있나', '메인테이너 번아웃을 줄이기 위한 새로운 후원 방식과 사례를 정리했습니다.', '예시 뉴스'],
  ['https://example.com/projects/unicode-explorer', 'Unicode Explorer 🔎', 'Search every code point, see how it renders and copy it with one click.', 'Example Tools'],
];

export const SERVER_NAMES = ['api-gateway', 'worker-02', 'db-primary', 'cache-eu', 'web-front'] as const;
