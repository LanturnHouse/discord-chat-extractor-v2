// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_EXPORT_SETTINGS, type AppSettings, type ExportSettings } from '@/shared';
import { endOfDayIso, startOfDayIso } from '@/ui/format/dates';
import { LocaleProvider } from '@/ui/i18n/locale';
import type { Locale } from '@/ui/i18n/core';
import { cloneSettings } from '@/ui/settings/fields';
import { SettingsPanel } from '@/ui/settings/SettingsPanel';

afterEach(cleanup); // vitest globals are off, so testing-library cannot register its own cleanup

interface HarnessProps {
  initial?: ExportSettings;
  variant?: 'common' | 'item';
  locale?: Locale;
  onChange?: (next: ExportSettings) => void;
  onValidityChange?: (valid: boolean) => void;
  onLanguageChange?: (language: AppSettings['language']) => void;
  onZipAllChange?: (zipAll: boolean) => void;
  /** Lets a test replace the settings from outside, like a store that changed. */
  setterRef?: { current: ((next: ExportSettings) => void) | null };
}

/** A parent like the real ones: it replaces `value` with every value the panel reports. */
function Harness({ initial = DEFAULT_EXPORT_SETTINGS, variant = 'common', locale = 'ko', onChange, onValidityChange, onLanguageChange, onZipAllChange, setterRef }: HarnessProps) {
  const [value, setValue] = useState<ExportSettings>(cloneSettings(initial));
  const [language, setLanguage] = useState<AppSettings['language']>('auto');
  const [zipAll, setZipAll] = useState(false);
  if (setterRef !== undefined) setterRef.current = setValue;
  const change = (next: ExportSettings): void => {
    onChange?.(next);
    setValue(next);
  };
  return (
    <LocaleProvider locale={locale}>
      {variant === 'common' ? (
        <SettingsPanel
          variant="common"
          value={value}
          onChange={change}
          onValidityChange={onValidityChange}
          language={language}
          onLanguageChange={(next) => {
            onLanguageChange?.(next);
            setLanguage(next);
          }}
          zipAll={zipAll}
          onZipAllChange={(next) => {
            onZipAllChange?.(next);
            setZipAll(next);
          }}
        />
      ) : (
        <SettingsPanel variant="item" value={value} onChange={change} onValidityChange={onValidityChange} />
      )}
    </LocaleProvider>
  );
}

const lastCall = (spy: ReturnType<typeof vi.fn>): ExportSettings => spy.mock.calls.at(-1)?.[0] as ExportSettings;
const countInput = (): HTMLInputElement => screen.getByRole('spinbutton', { name: '내보낼 메시지 개수' }) as HTMLInputElement;
const dateInput = (label: '시작일' | '종료일'): HTMLInputElement => screen.getByLabelText(label) as HTMLInputElement;
const format = (name: string): HTMLElement => screen.getByRole('radio', { name: new RegExp(`^${name}`) });
const type = (input: HTMLElement, value: string): void => {
  fireEvent.change(input, { target: { value } });
};

