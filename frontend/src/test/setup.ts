import '@testing-library/jest-dom/vitest';
import { afterEach, beforeEach, vi } from 'vitest';
import { cleanup } from '@testing-library/react';
import { resetCategorySuggestions } from '../lib/categorySuggestions';

beforeEach(() => {
  localStorage.clear();
  // First-use tips stay out of the way unless a test asks for them (by removing this key).
  localStorage.setItem('settl.tip.claim-types', 'seen');
});

afterEach(() => {
  cleanup();
  resetCategorySuggestions();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
