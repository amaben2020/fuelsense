export type ReplayTarget =
  | { kind: 'siphon'; id: string }
  | { kind: 'receipt'; id: string }
  | { kind: 'daily'; vehicleId: string; activityDate: string; flagType?: string };

export function replayApiPath(target: ReplayTarget): string {
  switch (target.kind) {
    case 'siphon':
      return `/fuel-events/siphon-events/${target.id}/replay`;
    case 'receipt':
      return `/fuel-events/receipts/${target.id}/replay`;
    case 'daily':
      return `/telemetry/daily-activity/replay?vehicle_id=${encodeURIComponent(target.vehicleId)}&date=${encodeURIComponent(target.activityDate)}${target.flagType ? `&flag_type=${encodeURIComponent(target.flagType)}` : ''}`;
  }
}
