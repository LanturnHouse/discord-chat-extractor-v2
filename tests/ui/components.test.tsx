// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Badge } from '@/ui/components/Badge';
import { Button, IconButton } from '@/ui/components/Button';
import { Checkbox } from '@/ui/components/Checkbox';
import { DateInput } from '@/ui/components/DateInput';
import * as Icons from '@/ui/components/Icons';
import { NumberInput } from '@/ui/components/NumberInput';
import { ProgressBar } from '@/ui/components/ProgressBar';
import { RadioGroup } from '@/ui/components/RadioGroup';
import { SplitButton } from '@/ui/components/SplitButton';
import { Toggle } from '@/ui/components/Toggle';
import { useEscapeKey } from '@/ui/components/hooks';
import { LocaleProvider, useLocale, useNumberFormat, useStrings } from '@/ui/i18n/locale';
import { defineStrings } from '@/ui/i18n/core';

afterEach(cleanup); // vitest globals are off, so testing-library cannot register its own cleanup

describe('Button / IconButton', () => {
  it('is type="button" by default (it never submits a surrounding form) and carries its variant and size', () => {
    render(
      <form onSubmit={(event) => event.preventDefault()}>
        <Button variant="danger" size="sm">
          Delete
        </Button>
      </form>,
    );
    const button = screen.getByRole('button', { name: 'Delete' });
    expect(button.getAttribute('type')).toBe('button');
    expect(button.className).toContain('dce-button--danger');
    expect(button.className).toContain('dce-button--sm');
  });

  it('renders every variant', () => {
    render(
      <>
        {(['primary', 'secondary', 'danger', 'ghost', 'link'] as const).map((variant) => (
          <Button key={variant} variant={variant}>
            {variant}
          </Button>
        ))}
      </>,
    );
    for (const variant of ['primary', 'secondary', 'danger', 'ghost', 'link']) expect(screen.getByRole('button', { name: variant }).className).toContain(`dce-button--${variant}`);
  });

  it('an enabled primary button has no disabled marker and no inline colour; a disabled one has the disabled attribute', () => {
    const { rerender } = render(<Button>Save</Button>);
    const button = screen.getByRole('button', { name: 'Save' }) as HTMLButtonElement;
    expect(button.className).toContain('dce-button--primary');
    expect(button.disabled).toBe(false);
    expect(button.hasAttribute('aria-disabled')).toBe(false);
    expect(button.hasAttribute('style')).toBe(false);
    rerender(<Button disabled>Save</Button>);
    expect(button.disabled).toBe(true);
  });

  it('shows an icon in front of the text and is disabled when asked', () => {
    const onClick = vi.fn();
    render(
      <Button icon={<Icons.Download />} disabled onClick={onClick}>
        Save
      </Button>,
    );
    const button = screen.getByRole('button', { name: 'Save' }) as HTMLButtonElement;
    expect(button.querySelector('svg')).not.toBeNull();
    expect(button.disabled).toBe(true);
    fireEvent.click(button);
    expect(onClick).not.toHaveBeenCalled();
  });

  it('IconButton needs a label: it is the accessible name and the tooltip', () => {
    const onClick = vi.fn();
    render(
      <IconButton label="Remove" tone="danger" onClick={onClick}>
        <Icons.Close />
      </IconButton>,
    );
    const button = screen.getByRole('button', { name: 'Remove' });
    expect(button.getAttribute('title')).toBe('Remove');
    expect(button.className).toContain('dce-icon-button--danger');
    fireEvent.click(button);
    expect(onClick).toHaveBeenCalledTimes(1);
  });
});

