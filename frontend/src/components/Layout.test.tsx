import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Route, Routes } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import { jsonResponse, mockFetch, renderWithProviders } from '../test/utils';
import { Layout } from './Layout';

describe('<Layout />', () => {
  it('offers a skip link as the first stop that lands on the main content', async () => {
    const user = userEvent.setup();
    mockFetch(({ method, url }) => (method === 'GET' && url === '/api/periods' ? jsonResponse([]) : undefined));

    renderWithProviders(
      <Routes>
        <Route element={<Layout />}>
          <Route index element={<p>Page body</p>} />
        </Route>
      </Routes>,
    );

    const skip = screen.getByRole('link', { name: 'Skip to content' });
    expect(skip).toHaveAttribute('href', '#main');
    const main = screen.getByRole('main');
    expect(main).toHaveAttribute('id', 'main');
    expect(main).toHaveAttribute('tabindex', '-1');
    expect(main).toHaveTextContent('Page body');

    await user.tab();
    expect(skip).toHaveFocus();
  });
});