describe('format cards (docs/PLAN.md §7.3)', () => {
  it('six cards with the texts of the plan, HTML first and chosen by default', () => {
    render(<Harness />);
    const cards = within(screen.getByRole('radiogroup', { name: '형식' })).getAllByRole('radio');
    expect(cards.map((card) => card.querySelector('.dce-radio__label')?.textContent)).toEqual(['HTML', 'TXT', 'Markdown', 'Excel (.xlsx)', 'CSV', 'JSON']);
    expect(cards.map((card) => card.querySelector('.dce-radio__description')?.textContent)).toEqual([
      '디스코드처럼 보이는 파일 · 읽기에 가장 좋아요 (권장)',
      '일반 텍스트',
      'Notion · Obsidian · GitHub용',
      'Excel · 정렬하고 필터링',
      '스프레드시트 · 데이터 분석용',
      '프로그램용 전체 원본 데이터',
    ]);
    expect(cards[0].getAttribute('aria-checked')).toBe('true');
    expect(cards.filter((card) => card.getAttribute('aria-checked') === 'true')).toHaveLength(1);
    expect(cards[0].querySelector('.dce-radio__check')).not.toBeNull(); // the chosen card has the check
  });

  it('choosing a card reports the format and keeps every other setting', () => {
    const onChange = vi.fn();
    render(<Harness onChange={onChange} initial={{ ...DEFAULT_EXPORT_SETTINGS, count: 77, includeAttachments: true, content: { ...DEFAULT_EXPORT_SETTINGS.content } }} />);
    fireEvent.click(format('Excel'));
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(lastCall(onChange)).toEqual({ ...DEFAULT_EXPORT_SETTINGS, count: 77, includeAttachments: true, format: 'xlsx', content: { ...DEFAULT_EXPORT_SETTINGS.content } });
    expect(format('Excel').getAttribute('aria-checked')).toBe('true');
  });

  it('each of the six formats can be chosen', () => {
    const onChange = vi.fn();
    render(<Harness onChange={onChange} />);
    for (const [name, id] of [['TXT', 'txt'], ['Markdown', 'md'], ['Excel', 'xlsx'], ['CSV', 'csv'], ['JSON', 'json'], ['HTML', 'html']] as const) {
      fireEvent.click(format(name));
      expect(lastCall(onChange).format).toBe(id);
    }
  });

  it('the arrow keys move the choice like native radio buttons', () => {
    const onChange = vi.fn();
    render(<Harness onChange={onChange} />);
    fireEvent.keyDown(screen.getByRole('radiogroup', { name: '형식' }), { key: 'ArrowDown' });
    expect(lastCall(onChange).format).toBe('txt');
  });

  it('clicking the chosen format again changes nothing', () => {
    const onChange = vi.fn();
    render(<Harness onChange={onChange} />);
    fireEvent.click(format('HTML'));
    expect(onChange).not.toHaveBeenCalled();
  });
});

describe('HTML theme', () => {
  it('only exists while the format is HTML', () => {
    render(<Harness />);
    expect(screen.getByRole('radiogroup', { name: 'HTML 테마' })).toBeTruthy();
    fireEvent.click(format('TXT'));
    expect(screen.queryByRole('radiogroup', { name: 'HTML 테마' })).toBeNull();
    fireEvent.click(format('HTML'));
    expect(screen.getByRole('radiogroup', { name: 'HTML 테마' })).toBeTruthy();
  });

  it('is dark by default and can be set to light and back', () => {
    const onChange = vi.fn();
    render(<Harness onChange={onChange} />);
    expect(screen.getByRole('radio', { name: '다크' }).getAttribute('aria-checked')).toBe('true');
    fireEvent.click(screen.getByRole('radio', { name: '라이트' }));
    expect(lastCall(onChange).htmlTheme).toBe('light');
    fireEvent.click(screen.getByRole('radio', { name: '다크' }));
    expect(lastCall(onChange).htmlTheme).toBe('dark');
  });

  it('the chosen theme survives a detour through another format', () => {
    render(<Harness initial={{ ...DEFAULT_EXPORT_SETTINGS, htmlTheme: 'light', content: { ...DEFAULT_EXPORT_SETTINGS.content } }} />);
    fireEvent.click(format('CSV'));
    fireEvent.click(format('HTML'));
    expect(screen.getByRole('radio', { name: '라이트' }).getAttribute('aria-checked')).toBe('true');
  });
});

