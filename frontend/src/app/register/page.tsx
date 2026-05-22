'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { FormEvent, useState } from 'react';
import { api, AuthResponse, setToken } from '@/lib/api';
import { AuthLayout, Field, inputClass } from '@/components/AuthLayout';

export default function RegisterPage() {
  const router = useRouter();
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setError(null);

    try {
      const data = await api<AuthResponse>('/auth/register', {
        method: 'POST',
        auth: false,
        body: JSON.stringify({ name, email, password }),
      });
      setToken(data.token);
      router.push('/onboarding');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Registration failed');
    } finally {
      setLoading(false);
    }
  };

  return (
    <AuthLayout
      title="Create account"
      subtitle="Register your fleet and start monitoring fuel"
    >
      <form onSubmit={handleSubmit} className="space-y-4">
        {error && (
          <div className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
            {error}
          </div>
        )}

        <Field label="Company / Name">
          <input
            type="text"
            required
            value={name}
            onChange={(e) => setName(e.target.value)}
            className={inputClass}
            placeholder="Acme Logistics"
          />
        </Field>

        <Field label="Email">
          <input
            type="email"
            required
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            className={inputClass}
            placeholder="you@company.com"
          />
        </Field>

        <Field label="Password">
          <input
            type="password"
            required
            minLength={8}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            className={inputClass}
            placeholder="At least 8 characters"
          />
        </Field>

        <button
          type="submit"
          disabled={loading}
          className="w-full rounded-lg bg-emerald-600 px-4 py-2.5 font-medium text-white hover:bg-emerald-700 disabled:opacity-60"
        >
          {loading ? 'Creating account...' : 'Create account'}
        </button>
      </form>

      <p className="mt-6 text-center text-sm text-slate-600">
        Already have an account?{' '}
        <Link href="/login" className="font-medium text-emerald-700 hover:underline">
          Sign in
        </Link>
      </p>
    </AuthLayout>
  );
}
