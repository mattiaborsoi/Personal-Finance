import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { BrandMark, PRODUCT_NAME, Wordmark } from './BrandMark';

describe('<BrandMark />', () => {
  it('is decorative, square and sized on request', () => {
    render(<BrandMark size={16} />);

    const mark = screen.getByTestId('brand-mark');
    expect(mark).toHaveAttribute('aria-hidden', 'true');
    expect(mark).toHaveAttribute('focusable', 'false');
    expect(mark).toHaveAttribute('width', '16');
    expect(mark).toHaveAttribute('height', '16');
    expect(mark).toHaveAttribute('viewBox', '0 0 32 32');
  });

  it('draws the S as two halves on a brand tile', () => {
    render(<BrandMark />);

    const mark = screen.getByTestId('brand-mark');
    expect(mark.querySelector('rect')).toHaveClass('fill-brand');
    expect(mark.querySelectorAll('path')).toHaveLength(2);
    expect(mark).toHaveAttribute('width', '28');
  });
});

describe('<Wordmark />', () => {
  it('reads as the product name alone, untranslated', () => {
    const { container } = render(<Wordmark />);

    expect(container).toHaveTextContent(/^Settl$/);
    expect(screen.getByText(PRODUCT_NAME)).toHaveAttribute('translate', 'no');
    expect(screen.getByTestId('brand-mark')).toBeInTheDocument();
  });
});
