import type { ClassificationSource } from '../api';
import { formatConfidence } from '../lib/format';
import { Badge, type BadgeTone } from './Badge';

interface Props {
  source: ClassificationSource | string | null | undefined;
  confidence: number | string | null | undefined;
}

const TONES: Record<string, BadgeTone> = {
  rule: 'green',
  memory: 'blue',
  llm: 'violet',
  manual: 'neutral',
  transfer: 'neutral',
  none: 'amber',
};

const LABELS: Record<string, string> = {
  rule: 'Rule',
  memory: 'Memory',
  llm: 'LLM',
  manual: 'Manual',
  transfer: 'Transfer',
  none: 'Unclassified',
};

/** Who classified the row; the dot carries the colour, the label carries the meaning. */
export function SourceBadge({ source, confidence }: Props) {
  const key = source ?? 'none';
  const pct = formatConfidence(confidence);
  return (
    <Badge tone={TONES[key] ?? 'neutral'} dot title={`Classified by ${LABELS[key] ?? key}`}>
      {LABELS[key] ?? key}
      {pct && key !== 'none' && <span className="text-[10px] font-normal text-ink-3">{pct}</span>}
    </Badge>
  );
}
