/** @type {import('tailwindcss').Config} */

// Every colour maps to a CSS variable declared in src/index.css, so light and dark
// mode are the same components with different token values.
const token = (name) => `rgb(var(--color-${name}) / <alpha-value>)`;

export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  darkMode: ['selector', '[data-theme="dark"]'],
  theme: {
    extend: {
      fontFamily: {
        sans: ['"Inter Variable"', 'Inter', 'system-ui', '-apple-system', '"Segoe UI"', 'sans-serif'],
      },
      colors: {
        bg: token('bg'),
        surface: { DEFAULT: token('surface'), 2: token('surface-2'), 3: token('surface-3') },
        ink: { DEFAULT: token('ink'), 2: token('ink-2'), 3: token('ink-3') },
        hairline: { DEFAULT: token('hairline'), strong: token('hairline-strong') },
        brand: { DEFAULT: token('brand'), strong: token('brand-strong'), soft: token('brand-soft') },
        accent: {
          macro: token('accent-macro'),
          micro: token('accent-micro'),
          liquidity: token('accent-liquidity'),
        },
        good: { DEFAULT: token('good'), ink: token('good-ink') },
        warning: { DEFAULT: token('warning'), ink: token('warning-ink') },
        critical: { DEFAULT: token('critical'), ink: token('critical-ink') },
      },
      borderRadius: {
        xl: '0.875rem',
        '2xl': '1.125rem',
        '3xl': '1.5rem',
      },
      fontSize: {
        '2xs': ['0.6875rem', { lineHeight: '1rem', letterSpacing: '0.06em' }],
      },
      transitionTimingFunction: {
        out: 'cubic-bezier(0.2, 0.7, 0.2, 1)',
      },
    },
  },
  plugins: [],
};
