'use client';

import Link from 'next/link';
import { FormEvent, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  api,
  clearToken,
  DeviceOrder,
  formatNgn,
  getToken,
  OrderCheckoutResponse,
  PRICE_PER_TRACKER_NGN,
} from '@/lib/api';
import { Field, inputClass } from '@/components/AuthLayout';

export default function NewOrderPage() {
  const router = useRouter();
  const [quantity, setQuantity] = useState(1);
  const [shippingAddress, setShippingAddress] = useState('');
  const [orders, setOrders] = useState<DeviceOrder[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  useEffect(() => {
    if (!getToken()) {
      router.replace('/login');
      return;
    }

    api<DeviceOrder[]>('/orders')
      .then(setOrders)
      .catch(() => {});
  }, [router]);

  const total = quantity * PRICE_PER_TRACKER_NGN;

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setError(null);
    setSuccess(null);

    try {
      const result = await api<OrderCheckoutResponse>('/orders', {
        method: 'POST',
        body: JSON.stringify({ quantity, shippingAddress }),
      });

      setOrders((prev) => [result.order, ...prev]);
      setSuccess(
        `Order #${result.order.id.slice(0, 8)} created for ${formatNgn(result.checkout.amountNgn)}. ${result.checkout.message}`
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create order');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen bg-slate-100">
      <div className="mx-auto max-w-2xl px-6 py-8">
        <Link href="/dashboard" className="text-sm text-emerald-700 hover:underline">
          ← Back to dashboard
        </Link>

        <h1 className="mt-4 text-3xl font-bold text-slate-900">Buy Trackers</h1>
        <p className="mt-2 text-slate-600">
          Order FMC150 fuel trackers. Each device ships with an IMEI sticker for self-service setup.
        </p>

        <form onSubmit={handleSubmit} className="mt-8 space-y-4 rounded-lg bg-white p-6 shadow-sm">
          {error && <p className="text-sm text-red-600">{error}</p>}
          {success && <p className="text-sm text-emerald-700">{success}</p>}

          <Field label="Quantity">
            <input
              type="number"
              min={1}
              max={50}
              required
              value={quantity}
              onChange={(e) => setQuantity(Number(e.target.value))}
              className={inputClass}
            />
          </Field>

          <Field label="Shipping address">
            <textarea
              required
              rows={3}
              value={shippingAddress}
              onChange={(e) => setShippingAddress(e.target.value)}
              className={inputClass}
              placeholder="Street, city, state"
            />
          </Field>

          <div className="rounded-lg bg-slate-50 p-4">
            <p className="text-sm text-slate-600">
              {quantity} × {formatNgn(PRICE_PER_TRACKER_NGN)} per tracker
            </p>
            <p className="mt-1 text-2xl font-bold text-slate-900">{formatNgn(total)}</p>
          </div>

          <button
            type="submit"
            disabled={loading}
            className="w-full rounded-lg bg-emerald-600 px-4 py-2.5 font-medium text-white hover:bg-emerald-700 disabled:opacity-60"
          >
            {loading ? 'Creating order...' : `Checkout ${formatNgn(total)}`}
          </button>
        </form>

        {orders.length > 0 && (
          <section className="mt-8">
            <h2 className="mb-4 text-lg font-semibold text-slate-900">Your orders</h2>
            <div className="space-y-3">
              {orders.map((order) => (
                <div key={order.id} className="rounded-lg bg-white p-4 shadow-sm">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <p className="font-medium text-slate-900">
                      {order.quantity} tracker{order.quantity > 1 ? 's' : ''}
                    </p>
                    <span className="rounded-full bg-slate-100 px-2 py-0.5 text-xs capitalize text-slate-600">
                      {order.status}
                    </span>
                  </div>
                  <p className="mt-1 text-sm text-slate-600">
                    {formatNgn(order.total_amount_ngn)} ·{' '}
                    {new Date(order.created_at).toLocaleDateString()}
                  </p>
                  {order.device_imeis?.length > 0 && (
                    <p className="mt-2 font-mono text-xs text-slate-500">
                      IMEIs: {order.device_imeis.join(', ')}
                    </p>
                  )}
                </div>
              ))}
            </div>
          </section>
        )}

        <button
          type="button"
          onClick={() => {
            clearToken();
            router.push('/login');
          }}
          className="mt-6 text-sm text-slate-500 hover:text-slate-700"
        >
          Sign out
        </button>
      </div>
    </div>
  );
}
