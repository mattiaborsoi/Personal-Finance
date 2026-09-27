import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { applyTheme } from './theme';

function metas(): HTMLMetaElement[] {
  return Array.from(document.querySelectorAll<HTMLMetaElement>('meta[name="theme-color"]'));
}

describe('applyTheme', () => {
  beforeEach(() => {
    document.head.innerHTML =
      '<meta name="theme-color" content="#f7f7f4" media="(prefers-color-scheme: light)" />' +
      '<meta name="theme-color" content="#0f0f0e" media="(prefers-color-scheme: dark)" />';
  });
  afterEach(() => {
    document.head.innerHTML = '';
    document.documentElement.removeAttribute('data-theme');
  });

  it('paints the browser chrome in the chosen theme, whatever the OS prefers', () => {
    applyTheme('dark');
    expect(document.documentElement).toHaveAttribute('data-theme', 'dark');
    expect(metas().map((m) => m.content)).toEqual(['#0f0f0e', '#0f0f0e']);

    applyTheme('light');
    expect(metas().map((m) => m.content)).toEqual(['#f7f7f4', '#f7f7f4']);
  });

  it('hands the chrome back to the OS scheme for "system"', () => {
    applyTheme('dark');
    applyTheme('system');
    expect(document.documentElement).not.toHaveAttribute('data-theme');
    expect(metas().map((m) => m.content)).toEqual(['#f7f7f4', '#0f0f0e']);
  });
});
