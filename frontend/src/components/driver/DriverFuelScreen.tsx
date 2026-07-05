'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  Camera,
  CheckCircle,
  CloudOff,
  Loader2,
  MapPin,
  PenLine,
  RefreshCw,
  Upload,
  Wifi,
} from 'lucide-react';
import {
  DriverReceipt,
  DriverSession,
  fetchDriverReceipts,
  submitDriverReceipt,
  syncPendingReceipt,
} from '@/lib/driver-api';
import {
  enqueueOfflineReceipt,
  getOfflineQueueCount,
  getOfflineReceiptQueue,
  isOnline,
  markOfflineReceiptError,
  onConnectivityChange,
  removeOfflineReceipt,
} from '@/lib/driver-offline-queue';
import { scanReceiptImage } from '@/lib/receipt-ocr';

type FuelMode = 'home' | 'scanning' | 'form' | 'success';

export function DriverFuelScreen({
  driver,
  onPendingChange,
}: {
  driver: DriverSession;
  onPendingChange: (count: number) => void;
}) {
  const [mode, setMode] = useState<FuelMode>('home');
  const [online, setOnline] = useState(true);
  const [pending, setPending] = useState(0);
  const [recent, setRecent] = useState<DriverReceipt[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState('');
  const [receiptPhoto, setReceiptPhoto] = useState<string | null>(null);
  const [parseConfidence, setParseConfidence] = useState<number | null>(null);
  const [merchantName, setMerchantName] = useState('');
  const [merchantAddress, setMerchantAddress] = useState('');
  const [declaredLiters, setDeclaredLiters] = useState('');
  const [pricePerLiter, setPricePerLiter] = useState('650');
  const [totalAmount, setTotalAmount] = useState('');
  const [transactionDate, setTransactionDate] = useState('');
  const [odometerKm, setOdometerKm] = useState('');
  const [location, setLocation] = useState<{ lat: number; lng: number } | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const cameraRef = useRef<HTMLInputElement>(null);
  const galleryRef = useRef<HTMLInputElement>(null);

  const openCamera = () => {
    const input = cameraRef.current;
    if (!input) return;
    input.value = '';
    input.click();
  };

  const openGallery = () => {
    const input = galleryRef.current;
    if (!input) return;
    input.value = '';
    input.click();
  };

  const refreshPending = useCallback(() => {
    const count = getOfflineQueueCount();
    setPending(count);
    onPendingChange(count);
  }, [onPendingChange]);

  const loadRecent = useCallback(async () => {
    try {
      setRecent(await fetchDriverReceipts());
    } catch {
      /* keep cached list */
    }
  }, []);

  const syncQueue = useCallback(async () => {
    if (!isOnline()) return;
    const queue = getOfflineReceiptQueue();
    for (const item of [...queue].reverse()) {
      try {
        await syncPendingReceipt(item as unknown as Record<string, unknown>);
        removeOfflineReceipt(item.client_receipt_id);
      } catch (err) {
        markOfflineReceiptError(
          item.client_receipt_id,
          err instanceof Error ? err.message : 'Sync failed'
        );
      }
    }
    refreshPending();
    await loadRecent();
  }, [loadRecent, refreshPending]);

  useEffect(() => {
    setOnline(isOnline());
    refreshPending();
    loadRecent();
    const unsub = onConnectivityChange(() => {
      setOnline(isOnline());
      if (isOnline()) syncQueue();
    });
    return unsub;
  }, [loadRecent, refreshPending, syncQueue]);

  useEffect(() => {
    if ('geolocation' in navigator) {
      navigator.geolocation.getCurrentPosition((pos) => {
        setLocation({ lat: pos.coords.latitude, lng: pos.coords.longitude });
      });
    }
  }, []);

  const applyParsedFields = (fields: {
    merchant_name: string;
    merchant_address: string | null;
    declared_liters: number | null;
    total_amount: number | null;
    price_per_liter: number | null;
    transaction_date: string;
  }, confidence: number) => {
    setMerchantName(fields.merchant_name);
    setMerchantAddress(fields.merchant_address ?? '');
    if (fields.declared_liters != null) setDeclaredLiters(String(fields.declared_liters));
    if (fields.price_per_liter != null) setPricePerLiter(String(fields.price_per_liter));
    if (fields.total_amount != null) setTotalAmount(String(fields.total_amount));
    setTransactionDate(toDatetimeLocal(fields.transaction_date));
    setParseConfidence(confidence);
    setMode('form');
  };

  const handlePhoto = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setError(null);
    setMode('scanning');

    const reader = new FileReader();
    reader.onloadend = async () => {
      const dataUrl = reader.result as string;
      setReceiptPhoto(dataUrl);
      try {
        const { parsed } = await scanReceiptImage(dataUrl);
        applyParsedFields(parsed.fields, parsed.parse_confidence);
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Scan failed — enter details manually');
        setMode('form');
      }
    };
    reader.readAsDataURL(file);
  };

  const startManual = () => {
    setReceiptPhoto(null);
    setParseConfidence(null);
    setMerchantName('');
    setMerchantAddress('');
    setDeclaredLiters('');
    setPricePerLiter('650');
    setTotalAmount('');
    setTransactionDate(toDatetimeLocal(new Date().toISOString()));
    setMode('form');
  };

  const handleSubmit = async () => {
    if (!driver.vehicle_id) {
      setError('No vehicle assigned');
      return;
    }
    const declared = Number(declaredLiters);
    const price = Number(pricePerLiter) || 650;
    const total = totalAmount ? Number(totalAmount) : Math.round(declared * price);
    if (!merchantName || !declared) {
      setError('Merchant and liters are required');
      return;
    }

    setSubmitting(true);
    setError(null);

    const payload = {
      vehicle_id: driver.vehicle_id,
      client_receipt_id: crypto.randomUUID(),
      receipt_photo: receiptPhoto,
      merchant_name: merchantName,
      merchant_address: merchantAddress || undefined,
      declared_liters: declared,
      price_per_liter: price,
      total_amount: total,
      odometer_km: odometerKm ? Number(odometerKm) : undefined,
      receipt_latitude: location?.lat,
      receipt_longitude: location?.lng,
      transaction_date: transactionDate
        ? new Date(transactionDate).toISOString()
        : new Date().toISOString(),
    };

    if (!isOnline()) {
      enqueueOfflineReceipt(payload);
      refreshPending();
      setMessage('Saved offline — will sync when connected');
      setMode('success');
      setSubmitting(false);
      setTimeout(resetForm, 2000);
      return;
    }

    try {
      const result = await submitDriverReceipt(payload);
      setMessage(result.message);
      setMode('success');
      await loadRecent();
      setTimeout(resetForm, 2200);
    } catch (err) {
      enqueueOfflineReceipt(payload);
      refreshPending();
      setMessage('Network issue — saved offline for sync');
      setMode('success');
      setTimeout(resetForm, 2200);
    } finally {
      setSubmitting(false);
    }
  };

  const resetForm = () => {
    setMode('home');
    setReceiptPhoto(null);
    setParseConfidence(null);
    setError(null);
    setMessage('');
  };

  return (
    <div className="space-y-4 pb-4">
      <div className="flex items-center justify-between rounded-xl border border-edge bg-panel px-4 py-3">
        <div className="flex items-center gap-2 text-xs">
          {online ? (
            <>
              <Wifi className="h-4 w-4 text-good" />
              <span className="text-good">Online</span>
            </>
          ) : (
            <>
              <CloudOff className="h-4 w-4 text-warn" />
              <span className="text-warn">Offline — receipts queue locally</span>
            </>
          )}
        </div>
        {pending > 0 && (
          <button
            type="button"
            onClick={syncQueue}
            className="flex items-center gap-1 text-xs text-brand"
          >
            <RefreshCw className="h-3 w-3" /> Sync {pending}
          </button>
        )}
      </div>

      {mode === 'home' && (
        <div className="space-y-3">
          <button
            type="button"
            onClick={openCamera}
            className="flex w-full items-center gap-4 rounded-2xl border-2 border-dashed border-edge bg-panel p-5 text-left active:border-brand"
          >
            <div className="rounded-xl bg-accent/20 p-3">
              <Camera className="h-7 w-7 text-brand" />
            </div>
            <div>
              <p className="font-semibold text-ink">Snap receipt</p>
              <p className="text-xs text-ink-dim">Camera scan — auto-reads liters, merchant, time</p>
            </div>
          </button>

          <button
            type="button"
            onClick={openGallery}
            className="flex w-full items-center gap-4 rounded-2xl border border-edge bg-panel p-4 text-left"
          >
            <Upload className="h-5 w-5 text-ink-dim" />
            <span className="text-sm text-ink-mid">Upload from gallery</span>
          </button>

          <button
            type="button"
            onClick={startManual}
            className="flex w-full items-center gap-4 rounded-2xl border border-edge bg-panel p-4 text-left"
          >
            <PenLine className="h-5 w-5 text-ink-dim" />
            <span className="text-sm text-ink-mid">Enter manually</span>
          </button>

          <div className="flex items-center gap-2 text-xs text-ink-dim">
            <MapPin className="h-3 w-3" />
            {location ? 'GPS will attach to this receipt' : 'Waiting for GPS…'}
          </div>
        </div>
      )}

      <input
        ref={cameraRef}
        type="file"
        accept="image/*"
        capture="environment"
        className="hidden"
        onChange={handlePhoto}
      />
      <input
        ref={galleryRef}
        type="file"
        accept="image/*"
        className="hidden"
        onChange={handlePhoto}
      />

      {mode === 'scanning' && (
        <div className="flex flex-col items-center rounded-2xl border border-edge bg-panel py-12">
          <Loader2 className="h-10 w-10 animate-spin text-brand" />
          <p className="mt-4 text-sm text-ink">Reading receipt…</p>
          <p className="mt-1 text-xs text-ink-dim">Extracting merchant, liters, amount, time</p>
        </div>
      )}

      {mode === 'form' && (
        <div className="space-y-3 rounded-2xl border border-edge bg-panel p-4">
          {receiptPhoto && (
            <img
              src={receiptPhoto}
              alt="Receipt"
              className="max-h-36 w-full rounded-lg object-cover"
            />
          )}
          {parseConfidence != null && (
            <p className="text-xs text-good">
              Receipt scan · confidence {parseConfidence}% — review fields below
            </p>
          )}
          {error && <p className="text-sm text-bad">{error}</p>}

          <Field label="Merchant" value={merchantName} onChange={setMerchantName} />
          <Field label="Address" value={merchantAddress} onChange={setMerchantAddress} />
          <Field label="Purchase time" value={transactionDate} onChange={setTransactionDate} type="datetime-local" />
          <div className="grid grid-cols-2 gap-3">
            <Field label="Liters" value={declaredLiters} onChange={setDeclaredLiters} type="number" />
            <Field label="Price/L (₦)" value={pricePerLiter} onChange={setPricePerLiter} type="number" />
          </div>
          <Field label="Total (₦)" value={totalAmount} onChange={setTotalAmount} type="number" />
          <Field label="Odometer (km)" value={odometerKm} onChange={setOdometerKm} type="number" />

          <div className="flex gap-2 pt-2">
            <button
              type="button"
              onClick={resetForm}
              className="flex-1 rounded-xl border border-edge py-3 text-sm text-ink-mid"
            >
              Cancel
            </button>
            <button
              type="button"
              disabled={submitting}
              onClick={handleSubmit}
              className="flex-1 rounded-xl bg-accent py-3 text-sm font-medium text-white disabled:opacity-50"
            >
              {submitting ? 'Submitting…' : online ? 'Submit receipt' : 'Save offline'}
            </button>
          </div>
        </div>
      )}

      {mode === 'success' && (
        <div className="rounded-2xl border border-good/30 bg-good/10 py-10 text-center">
          <CheckCircle className="mx-auto h-12 w-12 text-good" />
          <p className="mt-3 font-medium text-ink">Receipt recorded</p>
          <p className="mt-1 px-6 text-xs text-ink-dim">{message}</p>
        </div>
      )}

      {recent.length > 0 && mode === 'home' && (
        <div>
          <h3 className="mb-2 text-xs font-semibold uppercase tracking-wider text-ink-dim">
            Recent submissions
          </h3>
          <div className="space-y-2">
            {recent.slice(0, 5).map((r) => (
              <div
                key={r.id}
                className="rounded-xl border border-edge bg-panel/80 px-3 py-2.5"
              >
                <p className="text-sm font-medium text-ink">{r.merchant_name}</p>
                <p className="text-xs text-ink-dim">
                  {new Date(r.transaction_date).toLocaleString('en-NG', {
                    timeZone: 'Africa/Lagos',
                    hour: 'numeric',
                    minute: '2-digit',
                    day: '2-digit',
                    month: 'short',
                  })}{' '}
                  · {Number(r.declared_liters)}L
                  {r.obd_liters_actual != null && ` · OBD ${Number(r.obd_liters_actual)}L`}
                </p>
                <span
                  className={`text-[10px] uppercase ${
                    r.reconciliation_status === 'flagged_theft'
                      ? 'text-bad'
                      : r.reconciliation_status === 'matched'
                        ? 'text-good'
                        : 'text-warn'
                  }`}
                >
                  {r.reconciliation_status.replace('_', ' ')}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function Field({
  label,
  value,
  onChange,
  type = 'text',
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  type?: string;
}) {
  return (
    <label className="block text-xs text-ink-dim">
      {label}
      <input
        type={type}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="mt-1 w-full rounded-lg border border-edge bg-canvas px-3 py-2.5 text-sm text-ink"
      />
    </label>
  );
}

function toDatetimeLocal(iso: string) {
  const date = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}
