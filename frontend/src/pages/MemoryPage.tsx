import { Brain } from 'lucide-react';
import { useState } from 'react';
import { api, errorMessage, type MemoryOut } from '../api';
import { Card } from '../components/Card';
import { ErrorMessage } from '../components/ErrorMessage';
import { LoadingState } from '../components/LoadingState';
import { MemoryTable } from '../components/MemoryTable';
import { PageHeader } from '../components/PageHeader';
import { useAsync } from '../hooks/useAsync';
import { plural } from '../lib/format';

export function MemoryPage() {
  const memory = useAsync(() => api.listMemory(200), 'memory');
  const [errors, setErrors] = useState<Record<string, string>>({});

  async function remove(entry: MemoryOut) {
    setErrors((prev) => {
      const next = { ...prev };
      delete next[String(entry.id)];
      return next;
    });
    try {
      await api.deleteMemory(entry.id);
      memory.setData((prev) => (prev ? prev.filter((m) => String(m.id) !== String(entry.id)) : prev));
    } catch (err) {
      setErrors((prev) => ({ ...prev, [String(entry.id)]: errorMessage(err) }));
    }
  }

  return (
    <div className="space-y-6">
      <PageHeader
        title="Merchant memory"
        description="Classifications learnt from your approvals. Settl remembers each merchant's name and category; whether a line is shared is decided per card, from how you have filed that merchant on the same card. Delete an entry to make the classifier ask again."
      />
      <Card
        flush
        icon={Brain}
        title="Learnt merchants"
        description={memory.data ? plural(memory.data.length, 'entry', 'entries') : undefined}
        actions={memory.loading && <LoadingState inline />}
      >
        {memory.error && (
          <div className="p-5 sm:p-6">
            <ErrorMessage message={memory.error.message} onRetry={memory.reload} />
          </div>
        )}
        {!memory.data && !memory.error && (
          <div className="px-5 py-5 sm:px-6">
            <LoadingState rows={5} />
          </div>
        )}
        {memory.data && <MemoryTable entries={memory.data} errors={errors} onDelete={remove} />}
      </Card>
    </div>
  );
}