describe('SplitButton (v1 download button)', () => {
  it('is two real buttons: the main part and the caret', () => {
    const onMain = vi.fn();
    const onCaret = vi.fn();
    render(<SplitButton label="Download all" chip="HTML" icon={<Icons.Download />} onMain={onMain} caretLabel="Open settings" onCaret={onCaret} />);
    const main = screen.getByRole('button', { name: /Download all/ });
    const caret = screen.getByRole('button', { name: 'Open settings' });
    expect(main.textContent).toContain('HTML');
    fireEvent.click(main);
    expect(onMain).toHaveBeenCalledTimes(1);
    expect(onCaret).not.toHaveBeenCalled();
    fireEvent.click(caret);
    expect(onCaret).toHaveBeenCalledTimes(1);
  });

  it('a disabled main part ignores clicks and says why, while the caret still works', () => {
    const onMain = vi.fn();
    const onCaret = vi.fn();
    render(<SplitButton label="Download all" onMain={onMain} mainDisabled mainTitle="Nothing to download" caretLabel="Open settings" onCaret={onCaret} />);
    const main = screen.getByRole('button', { name: /Download all/ });
    expect(main.getAttribute('aria-disabled')).toBe('true');
    expect(main.getAttribute('title')).toBe('Nothing to download');
    fireEvent.click(main);
    expect(onMain).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Open settings' }));
    expect(onCaret).toHaveBeenCalledTimes(1);
  });

  it('an enabled split button carries no disabled marker at all (the dimmed style keys on them); a disabled main part does, the caret never', () => {
    const props = { label: 'Download all', chip: 'HTML', onMain: () => undefined, caretLabel: 'Open settings', onCaret: () => undefined };
    const { container, rerender } = render(<SplitButton {...props} />);
    const pill = container.querySelector('.dce-split')!;
    const main = screen.getByRole('button', { name: /Download all/ }) as HTMLButtonElement;
    const caret = screen.getByRole('button', { name: 'Open settings' }) as HTMLButtonElement;
    expect(pill.hasAttribute('data-unavailable')).toBe(false);
    for (const part of [main, caret]) {
      expect(part.disabled).toBe(false);
      expect(part.hasAttribute('aria-disabled')).toBe(false);
      expect(part.hasAttribute('style')).toBe(false); // no inline colour either
    }
    rerender(<SplitButton {...props} mainDisabled />);
    expect(pill.hasAttribute('data-unavailable')).toBe(true);
    expect(main.getAttribute('aria-disabled')).toBe('true');
    expect(caret.hasAttribute('aria-disabled')).toBe(false);
    rerender(<SplitButton {...props} mainDisabled={false} />);
    expect(pill.hasAttribute('data-unavailable')).toBe(false);
    expect(main.hasAttribute('aria-disabled')).toBe(false);
  });

  it('puts the focus id on the caret', () => {
    render(<SplitButton label="Go" onMain={() => undefined} caretLabel="More" onCaret={() => undefined} caretFocusId="common-settings" />);
    expect(screen.getByRole('button', { name: 'More' }).getAttribute('data-focus-id')).toBe('common-settings');
  });
});

describe('Toggle (switch)', () => {
  it('is a real switch: named by its label, described by its description, toggled by click and Space', () => {
    const onChange = vi.fn();
    render(<Toggle checked={false} onChange={onChange} label="Show buttons" description="On the channel rows" />);
    const toggle = screen.getByRole('switch', { name: 'Show buttons' }) as HTMLInputElement;
    expect(toggle.checked).toBe(false);
    expect(toggle.getAttribute('aria-describedby')).toBeTruthy();
    expect(document.getElementById(toggle.getAttribute('aria-describedby')!)?.textContent).toBe('On the channel rows');
    fireEvent.click(toggle);
    expect(onChange).toHaveBeenCalledWith(true);
  });

  it('reflects `checked` and reports the opposite on change; the label text is clickable too', () => {
    const onChange = vi.fn();
    render(<Toggle checked onChange={onChange} label="Notify" />);
    expect((screen.getByRole('switch', { name: 'Notify' }) as HTMLInputElement).checked).toBe(true);
    fireEvent.click(screen.getByText('Notify'));
    expect(onChange).toHaveBeenCalledWith(false);
  });

  it('a disabled switch cannot be toggled', () => {
    const onChange = vi.fn();
    render(<Toggle checked={false} onChange={onChange} label="Locked" disabled />);
    const toggle = screen.getByRole('switch', { name: 'Locked' }) as HTMLInputElement;
    expect(toggle.disabled).toBe(true);
    fireEvent.click(toggle);
    expect(onChange).not.toHaveBeenCalled();
  });
});

