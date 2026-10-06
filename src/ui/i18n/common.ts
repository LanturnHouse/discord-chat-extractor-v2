import { defineStrings } from './core';

/** Strings used by more than one UI area. Area-specific strings live next to their components. */
export const commonStrings = defineStrings({
  ko: {
    appName: '디스코드 채팅 추출기',
    cancel: '취소',
    close: '닫기',
    back: '뒤로',
    save: '저장',
    loading: '불러오는 중…',
    retry: '다시 시도',
    dismiss: '알림 닫기',
    on: '켜짐',
    off: '꺼짐',
  },
  en: {
    appName: 'Discord Chat Extractor',
    cancel: 'Cancel',
    close: 'Close',
    back: 'Back',
    save: 'Save',
    loading: 'Loading…',
    retry: 'Retry',
    dismiss: 'Dismiss',
    on: 'On',
    off: 'Off',
  },
});
