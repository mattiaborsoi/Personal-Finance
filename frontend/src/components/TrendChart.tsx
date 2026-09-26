import { useEffect, useState } from 'react';
import { Area, AreaChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import type { TrendPoint } from '../api';
import { useCurrency } from '../config/ConfigContext';
import { periodShortLabel } from '../lib/dates';
import { formatMoney, toNumber } from '../lib/money';
import { viewDefinition, type MetricView } from '../lib/views';
import { EmptyState } from './EmptyState';

interface Props {
  data: TrendPoint[];
  view: MetricView;
}

function compactMoney(value: number, symbol: string): string {
  const abs = Math.abs(value);
  const sign = value < 0 ? '-' : '';
  if (abs >= 1000) return `${sign}${symbol}${(abs / 1000).toFixed(abs >= 10000 ? 0 : 1)}k`;
  return `${sign}${symbol}${Math.round(abs)}`;
}

/**
 * Resolve design tokens to concrete colours for SVG, and follow theme changes
 * (SVG presentation attributes cannot read CSS variables).
 */
function useTokens(names: string[]): Record<string, string> {
  const read = () => {
    const styles = getComputedStyle(document.documentElement);
    return Object.fromEntries(
      names.map((n) => {
        const raw = styles.getPropertyValue(`--color-${n}`).trim();
        return [n, raw ? `rgb(${raw.split(/\s+/).join(' ')})` : 'currentColor'];
      }),
    );
  };
  const [tokens, setTokens] = useState<Record<string, string>>(read);
  useEffect(() => {
    const update = () => setTokens(read());
    const observer = new MutationObserver(update);
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
    const media = window.matchMedia?.('(prefers-color-scheme: dark)');
    media?.addEventListener?.('change', update);
    return () => {
      observer.disconnect();
      media?.removeEventListener?.('change', update);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [names.join('|')]);
  return tokens;
}

interface TooltipPayload {
  active?: boolean;
  payload?: ReadonlyArray<{ payload?: { label: string; value: number } }>;
}

/** Six-period trend for the active metric view: a single series, so no legend; a crosshair tooltip carries the values. */
export function TrendChart({ data, view }: Props) {
  const symbol = useCurrency();
  const definition = viewDefinition(view);
  const tokens = useTokens([definition.accentToken, 'hairline', 'ink-3', 'surface']);
  const accent = tokens[definition.accentToken];
  const points = data.map((p) => ({
    period: p.period_key,
    label: periodShortLabel(p.period_key),
    value: toNumber(p[definition.trendKey]),
  }));

  if (points.length === 0) return <EmptyState title="No trend data yet" />;
  const last = points[points.length - 1];

  function renderTooltip({ active, payload }: TooltipPayload) {
    if (!active || !payload?.length) return null;
    const item = payload[0].payload;
    if (!item) return null;
    return (
      <div className="rounded-lg border border-hairline bg-surface px-3 py-2 text-xs shadow-pop">
        <p className="text-base font-semibold text-ink">{formatMoney(item.value, symbol)}</p>
        <p className="mt-0.5 flex items-center gap-1.5 text-ink-3">
          <span aria-hidden="true" className="inline-block h-0.5 w-3 rounded" style={{ background: accent }} />
          {definition.short} · {item.label}
        </p>
      </div>
    );
  }

  return (
    <figure aria-label={`${definition.label} trend over the last ${points.length} periods`}>
      <div className="h-48 w-full">
        <ResponsiveContainer width="100%" height="100%">
          <AreaChart data={points} margin={{ top: 12, right: 14, bottom: 4, left: 0 }}>
            <defs>
              <linearGradient id={`trend-fill-${view}`} x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor={accent} stopOpacity={0.16} />
                <stop offset="100%" stopColor={accent} stopOpacity={0.02} />
              </linearGradient>
            </defs>
            <CartesianGrid stroke={tokens.hairline} strokeWidth={1} vertical={false} />
            <XAxis
              dataKey="label"
              tick={{ fontSize: 11, fill: tokens['ink-3'] }}
              axisLine={{ stroke: tokens.hairline }}
              tickLine={false}
              tickMargin={8}
            />
            <YAxis
              width={52}
              tick={{ fontSize: 11, fill: tokens['ink-3'] }}
              axisLine={false}
              tickLine={false}
              tickFormatter={(v: number) => compactMoney(v, symbol)}
            />
            <Tooltip
              content={renderTooltip}
              cursor={{ stroke: tokens['ink-3'], strokeWidth: 1, strokeDasharray: '0' }}
              isAnimationActive={false}
            />
            <Area
              type="monotone"
              dataKey="value"
              stroke={accent}
              strokeWidth={2}
              strokeLinejoin="round"
              strokeLinecap="round"
              fill={`url(#trend-fill-${view})`}
              dot={false}
              activeDot={{ r: 5, fill: accent, stroke: tokens.surface, strokeWidth: 2 }}
              isAnimationActive={false}
            />
          </AreaChart>
        </ResponsiveContainer>
      </div>
      <p className="mt-1 flex items-center justify-end gap-2 text-xs text-ink-3">
        <span aria-hidden="true" className="inline-block h-2 w-2 rounded-full" style={{ background: accent }} />
        {last.label}: <span className="font-medium text-ink-2">{formatMoney(last.value, symbol)}</span>
      </p>
      <figcaption className="sr-only">
        {points.map((p) => `${p.label}: ${formatMoney(p.value, symbol)}`).join(', ')}
      </figcaption>
    </figure>
  );
}