describe('Checkbox', () => {
  it('is a real checkbox named by its label and described by its description', () => {
    const onChange = vi.fn();
    render(<Checkbox checked={false} onChange={onChange} label="Attachments" description="Takes more space" />);
    const box = screen.getByRole('checkbox', { name: 'Attachments' }) as HTMLInputElement;
    expect(document.getElementById(box.getAttribute('aria-describedby')!)?.textContent).toBe('Takes more space');
    fireEvent.click(box);
    expect(onChange).toHaveBeenCalledWith(true);
  });

  it('draws the check and reports unchecking', () => {
    const onChange = vi.fn();
    render(<Checkbox checked onChange={onChange} label="Bots" />);
    const box = screen.getByRole('checkbox', { name: 'Bots' }) as HTMLInputElement;
    expect(box.checked).toBe(true);
    expect(box.closest('label')?.querySelector('.dce-check__box svg')).not.toBeNull();
    fireEvent.click(box);
    expect(onChange).toHaveBeenCalledWith(false);
  });
});

describe('NumberInput', () => {
  function Harness({ initial = '5', min = 1, max = 20 }: { initial?: string; min?: number; max?: number }) {
    const [value, setValue] = useState(initial);
    return <NumberInput value={value} onChange={setValue} min={min} max={max} label="Count" unit="items" />;
  }

  it('is a spinbutton with its range and value', () => {
    render(<Harness />);
    const input = screen.getByRole('spinbutton', { name: 'Count' }) as HTMLInputElement;
    expect(input.getAttribute('aria-valuemin')).toBe('1');
    expect(input.getAttribute('aria-valuemax')).toBe('20');
    expect(input.getAttribute('aria-valuenow')).toBe('5');
    expect(input.getAttribute('inputmode')).toBe('numeric');
    expect(screen.getByText('items')).toBeTruthy();
  });

  it('passes the typed text on as is (the owner validates it) and has no value while it is not a valid number', () => {
    render(<Harness />);
    const input = screen.getByRole('spinbutton', { name: 'Count' }) as HTMLInputElement;
    fireEvent.change(input, { target: { value: '1.5' } });
    expect(input.value).toBe('1.5');
    expect(input.hasAttribute('aria-valuenow')).toBe(false);
    fireEvent.change(input, { target: { value: '99' } }); // out of range
    expect(input.hasAttribute('aria-valuenow')).toBe(false);
    fireEvent.change(input, { target: { value: '7' } });
    expect(input.getAttribute('aria-valuenow')).toBe('7');
  });

  it('ArrowUp / ArrowDown step by 1 (Shift: 10) and stay inside the range', () => {
    render(<Harness initial="5" />);
    const input = screen.getByRole('spinbutton', { name: 'Count' }) as HTMLInputElement;
    fireEvent.keyDown(input, { key: 'ArrowUp' });
    expect(input.value).toBe('6');
    fireEvent.keyDown(input, { key: 'ArrowDown' });
    fireEvent.keyDown(input, { key: 'ArrowDown' });
    expect(input.value).toBe('4');
    fireEvent.keyDown(input, { key: 'ArrowUp', shiftKey: true });
    expect(input.value).toBe('14');
    fireEvent.keyDown(input, { key: 'ArrowUp', shiftKey: true });
    expect(input.value).toBe('20'); // clamped
    fireEvent.keyDown(input, { key: 'ArrowDown', shiftKey: true });
    fireEvent.keyDown(input, { key: 'ArrowDown', shiftKey: true });
    expect(input.value).toBe('1'); // clamped
  });

  it('an arrow key in an unreadable field starts at the minimum', () => {
    render(<Harness initial="abc" min={3} />);
    const input = screen.getByRole('spinbutton', { name: 'Count' }) as HTMLInputElement;
    fireEvent.keyDown(input, { key: 'ArrowDown' });
    expect(input.value).toBe('3');
  });

  it('marks itself invalid and points at its hint', () => {
    render(<NumberInput value="x" onChange={() => undefined} min={1} max={5} label="Count" invalid describedBy="hint" />);
    const input = screen.getByRole('spinbutton', { name: 'Count' });
    expect(input.getAttribute('aria-invalid')).toBe('true');
    expect(input.getAttribute('aria-describedby')).toBe('hint');
  });
});

