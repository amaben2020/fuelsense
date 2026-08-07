/**
 * What this account can see.
 *
 * Hardcoded for now, deliberately: the tiers are a product decision that has
 * not been made yet, and inventing a billing table before anyone has paid
 * would be building the wrong thing precisely. One constant here means the
 * switch to a real per-customer field later touches this file and nothing else.
 *
 * PRO covers everything that needs hardware this fleet does not have — tank
 * sensors, CAN adapters, device scenario events — plus the receipt
 * reconciliation built on top of them. Gating rather than deleting keeps that
 * work intact for the first customer who fits a sensor.
 */
export type Plan = 'BASIC' | 'PRO';

export const CURRENT_PLAN: Plan = (process.env.NEXT_PUBLIC_PLAN as Plan) || 'BASIC';

export const isPro = (): boolean => CURRENT_PLAN === 'PRO';

/** Features held back from BASIC, each with the reason a manager would be told. */
export const PRO_FEATURES = {
  /** Litres claimed vs litres measured — needs a tank sensor or CAN adapter. */
  receiptReconciliation: {
    label: 'Receipt reconciliation',
    needs: 'A fuel-level sensor or CAN adapter, so declared litres can be measured against what entered the tank.',
  },
  /** Siphon/theft replay — needs a level sensor to see fuel leaving the tank. */
  evidenceReplay: {
    label: 'Evidence replay',
    needs: 'A fuel-level sensor: replaying a siphon means showing fuel leaving the tank, which GNSS cannot see.',
  },
} as const;
