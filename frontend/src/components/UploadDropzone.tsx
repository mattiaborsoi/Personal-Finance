import { CircleAlert, FileUp } from 'lucide-react';
import { useState, type ChangeEvent, type DragEvent } from 'react';
import { btnSecondary, btnSmall, chipSoft, cx } from '../lib/ui';

interface Props {
  file: File | null;
  onFile: (file: File | null) => void;
  disabled?: boolean;
}

/** Mirrors the backend's ALLOWED_SUFFIXES: pdf, csv, xlsx and legacy xls. */
const ACCEPT = [
  '.pdf',
  '.csv',
  '.xlsx',
  '.xls',
  'application/pdf',
  'text/csv',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.ms-excel',
].join(',');
const ALLOWED = /\.(pdf|csv|xlsx|xls)$/i;
export const SUPPORTED_FORMATS = 'PDF, CSV, XLSX or XLS';
const FORMAT_CHIPS = ['PDF', 'CSV', 'XLSX', 'XLS'];

function formatSize(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)}\u00a0MB`;
  return `${Math.max(1, Math.round(bytes / 1024))}\u00a0KB`;
}

/** Drag-and-drop area with a keyboard-accessible file input fallback. */
export function UploadDropzone({ file, onFile, disabled = false }: Props) {
  const [dragging, setDragging] = useState(false);
  const [warning, setWarning] = useState<string | null>(null);

  function accept(candidate: File | undefined) {
    if (!candidate) return;
    if (!ALLOWED.test(candidate.name)) {
      setWarning(`Only ${SUPPORTED_FORMATS} statements are supported.`);
      return;
    }
    setWarning(null);
    onFile(candidate);
  }

  function onDrop(event: DragEvent<HTMLDivElement>) {
    event.preventDefault();
    setDragging(false);
    if (disabled) return;
    accept(event.dataTransfer.files?.[0]);
  }

  function onInput(event: ChangeEvent<HTMLInputElement>) {
    accept(event.target.files?.[0]);
    event.target.value = '';
  }

  return (
    <div>
      <div
        onDragOver={(e) => {
          e.preventDefault();
          if (!disabled) setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={onDrop}
        className={cx(
          'flex flex-col items-center rounded-2xl border-2 border-dashed px-6 py-10 text-center transition-colors duration-150',
          dragging
            ? 'border-brand bg-brand-soft/40'
            : file
              ? 'border-hairline-strong bg-surface-2/60'
              : 'border-hairline-strong hover:border-brand hover:bg-brand-soft/40',
          disabled && 'opacity-60',
        )}
      >
        <span
          aria-hidden="true"
          className={cx(
            'flex h-14 w-14 items-center justify-center rounded-full transition-colors',
            dragging ? 'bg-brand text-on-brand' : 'bg-surface-2 text-ink-2',
          )}
        >
          <FileUp className="h-6 w-6" />
        </span>
        {file ? (
          <p className="mt-4 text-sm text-ink">
            <span className="font-semibold [overflow-wrap:anywhere]">{file.name}</span>{' '}
            <span className="whitespace-nowrap text-ink-3">({formatSize(file.size)})</span>
          </p>
        ) : (
          <p className="mt-4 text-sm font-medium text-ink">{`Drag a ${SUPPORTED_FORMATS} statement here`}</p>
        )}
        {!file && (
          <ul className="mt-2 flex flex-wrap justify-center gap-1.5" aria-label="Supported formats">
            {FORMAT_CHIPS.map((f) => (
              <li key={f} className={chipSoft}>
                {f}
              </li>
            ))}
          </ul>
        )}
        <div className="mt-5 flex flex-wrap justify-center gap-2">
          {/* The input comes first so its focus and disabled state can style the label (a label never takes focus itself). */}
          <input
            id="statement-file"
            type="file"
            accept={ACCEPT}
            className="peer sr-only"
            onChange={onInput}
            disabled={disabled}
          />
          <label
            htmlFor="statement-file"
            className={cx(
              btnSecondary,
              btnSmall,
              'cursor-pointer peer-focus-visible:ring-2 peer-focus-visible:ring-brand peer-focus-visible:ring-offset-2 peer-focus-visible:ring-offset-surface peer-disabled:cursor-not-allowed peer-disabled:opacity-50',
            )}
          >
            {file ? 'Choose a different file' : 'Choose a file'}
          </label>
          {file && (
            <button
              type="button"
              className={cx(btnSecondary, btnSmall)}
              onClick={() => onFile(null)}
              disabled={disabled}
            >
              Clear
            </button>
          )}
        </div>
      </div>
      {warning && (
        <p role="alert" className="mt-2 flex items-center gap-1.5 text-sm text-critical-ink">
          <CircleAlert className="h-4 w-4 shrink-0" aria-hidden="true" />
          {warning}
        </p>
      )}
    </div>
  );
}