describe('number of messages (default 200, plus "전체")', () => {
  it('shows 200 by default, in "개수 지정"', () => {
    render(<Harness />);
    expect(countInput().value).toBe('200');
    expect(screen.getByRole('radio', { name: '개수 지정' }).getAttribute('aria-checked')).toBe('true');
  });

  it('typing a number reports it at once', () => {
    const onChange = vi.fn();
    render(<Harness onChange={onChange} />);
    type(countInput(), '350');
    expect(lastCall(onChange).count).toBe(350);
    expect(countInput().value).toBe('350');
  });

  it('accepts the bounds 1 and 1,000,000', () => {
    const onChange = vi.fn();
    render(<Harness onChange={onChange} />);
    type(countInput(), '1');
    expect(lastCall(onChange).count).toBe(1);
    type(countInput(), '1000000');
    expect(lastCall(onChange).count).toBe(1_000_000);
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('refuses what is not a whole number from 1 to 1,000,000: an alert, nothing reported', () => {
    const onChange = vi.fn();
    render(<Harness onChange={onChange} />);
    for (const [text, message] of [
      ['0', '1에서 1,000,000 사이의 숫자를 입력하세요.'],
      ['-5', '1에서 1,000,000 사이의 숫자를 입력하세요.'],
      ['1000001', '1에서 1,000,000 사이의 숫자를 입력하세요.'],
      ['1.5', '소수점 없이 정수로 입력하세요.'],
      ['12abc', '소수점 없이 정수로 입력하세요.'],
      ['', '메시지 개수를 입력하세요.'],
    ] as const) {
      type(countInput(), text);
      expect(screen.getByRole('alert').textContent, text).toBe(message);
      expect(countInput().getAttribute('aria-invalid'), text).toBe('true');
    }
    expect(onChange).not.toHaveBeenCalled();
  });

  it('an invalid text stays visible (nothing is rewritten under the user), and fixing it reports the number', () => {
    const onChange = vi.fn();
    render(<Harness onChange={onChange} />);
    type(countInput(), '0');
    expect(countInput().value).toBe('0');
    type(countInput(), '25');
    expect(screen.queryByRole('alert')).toBeNull();
    expect(lastCall(onChange).count).toBe(25);
  });

  it('keeps how the user typed a valid number ("012") instead of rewriting it', () => {
    render(<Harness />);
    type(countInput(), '012');
    expect(countInput().value).toBe('012');
  });

  it('the quick picks set the number', () => {
    const onChange = vi.fn();
    render(<Harness onChange={onChange} />);
    const picks = within(screen.getByRole('group', { name: '빠른 선택' }));
    fireEvent.click(picks.getByRole('button', { name: '1,000' }));
    expect(lastCall(onChange).count).toBe(1000);
    expect(picks.getByRole('button', { name: '1,000' }).getAttribute('aria-pressed')).toBe('true');
    expect(picks.getByRole('button', { name: '100' }).getAttribute('aria-pressed')).toBe('false');
  });

  it('"전체" reports count null, hides the number input and warns about a whole chat', () => {
    const onChange = vi.fn();
    render(<Harness onChange={onChange} />);
    fireEvent.click(screen.getByRole('radio', { name: '전체' }));
    expect(lastCall(onChange).count).toBeNull();
    expect(screen.queryByRole('spinbutton')).toBeNull();
    expect(screen.getByText(/채널의 모든 메시지를 내보내요/)).toBeTruthy();
  });

  it('going back to "개수 지정" restores the number it had', () => {
    const onChange = vi.fn();
    render(<Harness onChange={onChange} />);
    type(countInput(), '640');
    fireEvent.click(screen.getByRole('radio', { name: '전체' }));
    fireEvent.click(screen.getByRole('radio', { name: '개수 지정' }));
    expect(lastCall(onChange).count).toBe(640);
    expect(countInput().value).toBe('640');
  });

  it('starting in "전체", the first return to "개수 지정" starts at 200', () => {
    const onChange = vi.fn();
    render(<Harness onChange={onChange} initial={{ ...DEFAULT_EXPORT_SETTINGS, count: null, content: { ...DEFAULT_EXPORT_SETTINGS.content } }} />);
    expect(screen.queryByRole('spinbutton')).toBeNull();
    fireEvent.click(screen.getByRole('radio', { name: '개수 지정' }));
    expect(lastCall(onChange).count).toBe(200);
  });

  it('explains which messages the number picks: the latest ones, or the latest ones inside the date range', () => {
    render(<Harness />);
    expect(screen.getByText('가장 최근 메시지부터 거슬러 올라가 200개를 내보내요.')).toBeTruthy();
    type(dateInput('시작일'), '2026-01-01');
    expect(screen.getByText('기간 안에서 최신 200개를 내보내요.')).toBeTruthy();
    expect(screen.queryByText(/가장 최근 메시지부터/)).toBeNull();
  });

  it('"전체" with a date range says it exports the range, with no warning', () => {
    render(<Harness initial={{ ...DEFAULT_EXPORT_SETTINGS, count: null, content: { ...DEFAULT_EXPORT_SETTINGS.content } }} />);
    expect(screen.getByText(/채널의 모든 메시지/)).toBeTruthy();
    type(dateInput('종료일'), '2026-02-01');
    expect(screen.getByText('기간 안의 모든 메시지를 내보내요.')).toBeTruthy();
  });
});

describe('date range: local day bounds', () => {
  it('start 00:00:00.000 and end 23:59:59.999 of the chosen local days', () => {
    const onChange = vi.fn();
    render(<Harness onChange={onChange} />);
    type(dateInput('시작일'), '2026-03-05');
    expect(lastCall(onChange).from).toBe(new Date(2026, 2, 5, 0, 0, 0, 0).toISOString());
    expect(lastCall(onChange).to).toBeNull();
    type(dateInput('종료일'), '2026-03-20');
    expect(lastCall(onChange).from).toBe(new Date(2026, 2, 5, 0, 0, 0, 0).toISOString());
    expect(lastCall(onChange).to).toBe(new Date(2026, 2, 20, 23, 59, 59, 999).toISOString());
    const from = new Date(lastCall(onChange).from!);
    const to = new Date(lastCall(onChange).to!);
    expect([from.getHours(), from.getMinutes(), from.getSeconds(), from.getMilliseconds()]).toEqual([0, 0, 0, 0]);
    expect([to.getHours(), to.getMinutes(), to.getSeconds(), to.getMilliseconds()]).toEqual([23, 59, 59, 999]);
  });

  it('the same day for both is a valid range', () => {
    const onChange = vi.fn();
    render(<Harness onChange={onChange} />);
    type(dateInput('시작일'), '2026-03-05');
    type(dateInput('종료일'), '2026-03-05');
    expect(screen.queryByRole('alert')).toBeNull();
    expect(lastCall(onChange).from).toBe(startOfDayIso('2026-03-05'));
    expect(lastCall(onChange).to).toBe(endOfDayIso('2026-03-05'));
  });

  it('shows the days of a stored range', () => {
    render(<Harness initial={{ ...DEFAULT_EXPORT_SETTINGS, from: startOfDayIso('2026-01-02'), to: endOfDayIso('2026-02-03'), content: { ...DEFAULT_EXPORT_SETTINGS.content } }} />);
    expect(dateInput('시작일').value).toBe('2026-01-02');
    expect(dateInput('종료일').value).toBe('2026-02-03');
  });

  it('a start after the end is an alert and nothing is reported; fixing it reports both days', () => {
    const onChange = vi.fn();
    render(<Harness onChange={onChange} />);
    type(dateInput('시작일'), '2026-03-20');
    onChange.mockClear();
    type(dateInput('종료일'), '2026-03-05');
    expect(screen.getByRole('alert').textContent).toBe('시작일이 종료일보다 늦어요.');
    expect(dateInput('시작일').getAttribute('aria-invalid')).toBe('true');
    expect(dateInput('종료일').getAttribute('aria-invalid')).toBe('true');
    expect(onChange).not.toHaveBeenCalled();
    type(dateInput('종료일'), '2026-03-25');
    expect(screen.queryByRole('alert')).toBeNull();
    expect(lastCall(onChange).to).toBe(endOfDayIso('2026-03-25'));
  });

  it('each date has its own clear button that removes the bound', () => {
    const onChange = vi.fn();
    render(<Harness onChange={onChange} />);
    expect(screen.queryByRole('button', { name: '시작일 지우기' })).toBeNull();
    type(dateInput('시작일'), '2026-03-05');
    type(dateInput('종료일'), '2026-03-20');
    fireEvent.click(screen.getByRole('button', { name: '시작일 지우기' }));
    expect(lastCall(onChange).from).toBeNull();
    expect(lastCall(onChange).to).toBe(endOfDayIso('2026-03-20'));
    fireEvent.click(screen.getByRole('button', { name: '종료일 지우기' }));
    expect(lastCall(onChange).to).toBeNull();
    expect(dateInput('시작일').value).toBe('');
  });

  it('clearing a start date that was the cause of an inverted range reports the rest', () => {
    const onChange = vi.fn();
    render(<Harness onChange={onChange} />);
    type(dateInput('시작일'), '2026-03-20');
    type(dateInput('종료일'), '2026-03-05');
    fireEvent.click(screen.getByRole('button', { name: '시작일 지우기' }));
    expect(screen.queryByRole('alert')).toBeNull();
    expect(lastCall(onChange)).toMatchObject({ from: null, to: endOfDayIso('2026-03-05') });
  });

  it('says that an empty range means every date', () => {
    render(<Harness />);
    expect(screen.getByText('비워 두면 전체 기간을 내보내요.')).toBeTruthy();
  });

  it('a date that was not touched keeps its exact instant when the count changes', () => {
    const odd = '2026-01-02T05:30:00.000Z';
    const onChange = vi.fn();
    render(<Harness onChange={onChange} initial={{ ...DEFAULT_EXPORT_SETTINGS, from: odd, content: { ...DEFAULT_EXPORT_SETTINGS.content } }} />);
    type(countInput(), '10');
    expect(lastCall(onChange).from).toBe(odd);
  });
});

describe('"더보기"', () => {
  it('is closed by default and shows the extras when opened', () => {
    render(<Harness />);
    const more = screen.getByRole('button', { name: '더보기' });
    expect(more.getAttribute('aria-expanded')).toBe('false');
    expect(screen.queryByRole('checkbox', { name: '첨부파일 함께 저장' })).toBeNull();
    fireEvent.click(more);
    expect(more.getAttribute('aria-expanded')).toBe('true');
    for (const name of ['첨부파일 함께 저장', '스레드 포함', '새 메시지만 받기', '봇 메시지 포함', '시스템 메시지 포함', '반응 포함', '임베드 포함']) {
      expect(screen.getByRole('checkbox', { name }), name).toBeTruthy();
    }
    fireEvent.click(more);
    expect(screen.queryByRole('checkbox', { name: '반응 포함' })).toBeNull();
  });

  it('starts open when one of its options differs from the default, so nothing changed is hidden', () => {
    render(<Harness initial={{ ...DEFAULT_EXPORT_SETTINGS, includeAttachments: true, content: { ...DEFAULT_EXPORT_SETTINGS.content } }} />);
    expect(screen.getByRole('button', { name: '더보기' }).getAttribute('aria-expanded')).toBe('true');
    expect((screen.getByRole('checkbox', { name: '첨부파일 함께 저장' }) as HTMLInputElement).checked).toBe(true);
  });

  it('the defaults: attachments, threads and new-only off; bots, system, reactions and embeds on', () => {
    render(<Harness />);
    fireEvent.click(screen.getByRole('button', { name: '더보기' }));
    const checked = (name: string): boolean => (screen.getByRole('checkbox', { name }) as HTMLInputElement).checked;
    expect([checked('첨부파일 함께 저장'), checked('스레드 포함'), checked('새 메시지만 받기')]).toEqual([false, false, false]);
    expect([checked('봇 메시지 포함'), checked('시스템 메시지 포함'), checked('반응 포함'), checked('임베드 포함')]).toEqual([true, true, true, true]);
  });

  it('every checkbox reports its own field and leaves the others alone', () => {
    const onChange = vi.fn();
    render(<Harness onChange={onChange} />);
    fireEvent.click(screen.getByRole('button', { name: '더보기' }));
    fireEvent.click(screen.getByRole('checkbox', { name: '첨부파일 함께 저장' }));
    expect(lastCall(onChange)).toMatchObject({ includeAttachments: true, includeThreads: false, incremental: false });
    fireEvent.click(screen.getByRole('checkbox', { name: '스레드 포함' }));
    expect(lastCall(onChange)).toMatchObject({ includeAttachments: true, includeThreads: true, incremental: false });
    fireEvent.click(screen.getByRole('checkbox', { name: '새 메시지만 받기' }));
    expect(lastCall(onChange)).toMatchObject({ includeAttachments: true, includeThreads: true, incremental: true });
    fireEvent.click(screen.getByRole('checkbox', { name: '봇 메시지 포함' }));
    fireEvent.click(screen.getByRole('checkbox', { name: '시스템 메시지 포함' }));
    fireEvent.click(screen.getByRole('checkbox', { name: '반응 포함' }));
    fireEvent.click(screen.getByRole('checkbox', { name: '임베드 포함' }));
    expect(lastCall(onChange).content).toEqual({ includeBots: false, includeSystem: false, includeReactions: false, includeEmbeds: false });
    fireEvent.click(screen.getByRole('checkbox', { name: '반응 포함' }));
    expect(lastCall(onChange).content).toEqual({ includeBots: false, includeSystem: false, includeReactions: true, includeEmbeds: false });
  });

  it('warns about the request volume while threads are included', () => {
    render(<Harness />);
    fireEvent.click(screen.getByRole('button', { name: '더보기' }));
    expect(screen.queryByText(/스레드를 찾는 데 요청이 많이 들어서/)).toBeNull();
    fireEvent.click(screen.getByRole('checkbox', { name: '스레드 포함' }));
    expect(screen.getByRole('status').textContent).toContain('스레드를 찾는 데 요청이 많이 들어서');
    fireEvent.click(screen.getByRole('checkbox', { name: '스레드 포함' }));
    expect(screen.queryByText(/스레드를 찾는 데 요청이 많이 들어서/)).toBeNull();
  });

  it('explains "새 메시지만", and warns about a gap only while a limit is set', () => {
    render(<Harness />);
    fireEvent.click(screen.getByRole('button', { name: '더보기' }));
    expect(screen.getByText('지난번에 받은 이후의 메시지만 내려받아요.')).toBeTruthy();
    expect(screen.queryByText(/그 사이가 비어요/)).toBeNull();
    fireEvent.click(screen.getByRole('checkbox', { name: '새 메시지만 받기' }));
    expect(screen.getByText(/개수 제한\(200개\)과 함께 쓰면.*그 사이가 비어요/)).toBeTruthy();
    fireEvent.click(screen.getByRole('radio', { name: '전체' }));
    expect(screen.queryByText(/그 사이가 비어요/)).toBeNull();
  });
});

describe('language and "ZIP 하나로 받기" (common settings only)', () => {
  it('the common variant has the language control with its note and the ZIP checkbox with its note', () => {
    render(<Harness variant="common" />);
    expect(screen.getByRole('radiogroup', { name: '언어' })).toBeTruthy();
    expect(screen.getAllByRole('radio', { name: /자동|한국어|English/ }).map((radio) => radio.textContent)).toEqual(['자동', '한국어', 'English']);
    expect(screen.getByText(/앱 화면과 내보낸 파일 안의 고정 문구/)).toBeTruthy();
    expect(screen.getByRole('checkbox', { name: 'ZIP 하나로 받기' })).toBeTruthy();
    expect(screen.getByText('체크하면 여러 채팅을 ZIP 파일 하나로 저장해요.')).toBeTruthy();
  });

  it('the item variant has neither', () => {
    render(<Harness variant="item" />);
    expect(screen.queryByRole('radiogroup', { name: '언어' })).toBeNull();
    expect(screen.queryByRole('checkbox', { name: 'ZIP 하나로 받기' })).toBeNull();
    expect(document.querySelector('[data-variant="item"]')).not.toBeNull();
    // ...but every other field
    expect(screen.getByRole('radiogroup', { name: '형식' })).toBeTruthy();
    expect(screen.getByRole('spinbutton')).toBeTruthy();
    expect(screen.getByLabelText('시작일')).toBeTruthy();
    expect(screen.getByRole('button', { name: '더보기' })).toBeTruthy();
  });

  it('choosing a language and the ZIP option are reported separately from the export settings', () => {
    const onChange = vi.fn();
    const onLanguageChange = vi.fn();
    const onZipAllChange = vi.fn();
    render(<Harness onChange={onChange} onLanguageChange={onLanguageChange} onZipAllChange={onZipAllChange} />);
    fireEvent.click(screen.getByRole('radio', { name: 'English' }));
    expect(onLanguageChange).toHaveBeenCalledWith('en');
    fireEvent.click(screen.getByRole('radio', { name: '한국어' }));
    expect(onLanguageChange).toHaveBeenLastCalledWith('ko');
    fireEvent.click(screen.getByRole('checkbox', { name: 'ZIP 하나로 받기' }));
    expect(onZipAllChange).toHaveBeenCalledWith(true);
    fireEvent.click(screen.getByRole('checkbox', { name: 'ZIP 하나로 받기' }));
    expect(onZipAllChange).toHaveBeenLastCalledWith(false);
    expect(onChange).not.toHaveBeenCalled();
  });

  it('the language names are shown in their own language, whatever the app language is', () => {
    render(<Harness locale="en" />);
    expect(screen.getByRole('radio', { name: '한국어' })).toBeTruthy();
    expect(screen.getByRole('radio', { name: 'English' })).toBeTruthy();
    expect(screen.getByRole('radio', { name: 'Auto' })).toBeTruthy();
  });
});

describe('validity', () => {
  it('reports true when it appears, false while an input is invalid, true again once it is fixed', () => {
    const onValidityChange = vi.fn();
    render(<Harness variant="item" onValidityChange={onValidityChange} />);
    expect(onValidityChange.mock.calls).toEqual([[true]]);
    type(countInput(), '0');
    expect(onValidityChange).toHaveBeenLastCalledWith(false);
    type(countInput(), '5');
    expect(onValidityChange).toHaveBeenLastCalledWith(true);
    type(dateInput('시작일'), '2026-03-20');
    type(dateInput('종료일'), '2026-03-01');
    expect(onValidityChange).toHaveBeenLastCalledWith(false);
    type(dateInput('종료일'), '');
    expect(onValidityChange).toHaveBeenLastCalledWith(true);
  });

  it('reports a change of validity once, not on every keystroke', () => {
    const onValidityChange = vi.fn();
    render(<Harness variant="item" onValidityChange={onValidityChange} />);
    type(countInput(), '');
    type(countInput(), 'a');
    type(countInput(), '-1');
    expect(onValidityChange.mock.calls).toEqual([[true], [false]]);
  });

  it('changing another field while one is invalid drops the invalid text: the last valid value is shown again and the panel is valid', () => {
    const onChange = vi.fn();
    const onValidityChange = vi.fn();
    render(<Harness variant="item" onChange={onChange} onValidityChange={onValidityChange} />);
    type(countInput(), '0');
    expect(onValidityChange).toHaveBeenLastCalledWith(false);
    fireEvent.click(format('JSON'));
    // the format change is reported, built on the last valid values...
    expect(lastCall(onChange)).toMatchObject({ format: 'json', count: 200 });
    // ...and the count shows what is really going to be saved
    expect(countInput().value).toBe('200');
    expect(screen.queryByRole('alert')).toBeNull();
    expect(onValidityChange).toHaveBeenLastCalledWith(true);
  });
});

describe('the value changes from outside', () => {
  it('shows a new value (a revert, a change in storage)', () => {
    const setterRef: HarnessProps['setterRef'] = { current: null };
    render(<Harness setterRef={setterRef} />);
    act(() => setterRef.current?.({ ...DEFAULT_EXPORT_SETTINGS, count: 42, format: 'md', from: startOfDayIso('2026-05-06'), content: { ...DEFAULT_EXPORT_SETTINGS.content } }));
    expect(countInput().value).toBe('42');
    expect(dateInput('시작일').value).toBe('2026-05-06');
    expect(format('Markdown').getAttribute('aria-checked')).toBe('true');
  });

  it('shows "전체" when the new value has no limit', () => {
    const setterRef: HarnessProps['setterRef'] = { current: null };
    render(<Harness setterRef={setterRef} />);
    act(() => setterRef.current?.({ ...DEFAULT_EXPORT_SETTINGS, count: null, content: { ...DEFAULT_EXPORT_SETTINGS.content } }));
    expect(screen.queryByRole('spinbutton')).toBeNull();
    expect(screen.getByRole('radio', { name: '전체' }).getAttribute('aria-checked')).toBe('true');
  });

  it('works on the frozen defaults and never hands them out: reports copies', () => {
    const onChange = vi.fn();
    render(<SettingsPanel variant="item" value={DEFAULT_EXPORT_SETTINGS} onChange={onChange} />);
    fireEvent.click(format('TXT'));
    const reported = lastCall(onChange);
    expect(reported).not.toBe(DEFAULT_EXPORT_SETTINGS);
    expect(reported.content).not.toBe(DEFAULT_EXPORT_SETTINGS.content);
    expect(Object.isFrozen(reported)).toBe(false);
    expect(DEFAULT_EXPORT_SETTINGS.format).toBe('html');
  });
});

describe('English', () => {
  it('has the same panel in English', () => {
    const onChange = vi.fn();
    render(<Harness locale="en" onChange={onChange} />);
    expect(screen.getByRole('radiogroup', { name: 'Format' })).toBeTruthy();
    expect(screen.getByRole('radio', { name: /^HTML.*recommended/ })).toBeTruthy();
    expect(screen.getByRole('radiogroup', { name: 'HTML theme' })).toBeTruthy();
    expect(screen.getByRole('radiogroup', { name: 'Number of messages' })).toBeTruthy();
    expect(screen.getByRole('spinbutton', { name: 'Messages to export' })).toBeTruthy();
    expect(screen.getByLabelText('From')).toBeTruthy();
    expect(screen.getByLabelText('To')).toBeTruthy();
    expect(screen.getByText('Leave empty to export every date.')).toBeTruthy();
    expect(screen.getByRole('checkbox', { name: 'Save as one ZIP' })).toBeTruthy();
    fireEvent.change(screen.getByRole('spinbutton', { name: 'Messages to export' }), { target: { value: '0' } });
    expect(screen.getByRole('alert').textContent).toBe('Enter a number from 1 to 1,000,000.');
    fireEvent.click(screen.getByRole('radio', { name: 'All' }));
    expect(lastCall(onChange).count).toBeNull();
  });
});
