export interface PendingDriverReceipt {
  client_receipt_id: string;
  created_at: string;
  vehicle_id: string;
  receipt_photo?: string | null;
  merchant_name: string;
  merchant_address?: string | null;
  declared_liters: number;
  price_per_liter: number;
  total_amount: number;
  odometer_km?: number;
  receipt_latitude?: number;
  receipt_longitude?: number;
  transaction_date: string;
  sync_error?: string | null;
}

const QUEUE_KEY = 'fuelsense_driver_receipt_queue';

function readQueue(): PendingDriverReceipt[] {
  if (typeof window === 'undefined') return [];
  try {
    const raw = localStorage.getItem(QUEUE_KEY);
    return raw ? (JSON.parse(raw) as PendingDriverReceipt[]) : [];
  } catch {
    return [];
  }
}

function writeQueue(items: PendingDriverReceipt[]) {
  localStorage.setItem(QUEUE_KEY, JSON.stringify(items));
}

export function getOfflineReceiptQueue(): PendingDriverReceipt[] {
  return readQueue();
}

export function getOfflineQueueCount(): number {
  return readQueue().length;
}

export function enqueueOfflineReceipt(receipt: Omit<PendingDriverReceipt, 'created_at' | 'client_receipt_id'> & {
  client_receipt_id?: string;
}) {
  const item: PendingDriverReceipt = {
    ...receipt,
    client_receipt_id: receipt.client_receipt_id ?? crypto.randomUUID(),
    created_at: new Date().toISOString(),
  };
  writeQueue([item, ...readQueue()]);
  return item;
}

export function removeOfflineReceipt(clientReceiptId: string) {
  writeQueue(readQueue().filter((item) => item.client_receipt_id !== clientReceiptId));
}

export function markOfflineReceiptError(clientReceiptId: string, message: string) {
  writeQueue(
    readQueue().map((item) =>
      item.client_receipt_id === clientReceiptId ? { ...item, sync_error: message } : item
    )
  );
}

export function isOnline(): boolean {
  return typeof navigator !== 'undefined' ? navigator.onLine : true;
}

export function onConnectivityChange(callback: () => void) {
  window.addEventListener('online', callback);
  window.addEventListener('offline', callback);
  return () => {
    window.removeEventListener('online', callback);
    window.removeEventListener('offline', callback);
  };
}
