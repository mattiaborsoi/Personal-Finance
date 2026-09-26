import type { Money } from '../api';
import { useCurrency } from '../config/ConfigContext';
import { formatMoney, formatSignedMoney, moneyTone } from '../lib/money';

interface Props {
  value: Money | number | null | undefined;
  /** Colour by sign (red out, green in). */
  tone?: boolean;
  /** Show a leading + for positive values. */
  signed?: boolean;
  className?: string;
}

export function MoneyText({ value, tone = false, signed = false, className = '' }: Props) {
  const symbol = useCurrency();
  const text = signed ? formatSignedMoney(value, symbol) : formatMoney(value, symbol);
  return <span className={`tabular ${tone ? moneyTone(value) : ''} ${className}`}>{text}</span>;
}
