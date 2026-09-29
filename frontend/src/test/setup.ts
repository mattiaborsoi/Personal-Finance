import '@testing-library/jest-dom/vitest';
import { afterEach, beforeEach, vi } from 'vitest';
import { cleanup } from '@testing-library/react';
import { resetCategorySuggestions } from '../lib/categorySuggestions';

beforeEach(() => {
  localStorage.clear();
});

afterEach(() => {
  cleanup();
  resetCategorySuggestions();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