describe('DateInput', () => {
  it('is a labelled date input; a change reports the day', () => {
    const onChange = vi.fn();
    render(<DateInput value="" partial={false} onChange={onChange} label="From" clearLabel="Clear from" />);
    const input = screen.getByLabelText('From') as HTMLInputElement;
    expect(input.type).toBe('date');
    expect(screen.queryByRole('button', { name: 'Clear from' })).toBeNull(); // nothing to clear
    fireEvent.change(input, { target: { value: '2026-03-05' } });
    expect(onChange).toHaveBeenCalledWith('2026-03-05', false);
  });

  it('shows a clear button while it holds a date and empties the field with it', () => {
    const onChange = vi.fn();
    render(<DateInput value="2026-03-05" partial={false} onChange={onChange} label="From" clearLabel="Clear from" />);
    const clear = screen.getByRole('button', { name: 'Clear from' });
    fireEvent.click(clear);
    expect(onChange).toHaveBeenCalledWith('', false);
    expect((screen.getByLabelText('From') as HTMLInputElement).value).toBe('');
  });

  it('a half-typed date (empty value but a visible partial) also gets a clear button', () => {
    render(<DateInput value="" partial onChange={() => undefined} label="To" clearLabel="Clear to" />);
    expect(screen.getByRole('button', { name: 'Clear to' })).toBeTruthy();
  });

  it('marks itself invalid and points at the error', () => {
    render(<DateInput value="2026-03-05" partial={false} onChange={() => undefined} label="From" clearLabel="Clear" invalid describedBy="err" />);
    const input = screen.getByLabelText('From');
    expect(input.getAttribute('aria-invalid')).toBe('true');
    expect(input.getAttribute('aria-describedby')).toBe('err');
  });
});

describe('RadioGroup (format cards and segmented controls)', () => {
  const options = [
    { value: 'a', label: 'Alpha', description: 'First' },
    { value: 'b', label: 'Beta', description: 'Second' },
    { value: 'c', label: 'Gamma' },
  ] as const;

  function Harness({ variant }: { variant: 'cards' | 'segmented' }) {
    const [value, setValue] = useState<'a' | 'b' | 'c'>('a');
    return <RadioGroup variant={variant} label="Letter" value={value} options={options} onChange={setValue} />;
  }

  it('is a radiogroup of radios; the checked one is the only tab stop', () => {
    render(<Harness variant="cards" />);
    expect(screen.getByRole('radiogroup', { name: 'Letter' })).toBeTruthy();
    const [alpha, beta] = screen.getAllByRole('radio');
    expect(alpha.getAttribute('aria-checked')).toBe('true');
    expect(alpha.tabIndex).toBe(0);
    expect(beta.getAttribute('aria-checked')).toBe('false');
    expect(beta.tabIndex).toBe(-1);
  });

  it('cards show their description (announced as the description) and a check on the chosen one', () => {
    render(<Harness variant="cards" />);
    const alpha = screen.getByRole('radio', { name: /Alpha/ });
    expect(document.getElementById(alpha.getAttribute('aria-describedby')!)?.textContent).toBe('First');
    expect(alpha.querySelector('.dce-radio__check')).not.toBeNull();
    expect(screen.getByRole('radio', { name: /Beta/ }).querySelector('.dce-radio__check')).toBeNull();
    fireEvent.click(screen.getByRole('radio', { name: /Beta/ }));
    expect(screen.getByRole('radio', { name: /Beta/ }).getAttribute('aria-checked')).toBe('true');
    expect(screen.getByRole('radio', { name: /Beta/ }).querySelector('.dce-radio__check')).not.toBeNull();
  });

  it('a segmented control has no check mark', () => {
    render(<Harness variant="segmented" />);
    expect(document.querySelector('.dce-radio--segmented')).not.toBeNull();
    expect(document.querySelector('.dce-radio__check')).toBeNull();
  });

  it('arrow keys move the choice and the focus, wrapping at the ends; Home / End jump', () => {
    render(<Harness variant="segmented" />);
    const group = screen.getByRole('radiogroup', { name: 'Letter' });
    const alpha = screen.getByRole('radio', { name: 'Alpha' });
    alpha.focus();
    fireEvent.keyDown(group, { key: 'ArrowRight' });
    expect(screen.getByRole('radio', { name: /Beta/ }).getAttribute('aria-checked')).toBe('true');
    expect(document.activeElement).toBe(screen.getByRole('radio', { name: /Beta/ }));
    fireEvent.keyDown(group, { key: 'ArrowDown' });
    fireEvent.keyDown(group, { key: 'ArrowDown' }); // wraps to the first
    expect(screen.getByRole('radio', { name: /Alpha/ }).getAttribute('aria-checked')).toBe('true');
    fireEvent.keyDown(group, { key: 'ArrowLeft' }); // wraps to the last
    expect(screen.getByRole('radio', { name: /Gamma/ }).getAttribute('aria-checked')).toBe('true');
    fireEvent.keyDown(group, { key: 'Home' });
    expect(screen.getByRole('radio', { name: /Alpha/ }).getAttribute('aria-checked')).toBe('true');
    fireEvent.keyDown(group, { key: 'End' });
    expect(screen.getByRole('radio', { name: /Gamma/ }).getAttribute('aria-checked')).toBe('true');
    fireEvent.keyDown(group, { key: 'x' }); // other keys do nothing
    expect(screen.getByRole('radio', { name: /Gamma/ }).getAttribute('aria-checked')).toBe('true');
  });
});

