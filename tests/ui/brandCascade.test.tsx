// @vitest-environment jsdom
/**
 * Text inside a brand-filled control is white, checked on the rendered markup (docs/PLAN.md §7.4, 4th change).
 *
 * tests/ui/brandText.test.ts reads the colour a rule declares ON the control. That is not enough: a span inside the control
 * (the label of a segmented option, the text of a split button) can declare a colour of its own, and then the control's colour
 * never reaches the text. Here the real components are rendered, and the text colour of every element is worked out the way the
 * browser does it (specificity, source order, inheritance, `var()`), against the palette of the stylesheet and against the
 * values measured on the live "midnight" theme.
 */
import { cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { DEFAULT_EXPORT_SETTINGS } from '@/shared';
import { Button } from '@/ui/components/Button';
import { Download } from '@/ui/components/Icons';
import { RadioGroup } from '@/ui/components/RadioGroup';
import { SplitButton } from '@/ui/components/SplitButton';
import { LocaleProvider } from '@/ui/i18n/locale';
import { SettingsPanel } from '@/ui/settings/SettingsPanel';
import { allRules, chainOf, effectiveColor, effectiveFill, resolve, stylesheetProps } from './cssCascade';

afterEach(cleanup); // vitest globals are off, so testing-library cleans up only when told to

/** Measured on the live page (theme "midnight"): what the content script captures into `dce.theme`. */
const MIDNIGHT = {
  '--brand-500': 'hsl(234.935 85.556% 64.706%)',
  '--brand-560': 'hsl(234.72 51.44% 52.353%)',
  '--white': 'hsl(0 0% 100%)',
  '--control-brand-foreground': 'hsl(229.381 96.581% 77.059%)',
} as const;

/** The palettes a colour is checked against: the stylesheet's own (dark, light: the popup before / without a captured theme) and Discord's. */
const PALETTES: ReadonlyArray<{ name: string; props: Record<string, string>; white: string }> = [
  { name: 'fallback dark', props: stylesheetProps('dark'), white: '#fff' },
  { name: 'fallback light', props: stylesheetProps('light'), white: '#fff' },
  { name: 'midnight', props: { ...stylesheetProps('dark'), ...MIDNIGHT }, white: MIDNIGHT['--white'] },
  { name: 'midnight (light stylesheet underneath)', props: { ...stylesheetProps('light'), ...MIDNIGHT }, white: MIDNIGHT['--white'] },
];

const FILL = /^var\(--dce-(?:brand|danger)(?:-hover|-active)?\)$/;

/** Every element of `root` (and `root`) that is painted on a brand / danger fill and shows text or an icon. */
function textOnFill(root: Element): Element[] {
  const hasText = (element: Element): boolean =>
    element.tagName.toLowerCase() === 'svg' || Array.from(element.childNodes).some((node) => node.nodeType === 3 && (node.textContent ?? '').trim() !== '');
  return [root, ...Array.from(root.querySelectorAll('*'))].filter((element) => {
    const fill = effectiveFill(chainOf(element, root));
    return fill !== undefined && FILL.test(fill) && hasText(element);
  });
}

function expectWhiteOn(elements: readonly Element[], root: Element, hover: readonly Element[] = []): void {
  for (const element of elements) {
    const chain = chainOf(element, root, hover);
    for (const palette of PALETTES) {
      const label = `<${element.tagName.toLowerCase()} class="${element.getAttribute('class') ?? ''}"> "${(element.textContent ?? '').trim().slice(0, 20)}" in ${palette.name}`;
      expect(effectiveColor(chain, palette.props), label).toBe(palette.white);
    }
  }
}

const OPTIONS = [
  { value: 'a', label: 'Alpha' },
  { value: 'b', label: 'Beta' },
] as const;

// --- the segmented control: the bug was a label span that kept its own colour ------------------------------------------

describe('segmented control: the label takes the colour of its option', () => {
  const renderSegmented = (): { root: HTMLElement; selected: HTMLElement; other: HTMLElement } => {
    const { container } = render(<RadioGroup variant="segmented" label="Letter" value="a" options={OPTIONS} onChange={() => undefined} />);
    const root = container.firstElementChild as HTMLElement;
    const [selected, other] = Array.from(root.querySelectorAll<HTMLElement>('.dce-radio__option'));
    return { root, selected, other };
  };

  it('the selected option is white on the brand fill, down to the label span inside it', () => {
    const { root, selected } = renderSegmented();
    expect(selected.getAttribute('aria-checked')).toBe('true');
    const label = selected.querySelector('.dce-radio__label')!;
    expect(effectiveFill(chainOf(label, root))).toBe('var(--dce-brand)');
    expectWhiteOn([selected, selected.querySelector('.dce-radio__text')!, label], root);
  });

  it('it stays white while hovered (the hover colour of an unselected option must not win)', () => {
    const { root, selected } = renderSegmented();
    expectWhiteOn([selected, selected.querySelector('.dce-radio__label')!], root, [selected]);
  });

  it('an unselected option has normal text: --dce-text, --dce-text-strong on hover; never the icon / muted grey', () => {
    const { root, other } = renderSegmented();
    const label = other.querySelector('.dce-radio__label')!;
    for (const palette of PALETTES) {
      expect(effectiveColor(chainOf(label, root), palette.props), palette.name).toBe(resolve('var(--dce-text)', palette.props));
      expect(effectiveColor(chainOf(label, root, [other]), palette.props), palette.name).toBe(resolve('var(--dce-text-strong)', palette.props));
      for (const muted of ['--dce-text-muted', '--dce-icon']) {
        expect(effectiveColor(chainOf(label, root), palette.props), `${palette.name} vs ${muted}`).not.toBe(resolve(`var(${muted})`, palette.props));
      }
    }
  });

  it('the check would catch the old bug: without the segmented label rule the selected label renders in --dce-text-strong', () => {
    const { root, selected } = renderSegmented();
    const label = selected.querySelector('.dce-radio__label')!;
    const kept = allRules().filter((rule) => !rule.selectors.includes('.dce-radio--segmented .dce-radio__label'));
    expect(kept.length).toBe(allRules().length - 1); // the rule exists, and only it is left out
    const broken = effectiveColor(chainOf(label, root), stylesheetProps('dark'), kept);
    expect(broken).toBe(resolve('var(--dce-text-strong)', stylesheetProps('dark')));
    expect(broken).not.toBe('#fff');
  });

  it('the format cards keep their strong label (their selected state is a tint with a check, not a brand fill)', () => {
    const { container } = render(<RadioGroup variant="cards" label="Letter" value="a" options={OPTIONS} onChange={() => undefined} />);
    const root = container.firstElementChild as HTMLElement;
    const label = root.querySelector('.dce-radio__option[aria-checked="true"] .dce-radio__label')!;
    expect(effectiveFill(chainOf(label, root))).not.toMatch(FILL);
    for (const palette of PALETTES) expect(effectiveColor(chainOf(label, root), palette.props), palette.name).toBe(resolve('var(--dce-text-strong)', palette.props));
  });
});

// --- the split button: main, icon, label, chip, caret ------------------------------------------------------------------

describe('split button: every part is white on the brand fill, enabled or not', () => {
  const renderSplit = (mainDisabled: boolean): HTMLElement => {
    const { container } = render(
      <SplitButton label="Download all" chip="HTML" icon={<Download />} caretLabel="Options" mainDisabled={mainDisabled} onMain={() => undefined} onCaret={() => undefined} />,
    );
    return container.firstElementChild as HTMLElement;
  };

  it.each([false, true])('with mainDisabled=%s: the pill, both buttons, the icon, the label, the chip and the caret icon', (mainDisabled) => {
    const root = renderSplit(mainDisabled);
    const parts = [
      root,
      root.querySelector('.dce-split__main')!,
      root.querySelector('.dce-split__icon')!,
      root.querySelector('.dce-split__label')!,
      root.querySelector('.dce-split__chip')!,
      root.querySelector('.dce-split__caret')!,
      root.querySelector('.dce-split__caret svg')!,
    ];
    expectWhiteOn(parts, root);
    expectWhiteOn(parts.slice(1), root, [root.querySelector('.dce-split__main')!, root.querySelector('.dce-split__caret')!]);
  });

  it('the text-bearing parts sit on the brand fill (so the scan below really looks at them)', () => {
    const root = renderSplit(false);
    const scanned = textOnFill(root);
    expect(scanned).toContain(root.querySelector('.dce-split__label'));
    expect(scanned).toContain(root.querySelector('.dce-split__caret svg'));
  });
});

// --- buttons ------------------------------------------------------------------------------------------------------------

describe('primary and danger buttons: white text and icon', () => {
  it.each(['primary', 'danger'] as const)('%s, with an icon, enabled and disabled', (variant) => {
    for (const disabled of [false, true]) {
      const { container, unmount } = render(
        <Button variant={variant} icon={<Download />} disabled={disabled}>
          Save
        </Button>,
      );
      const root = container.firstElementChild as HTMLElement;
      expect(textOnFill(root).length).toBeGreaterThanOrEqual(2); // the button itself and its icon
      expectWhiteOn(textOnFill(root), root);
      unmount();
    }
  });

  it('secondary, ghost and link buttons are not scanned as filled (they are not brand buttons)', () => {
    for (const variant of ['secondary', 'ghost', 'link'] as const) {
      const { container, unmount } = render(<Button variant={variant}>Text</Button>);
      expect(textOnFill(container.firstElementChild as HTMLElement)).toEqual([]);
      unmount();
    }
  });
});

// --- the whole settings panel: whatever is painted brand has white text ---------------------------------------------------

describe('settings panel: every text or icon on a brand fill is white', () => {
  const noop = (): void => undefined;
  const settings = { ...DEFAULT_EXPORT_SETTINGS, count: 100 };

  it('common settings (format cards, segmented controls, chips, toggles, checkboxes)', () => {
    const { container } = render(
      <LocaleProvider locale="ko">
        <SettingsPanel variant="common" value={settings} onChange={noop} language="auto" onLanguageChange={noop} zipAll={false} onZipAllChange={noop} />
      </LocaleProvider>,
    );
    const root = container.firstElementChild as HTMLElement;
    const scanned = textOnFill(root);
    // the selected options of the segmented controls, their label spans, and the pressed count chip
    expect(scanned.some((element) => element.classList.contains('dce-radio__label'))).toBe(true);
    expect(scanned.some((element) => element.classList.contains('dce-sp__chip'))).toBe(true);
    expectWhiteOn(scanned, root);
  });

  it('item settings', () => {
    const { container } = render(
      <LocaleProvider locale="en">
        <SettingsPanel variant="item" value={settings} onChange={noop} />
      </LocaleProvider>,
    );
    const root = container.firstElementChild as HTMLElement;
    const scanned = textOnFill(root);
    expect(scanned.length).toBeGreaterThanOrEqual(3);
    expectWhiteOn(scanned, root);
  });
});
