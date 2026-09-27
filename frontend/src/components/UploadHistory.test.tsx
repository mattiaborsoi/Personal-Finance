import { screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { statement, uploadResult } from '../test/fixtures';
import { mockFetch, renderWithProviders } from '../test/utils';
import { UploadHistory } from './UploadHistory';
import { UploadResultCard } from './UploadResultCard';

describe('statement period labels', () => {
  it('shows the months a statement spans in the previous uploads list', () => {
    mockFetch(() => undefined);
    renderWithProviders(
      <UploadHistory
        statements={[
          statement({ id: 'a', filename: 'quarter.pdf', period_key: '2026-07', period_from: '2026-05', period_to: '2026-07' }),
          statement({ id: 'b', filename: 'july.pdf', period_key: '2026-07', period_from: '2026-07', period_to: '2026-07' }),
          statement({ id: 'c', filename: 'legacy.csv', period_key: '2026-06', period_from: null, period_to: null }),
        ]}
      />,
    );

    expect(screen.getByText('May–Jul 2026')).toBeInTheDocument();
    expect(screen.getByText('July 2026')).toBeInTheDocument();
    expect(screen.getByText('June 2026')).toBeInTheDocument();
  });

  it('shows the span on the upload result card and links the review to the statement period', () => {
    mockFetch(() => undefined);
    renderWithProviders(<UploadResultCard result={uploadResult({ period_from: '2026-05', period_to: '2026-07' })} />);

    expect(screen.getByRole('status')).toHaveTextContent('Into Amex Platinum ··7715 for May–Jul 2026');
    expect(screen.getByRole('link', { name: /review the 3 pending/i })).toHaveAttribute('href', '/?period=2026-07');
  });
});