describe('ProgressBar', () => {
  it('is a progressbar with its value in percent', () => {
    render(<ProgressBar value={0.426} label="Overall" valueText="3/7" />);
    const bar = screen.getByRole('progressbar', { name: 'Overall' });
    expect(bar.getAttribute('aria-valuenow')).toBe('43');
    expect(bar.getAttribute('aria-valuemin')).toBe('0');
    expect(bar.getAttribute('aria-valuemax')).toBe('100');
    expect(bar.getAttribute('aria-valuetext')).toBe('3/7');
    expect((bar.firstElementChild as HTMLElement).style.width).toBe('42.6%');
  });

  it('clamps a value outside 0..1', () => {
    const { rerender } = render(<ProgressBar value={1.7} label="x" />);
    expect(screen.getByRole('progressbar').getAttribute('aria-valuenow')).toBe('100');
    rerender(<ProgressBar value={-3} label="x" />);
    expect(screen.getByRole('progressbar').getAttribute('aria-valuenow')).toBe('0');
  });

  it('null (an unknown total) is indeterminate: no value, a sliding fill', () => {
    render(<ProgressBar value={null} label="Unknown" />);
    const bar = screen.getByRole('progressbar', { name: 'Unknown' });
    expect(bar.hasAttribute('aria-valuenow')).toBe(false);
    expect(bar.hasAttribute('data-indeterminate')).toBe(true);
    expect((bar.firstElementChild as HTMLElement).style.width).toBe('');
  });

  it('has a tone', () => {
    render(<ProgressBar value={0.5} label="t" tone="warning" />);
    expect(screen.getByRole('progressbar').className).toContain('dce-progress--warning');
  });
});

describe('Badge', () => {
  it('shows its text in a tone', () => {
    render(<Badge tone="brand">Own settings</Badge>);
    expect(screen.getByText('Own settings').className).toContain('dce-badge--brand');
  });
});

