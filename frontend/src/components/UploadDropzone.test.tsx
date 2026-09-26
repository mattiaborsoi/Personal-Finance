import { fireEvent, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { mockFetch, renderWithProviders } from '../test/utils';
import { UploadDropzone } from './UploadDropzone';

function choose(name: string) {
  const input = screen.getByLabelText(/choose a file/i) as HTMLInputElement;
  const file = new File(['x'], name);
  fireEvent.change(input, { target: { files: [file] } });
  return file;
}

describe('<UploadDropzone />', () => {
  it('accepts the legacy .xls format the backend supports and rejects anything else', () => {
    mockFetch(() => undefined);
    const onFile = vi.fn();
    renderWithProviders(<UploadDropzone file={null} onFile={onFile} />);

    expect(screen.getByLabelText(/choose a file/i)).toHaveAttribute('accept', expect.stringContaining('.xls'));
    expect(screen.getByText('Drag a PDF, CSV, XLSX or XLS statement here')).toBeInTheDocument();

    const xls = choose('march.XLS');
    expect(onFile).toHaveBeenCalledWith(xls);

    choose('notes.txt');
    expect(screen.getByRole('alert')).toHaveTextContent('Only PDF, CSV, XLSX or XLS statements are supported.');
    expect(onFile).toHaveBeenCalledTimes(1);
  });
});
