'use client';

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { api, Customer, getToken, isAuthenticated } from '@/lib/api';

export default function HomePage() {
  const router = useRouter();

  useEffect(() => {
    if (!isAuthenticated()) {
      router.replace('/login');
      return;
    }

    api<Customer>('/auth/me')
      .then((me) => {
        router.replace(me.onboarding_completed ? '/dashboard' : '/onboarding');
      })
      .catch(() => router.replace('/login'));
  }, [router]);

  return (
    <div className="flex min-h-screen items-center justify-center bg-slate-100 text-slate-600">
      Loading...
    </div>
  );
}