describe('Icons', () => {
  const names = ['Download', 'DownloadCaret', 'Check', 'Close', 'Play', 'Retry', 'ChevronDown', 'ChevronUp', 'ChevronRight', 'ArrowLeft', 'External', 'Gear', 'Settings', 'History', 'Folder', 'Warning', 'Info', 'SpinnerIcon', 'Hash', 'ChatBubble', 'Thread', 'Forum'] as const;

  it('has every icon the popup needs (download, check, gear, close, play, history, settings, warning, folder, chevron, external)', () => {
    for (const name of names) expect(typeof Icons[name], name).toBe('function');
  });

  it('every icon is a 1em svg in currentColor, hidden from assistive technology', () => {
    for (const name of names) {
      const Icon = Icons[name];
      const { container, unmount } = render(<Icon />);
      const svg = container.querySelector('svg')!;
      expect(svg, name).not.toBeNull();
      expect(svg.getAttribute('width'), name).toBe('1em');
      expect(svg.getAttribute('viewBox'), name).toBe('0 0 24 24');
      expect(svg.getAttribute('aria-hidden'), name).toBe('true');
      expect(svg.innerHTML, name).not.toContain('#');
      unmount();
    }
  });

  it('an icon with a title is an announced image', () => {
    render(<Icons.Warning title="Problem" />);
    expect(screen.getByRole('img', { name: 'Problem' })).toBeTruthy();
  });

  it('the spinner spins (class) and keeps another class', () => {
    const { container } = render(<Icons.SpinnerIcon className="mine" />);
    expect(container.querySelector('svg')?.getAttribute('class')).toBe('dce-icon-spin mine');
  });
});

describe('useEscapeKey', () => {
  function Probe({ onEscape, enabled = true }: { onEscape: () => void; enabled?: boolean }) {
    useEscapeKey(onEscape, enabled);
    return <input aria-label="field" />;
  }

  it('calls the handler on Escape and nothing else', () => {
    const onEscape = vi.fn();
    render(<Probe onEscape={onEscape} />);
    fireEvent.keyDown(document, { key: 'Enter' });
    expect(onEscape).not.toHaveBeenCalled();
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onEscape).toHaveBeenCalledTimes(1);
  });

  it('does nothing while disabled, and a nearer handler that prevented the key wins', () => {
    const onEscape = vi.fn();
    const { rerender } = render(<Probe onEscape={onEscape} enabled={false} />);
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onEscape).not.toHaveBeenCalled();
    rerender(<Probe onEscape={onEscape} />);
    const handled = new KeyboardEvent('keydown', { key: 'Escape', cancelable: true, bubbles: true });
    handled.preventDefault();
    document.dispatchEvent(handled);
    expect(onEscape).not.toHaveBeenCalled();
  });

  it('ignores Escape while an input method is composing', () => {
    const onEscape = vi.fn();
    render(<Probe onEscape={onEscape} />);
    fireEvent.keyDown(document, { key: 'Escape', isComposing: true });
    expect(onEscape).not.toHaveBeenCalled();
  });

  it('always calls the newest handler and stops listening when it goes away', () => {
    const first = vi.fn();
    const second = vi.fn();
    const { rerender, unmount } = render(<Probe onEscape={first} />);
    rerender(<Probe onEscape={second} />);
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledTimes(1);
    unmount();
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(second).toHaveBeenCalledTimes(1);
  });
});

describe('locale context', () => {
  const strings = defineStrings({
    ko: { hello: '안녕', count: (n: number) => `${n}개` },
    en: { hello: 'Hello', count: (n) => `${n} items` },
  });

  function Probe() {
    const t = useStrings(strings);
    const fmt = useNumberFormat();
    return (
      <p>
        {t.hello} {t.count(1234)} {fmt(1234567)} {useLocale()}
      </p>
    );
  }

  it('gives the strings and the number format of the language of the nearest provider', () => {
    const { rerender } = render(
      <LocaleProvider locale="ko">
        <Probe />
      </LocaleProvider>,
    );
    expect(screen.getByText('안녕 1234개 1,234,567 ko')).toBeTruthy();
    rerender(
      <LocaleProvider locale="en">
        <Probe />
      </LocaleProvider>,
    );
    expect(screen.getByText('Hello 1234 items 1,234,567 en')).toBeTruthy();
  });

  it('Korean is the language without a provider', () => {
    render(<Probe />);
    expect(screen.getByText(/안녕/)).toBeTruthy();
  });
});
