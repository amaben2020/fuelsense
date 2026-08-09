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
import { Panel, StatusChip } from '@/components/ui/chrome';
import { ArrowLeft, Cpu } from 'lucide-react';

// The shared `Field`/`fs-input` pair lives in marketing.css, which the dashboard
// layout never loads — reusing it here rendered borderless, invisible controls.
// These are the dashboard's own tokens instead.
const FIELD_LABEL = 'mb-1.5 block text-[11px] font-semibold uppercase tracking-wider text-ink-dim';
const FIELD_INPUT =
  'w-full rounded-xl border border-edge bg-panel-deep px-3.5 py-2.5 text-sm text-ink ' +
  'placeholder:text-ink-dim focus:border-brand focus:outline-none focus:ring-1 focus:ring-brand';

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
    <div className="min-h-screen bg-canvas text-ink">
      <div className="mx-auto max-w-2xl px-6 py-10">
        <Link
          href="/dashboard"
          className="inline-flex items-center gap-1.5 text-sm text-ink-dim transition-colors hover:text-ink"
        >
          <ArrowLeft className="h-3.5 w-3.5" />
          Back to dashboard
        </Link>

        <h1 className="mt-5 text-3xl font-bold tracking-tight text-ink">Buy trackers</h1>
        <p className="mt-2 text-sm text-ink-mid">
          Order FMC150 fuel trackers. Each device ships with an IMEI sticker for self-service setup.
        </p>

        <Panel icon={Cpu} title="New order" className="mt-7">
          <form onSubmit={handleSubmit} className="space-y-4">
            {error && (
              <p className="rounded-lg border border-bad/40 bg-bad/10 px-3 py-2 text-sm text-bad">
                {error}
              </p>
            )}
            {success && (
              <p className="rounded-lg border border-brand/40 bg-brand/10 px-3 py-2 text-sm text-brand">
                {success}
              </p>
            )}

            <label className="block">
              <span className={FIELD_LABEL}>Quantity</span>
              <input
                type="number"
                min={1}
                max={50}
                required
                value={quantity}
                onChange={(e) => setQuantity(Number(e.target.value))}
                className={`${FIELD_INPUT} tabular-nums`}
              />
            </label>

            <label className="block">
              <span className={FIELD_LABEL}>Shipping address</span>
              <textarea
                required
                rows={3}
                value={shippingAddress}
                onChange={(e) => setShippingAddress(e.target.value)}
                className={`${FIELD_INPUT} resize-y`}
                placeholder="Street, city, state"
              />
            </label>

            <div className="rounded-xl border border-edge bg-panel-deep p-4">
              <p className="text-xs uppercase tracking-wider text-ink-dim">
                {quantity} × {formatNgn(PRICE_PER_TRACKER_NGN)} per tracker
              </p>
              <p className="mt-1.5 text-2xl font-bold tabular-nums text-ink">{formatNgn(total)}</p>
            </div>

            <button
              type="submit"
              disabled={loading}
              className="w-full rounded-full bg-brand px-4 py-2.5 text-sm font-semibold text-canvas transition-opacity hover:opacity-90 disabled:opacity-60"
            >
              {loading ? 'Creating order…' : `Checkout ${formatNgn(total)}`}
            </button>
          </form>
        </Panel>

        {orders.length > 0 && (
          <Panel title="Your orders" className="mt-6" bodyClassName="space-y-3">
            {orders.map((order) => (
              <div
                key={order.id}
                className="rounded-xl border border-edge bg-panel-deep p-4"
              >
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <p className="text-sm font-semibold text-ink">
                    {order.quantity} tracker{order.quantity > 1 ? 's' : ''}
                  </p>
                  <StatusChip
                    tone={order.status === 'delivered' ? 'good' : 'neutral'}
                    className="capitalize"
                  >
                    {order.status}
                  </StatusChip>
                </div>
                <p className="mt-1 text-xs text-ink-dim">
                  {formatNgn(order.total_amount_ngn)} ·{' '}
                  {new Date(order.created_at).toLocaleDateString()}
                </p>
                {order.device_imeis?.length > 0 && (
                  <p className="mt-2 font-mono text-xs text-ink-mid">
                    IMEIs: {order.device_imeis.join(', ')}
                  </p>
                )}
              </div>
            ))}
          </Panel>
        )}

        <button
          type="button"
          onClick={() => {
            clearToken();
            router.push('/login');
          }}
          className="mt-7 text-sm text-ink-dim transition-colors hover:text-ink"
        >
          Sign out
        </button>
      </div>
    </div>
  );
}
