'use client';

import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { CheckCircle, MapPin, Receipt, Truck } from 'lucide-react';
import {
  DriverReceipt,
  DriverSession,
  clearDriverToken,
  fetchDriverMe,
  fetchDriverReceipts,
  getDriverToken,
  setDriverToken,
  submitDriverReceipt,
  driverLogin,
} from '@/lib/driver-api';

type Step = 'login' | 'capture' | 'preview' | 'submitting' | 'success';

export default function DriverPortalPage() {
  const [step, setStep] = useState<Step>('login');
  const [driverCode, setDriverCode] = useState('CHIDI-ABC');
  const [pin, setPin] = useState('1234');
  const [driver, setDriver] = useState<DriverSession | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [receiptPhoto, setReceiptPhoto] = useState<string | null>(null);
  const [merchantName, setMerchantName] = useState('TotalEnergies Ikeja');
  const [declaredLiters, setDeclaredLiters] = useState('60');
  const [pricePerLiter, setPricePerLiter] = useState('650');
  const [odometerKm, setOdometerKm] = useState('');
  const [resultMessage, setResultMessage] = useState('');
  const [recent, setRecent] = useState<DriverReceipt[]>([]);
  const [location, setLocation] = useState<{ lat: number; lng: number } | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!getDriverToken()) return;
    fetchDriverMe()
      .then((d) => {
        setDriver(d);
        setStep('capture');
        return fetchDriverReceipts();
      })
      .then(setRecent)
      .catch(() => {
        clearDriverToken();
        setStep('login');
      });
  }, []);

  useEffect(() => {
    if ('geolocation' in navigator) {
      navigator.geolocation.getCurrentPosition((pos) => {
        setLocation({ lat: pos.coords.latitude, lng: pos.coords.longitude });
      });
    }
  }, []);

  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    try {
      const { token, driver: session } = await driverLogin(driverCode.trim().toUpperCase(), pin);
      setDriverToken(token);
      setDriver(session);
      setStep('capture');
      const rows = await fetchDriverReceipts();
      setRecent(rows);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Login failed');
    }
  };

  const handlePhoto = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onloadend = () => {
      setReceiptPhoto(reader.result as string);
      setStep('preview');
    };
    reader.readAsDataURL(file);
  };

  const handleSubmit = async () => {
    if (!driver?.vehicle_id) {
      setError('No vehicle assigned to this driver');
      return;
    }
    setStep('submitting');
    setError(null);
    try {
      const declared = Number(declaredLiters);
      const price = Number(pricePerLiter);
      const result = await submitDriverReceipt({
        vehicle_id: driver.vehicle_id,
        receipt_photo: receiptPhoto,
        merchant_name: merchantName,
        declared_liters: declared,
        price_per_liter: price,
        total_amount: Math.round(declared * price),
        odometer_km: odometerKm ? Number(odometerKm) : undefined,
        receipt_latitude: location?.lat,
        receipt_longitude: location?.lng,
        transaction_date: new Date().toISOString(),
      });
      setResultMessage(result.message);
      setStep('success');
      setRecent(await fetchDriverReceipts());
      setTimeout(() => {
        setStep('capture');
        setReceiptPhoto(null);
      }, 2500);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Submit failed');
      setStep('preview');
    }
  };

  const logout = () => {
    clearDriverToken();
    setDriver(null);
    setStep('login');
  };

  return (
    <div className="min-h-screen bg-[#0b1326] p-4 sm:p-6">
      <div className="mx-auto max-w-md">
        <div className="mb-6 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="rounded-lg bg-[#2e5bff]/20 p-2">
              <Truck className="h-6 w-6 text-[#b8c3ff]" />
            </div>
            <div>
              <h1 className="text-xl font-bold text-[#dae2fd]">FuelSense Driver</h1>
              {driver && (
                <p className="text-sm text-[#8e90a2]">
                  {driver.name} · {driver.license_plate ?? 'Unassigned'}
                </p>
              )}
            </div>
          </div>
          {driver && (
            <button type="button" onClick={logout} className="text-xs text-[#8e90a2] hover:text-[#dae2fd]">
              Sign out
            </button>
          )}
        </div>

        {step === 'login' && (
          <form onSubmit={handleLogin} className="rounded-lg border border-[#434656] bg-[#171f33] p-6 space-y-4">
            <p className="text-sm text-[#8e90a2]">Demo: CHIDI-ABC / 1234</p>
            {error && <p className="text-sm text-[#ffb4ab]">{error}</p>}
            <label className="block text-xs text-[#8e90a2]">
              Driver code
              <input
                value={driverCode}
                onChange={(e) => setDriverCode(e.target.value)}
                className="mt-1 w-full rounded-lg border border-[#434656] bg-[#0b1326] px-3 py-2 text-sm text-[#dae2fd]"
              />
            </label>
            <label className="block text-xs text-[#8e90a2]">
              PIN
              <input
                type="password"
                value={pin}
                onChange={(e) => setPin(e.target.value)}
                className="mt-1 w-full rounded-lg border border-[#434656] bg-[#0b1326] px-3 py-2 text-sm text-[#dae2fd]"
              />
            </label>
            <button type="submit" className="w-full rounded-lg bg-[#2e5bff] py-3 text-sm font-medium text-white">
              Sign in
            </button>
            <Link href="/login" className="block text-center text-xs text-[#8e90a2] hover:text-[#b8c3ff]">
              Fleet manager login →
            </Link>
          </form>
        )}

        {step !== 'login' && (
          <div className="rounded-lg border border-[#434656] bg-[#171f33] p-6">
            {step === 'capture' && (
              <>
                <button
                  type="button"
                  onClick={() => fileRef.current?.click()}
                  className="w-full rounded-lg border-2 border-dashed border-[#434656] p-8 text-center hover:border-[#b8c3ff]"
                >
                  <Receipt className="mx-auto mb-2 h-10 w-10 text-[#8e90a2]" />
                  <p className="font-medium text-[#dae2fd]">Upload fuel receipt</p>
                  <p className="mt-1 text-xs text-[#8e90a2]">Photo or enter details manually below</p>
                </button>
                <input ref={fileRef} type="file" accept="image/*" capture="environment" className="hidden" onChange={handlePhoto} />
                <div className="mt-4 flex items-center gap-2 text-xs text-[#8e90a2]">
                  <MapPin className="h-3 w-3" />
                  {location ? 'GPS attached to receipt' : 'Waiting for GPS…'}
                </div>
                <button
                  type="button"
                  onClick={() => setStep('preview')}
                  className="mt-4 w-full text-sm text-[#b8c3ff]"
                >
                  Enter details manually →
                </button>
              </>
            )}

            {(step === 'preview' || step === 'submitting') && (
              <div className="space-y-3">
                {error && <p className="text-sm text-[#ffb4ab]">{error}</p>}
                <Field label="Merchant" value={merchantName} onChange={setMerchantName} />
                <Field label="Liters (receipt)" value={declaredLiters} onChange={setDeclaredLiters} type="number" />
                <Field label="Price/L (₦)" value={pricePerLiter} onChange={setPricePerLiter} type="number" />
                <Field label="Odometer (km)" value={odometerKm} onChange={setOdometerKm} type="number" />
                <p className="text-xs text-[#8e90a2]">
                  Actual liters matched from OBD sensor (IO 390) within ±2 hours of submission.
                </p>
                <button
                  type="button"
                  disabled={step === 'submitting'}
                  onClick={handleSubmit}
                  className="w-full rounded-lg bg-[#2e5bff] py-3 text-sm font-medium text-white disabled:opacity-50"
                >
                  {step === 'submitting' ? 'Matching OBD data…' : 'Submit receipt'}
                </button>
              </div>
            )}

            {step === 'success' && (
              <div className="py-6 text-center">
                <CheckCircle className="mx-auto mb-3 h-12 w-12 text-[#4edea3]" />
                <p className="font-medium text-[#dae2fd]">Receipt submitted</p>
                <p className="mt-1 text-xs text-[#8e90a2]">{resultMessage}</p>
              </div>
            )}
          </div>
        )}

        {recent.length > 0 && step !== 'login' && (
          <div className="mt-6">
            <h3 className="mb-3 text-sm font-semibold text-[#8e90a2]">Recent submissions</h3>
            <div className="space-y-2">
              {recent.map((r) => (
                <div key={r.id} className="flex items-center justify-between rounded-lg bg-[#171f33]/80 px-3 py-2">
                  <div>
                    <p className="text-sm text-[#dae2fd]">{r.merchant_name}</p>
                    <p className="text-xs text-[#8e90a2]">
                      {new Date(r.uploaded_at).toLocaleString()} · {Number(r.declared_liters)}L
                      {r.obd_liters_actual != null && ` · OBD ${Number(r.obd_liters_actual)}L`}
                    </p>
                  </div>
                  <span
                    className={`text-xs ${
                      r.reconciliation_status === 'flagged_theft'
                        ? 'text-[#ffb4ab]'
                        : r.reconciliation_status === 'matched'
                          ? 'text-[#4edea3]'
                          : 'text-[#ffb95f]'
                    }`}
                  >
                    {r.reconciliation_status}
                  </span>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
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
    <label className="block text-xs text-[#8e90a2]">
      {label}
      <input
        type={type}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="mt-1 w-full rounded-lg border border-[#434656] bg-[#0b1326] px-3 py-2 text-sm text-[#dae2fd]"
      />
    </label>
  );
}
