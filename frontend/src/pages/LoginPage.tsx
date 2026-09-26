import { ArrowLeftRight, Eye, EyeOff, Scale, Sparkles, Upload } from 'lucide-react';
import { useState, type FormEvent } from 'react';
import { Navigate, useLocation, useNavigate } from 'react-router-dom';
import { errorMessage, isApiError } from '../api';
import { useAuth } from '../auth/AuthContext';
import { BrandMark, PRODUCT_NAME, PRODUCT_SLOGAN } from '../components/BrandMark';
import { ErrorMessage } from '../components/ErrorMessage';
import { ThemeToggle } from '../components/ThemeToggle';
import { btnIcon, btnPrimary, cx, inputBase, labelBase } from '../lib/ui';

const FEATURES = [
  {
    icon: Upload,
    title: 'Drop in a statement',
    text: 'PDF, CSV or spreadsheet. AI reads every line, categorises it and learns your merchants as you go.',
    accent: 'bg-accent-macro/12 text-accent-macro',
  },
  {
    icon: Scale,
    title: 'Split it fairly',
    text: 'Shared costs divide by income or 50/50. One receipt can be part shared, part personal.',
    accent: 'bg-accent-micro/12 text-accent-micro',
  },
  {
    icon: ArrowLeftRight,
    title: 'Settle once a month',
    text: 'One number, every line behind it, and a record of what was settled.',
    accent: 'bg-accent-liquidity/12 text-accent-liquidity',
  },
];

export function LoginPage() {
  const { session, login } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const [password, setPassword] = useState('');
  const [show, setShow] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  if (session) {
    return <Navigate to={session.role === 'secondary' ? '/claim' : '/'} replace />;
  }

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    if (!password) {
      setError('Enter your password.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const next = await login(password);
      const from = (location.state as { from?: string } | null)?.from;
      if (next.role === 'secondary') navigate('/claim', { replace: true });
      else navigate(from && from !== '/login' ? from : '/', { replace: true });
    } catch (err) {
      setError(isApiError(err, 401) ? 'That password was not recognised.' : errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="min-h-screen lg:grid lg:grid-cols-[1.1fr_1fr]">
      {/* Brand panel */}
      <section
        aria-label={`About ${PRODUCT_NAME}`}
        className="relative hidden overflow-hidden bg-surface lg:flex lg:flex-col lg:justify-between lg:border-r lg:border-hairline lg:p-12"
      >
        <div
          aria-hidden="true"
          className="pointer-events-none absolute -right-32 -top-32 h-[520px] w-[520px] rounded-full bg-brand-soft blur-3xl"
        />
        <div
          aria-hidden="true"
          className="pointer-events-none absolute -bottom-40 -left-24 h-[420px] w-[420px] rounded-full bg-accent-liquidity/10 blur-3xl"
        />
        <div className="relative flex items-center gap-3">
          <BrandMark size={36} />
          <span className="text-lg font-semibold tracking-tight text-ink">{PRODUCT_NAME}</span>
        </div>
        <div className="relative max-w-md">
          <p className="inline-flex items-center gap-1.5 rounded-full border border-hairline bg-surface px-3 py-1 text-xs font-medium text-ink-2">
            <Sparkles className="h-3.5 w-3.5 text-accent-micro" aria-hidden="true" />
            Self-hosted, private, built for two
          </p>
          <h1 className="mt-5 text-4xl font-semibold leading-[1.1] tracking-tight text-ink" aria-label={PRODUCT_SLOGAN}>
            Shared money,
            <br />
            <span className="text-brand">settled by AI.</span>
          </h1>
          <p className="mt-4 text-base text-ink-2">
            {PRODUCT_NAME} reads your bank statements, splits what's shared and tells you who owes whom.
          </p>
          <ul className="mt-10 space-y-6">
            {FEATURES.map((f) => {
              const Icon = f.icon;
              return (
                <li key={f.title} className="flex gap-4">
                  <span className={cx('flex h-10 w-10 shrink-0 items-center justify-center rounded-xl', f.accent)}>
                    <Icon className="h-5 w-5" aria-hidden="true" />
                  </span>
                  <div>
                    <p className="text-sm font-semibold text-ink">{f.title}</p>
                    <p className="mt-0.5 text-sm text-ink-2">{f.text}</p>
                  </div>
                </li>
              );
            })}
          </ul>
        </div>
        <p className="relative text-xs text-ink-3">Runs on your own machine. Nothing leaves it but the LLM calls you allow.</p>
      </section>

      {/* Form panel */}
      <section className="flex min-h-screen flex-col px-5 py-6 sm:px-10 lg:min-h-0">
        <div className="flex items-center justify-between lg:justify-end">
          <span className="flex items-center gap-2.5 lg:hidden">
            <BrandMark size={28} />
            <span className="text-[15px] font-semibold tracking-tight text-ink">{PRODUCT_NAME}</span>
          </span>
          <ThemeToggle />
        </div>
        <div className="flex flex-1 items-center justify-center py-10">
          <form
            onSubmit={handleSubmit}
            className="w-full max-w-sm rounded-2xl border border-hairline bg-surface p-7 shadow-card animate-rise"
            aria-labelledby="login-title"
          >
            <h1 id="login-title" className="text-2xl font-semibold tracking-tight text-ink">
              Welcome back
            </h1>
            <p className="mt-1.5 text-sm text-ink-2">Enter the household password to continue.</p>

            <label htmlFor="password" className={cx(labelBase, 'mt-6')}>
              Password
            </label>
            <div className="relative mt-1.5">
              <input
                id="password"
                name="password"
                type={show ? 'text' : 'password'}
                autoComplete="current-password"
                autoFocus
                className={cx(inputBase, 'py-2.5 pr-11')}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                disabled={busy}
              />
              <button
                type="button"
                className={cx(btnIcon, 'absolute right-1.5 top-1/2 -translate-y-1/2')}
                onClick={() => setShow((s) => !s)}
                aria-label={show ? 'Hide password' : 'Show password'}
                aria-pressed={show}
              >
                {show ? <EyeOff className="h-4 w-4" aria-hidden="true" /> : <Eye className="h-4 w-4" aria-hidden="true" />}
              </button>
            </div>

            <ErrorMessage message={error} className="mt-3" />

            <button type="submit" className={cx(btnPrimary, 'mt-6 w-full py-2.5')} disabled={busy}>
              {busy ? 'Signing in…' : 'Sign in'}
            </button>
            <p className="mt-4 text-center text-xs text-ink-3">
              One password each: yours opens everything, your partner's opens the claim form.
            </p>
          </form>
        </div>
      </section>
    </div>
  );
}
