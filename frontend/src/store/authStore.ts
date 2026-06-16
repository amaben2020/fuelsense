import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { Customer } from '@/lib/api';

interface AuthState {
  customer: Customer | null;
  setCustomer: (customer: Customer) => void;
  clearAuth: () => void;
}

export const useAuthStore = create<AuthState>()(
  persist(
    (set) => ({
      customer: null,
      setCustomer: (customer) => set({ customer }),
      clearAuth: () => set({ customer: null }),
    }),
    { name: 'fuelsense_auth' }
  )
);
