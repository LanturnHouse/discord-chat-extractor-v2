// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

afterEach(cleanup); // vitest globals are off, so testing-library cannot register its own cleanup

describe('per-file jsdom opt-in', () => {
  it('has a DOM', () => {
    expect(typeof document).toBe('object');
    expect(document.createElement('div').tagName).toBe('DIV');
  });

  it('renders TSX with the React plugin and testing-library', () => {
    render(<p>Discord Chat Extractor v2</p>);
    expect(screen.getByText('Discord Chat Extractor v2')).toBeTruthy();
  });
});
