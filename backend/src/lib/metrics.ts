/**
 * Prometheus instrumentation.
 *
 * The two halves of this process fail in completely different ways and neither
 * shows up in the other's numbers. The Express API fails visibly — a request
 * 500s and somebody notices. The TCP side fails silently: a tracker's NAT
 * mapping dies, or a Codec8E packet fails to parse, and the only symptom is
 * that telemetry stops arriving. That is the failure this file exists for.
 * `fuelsense_tcp_frames_total` going flat is the alert nobody had on 2026-08-09
 * or 2026-08-20.
 *
 * Label cardinality is the thing to guard here. IMEI is a bounded set (one row
 * per registered device) so it is safe as a label; request paths are not, which
 * is why the HTTP middleware labels on the matched Express route pattern rather
 * than the raw URL.
 */
import {
  Registry,
  Counter,
  Gauge,
  Histogram,
  collectDefaultMetrics,
} from 'prom-client';
import type { Request, Response, NextFunction } from 'express';
import type { Pool } from 'pg';

export const registry = new Registry();

registry.setDefaultLabels({ service: 'fuelsense-backend' });

// Event loop lag, heap, GC, handles. Cheap, and the first place to look when
// the API is slow but the database is not.
collectDefaultMetrics({ register: registry, prefix: 'fuelsense_' });

/* ---------------------------------------------------------------- HTTP --- */

export const httpRequestDuration = new Histogram({
  name: 'fuelsense_http_request_duration_seconds',
  help: 'Express request duration by route, method and status class',
  labelNames: ['method', 'route', 'status'] as const,
  // Weighted towards the fast end: the dashboard polls a lot of small
  // endpoints, and the interesting question is which of them creeps past
  // 500ms, not how the tail beyond 10s is shaped.
  buckets: [0.005, 0.015, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
  registers: [registry],
});

export const httpRequestsInFlight = new Gauge({
  name: 'fuelsense_http_requests_in_flight',
  help: 'Requests currently being served',
  registers: [registry],
});

/**
 * The matched route pattern, never the raw URL.
 *
 * `/api/vehicles/:id` is one time series; `/api/vehicles/<uuid>` would be one
 * per vehicle, and Prometheus would carry every vehicle that has ever been
 * looked up for as long as the series is retained. Unmatched paths collapse to
 * a single `unmatched` bucket for the same reason — a 404 scanner would
 * otherwise mint a label per probed URL.
 */
const routeLabel = (req: Request): string => {
  const route = (req as Request & { route?: { path?: string } }).route;
  if (route?.path) {
    const base = req.baseUrl || '';
    const path = route.path === '/' ? '' : route.path;
    return `${base}${path}` || '/';
  }
  return 'unmatched';
};

export const metricsMiddleware = (
  req: Request,
  res: Response,
  next: NextFunction
): void => {
  // The scrape must not measure itself, or every scrape adds a sample to the
  // histogram it is about to read.
  if (req.path === '/metrics') return next();

  httpRequestsInFlight.inc();
  const stopTimer = httpRequestDuration.startTimer();

  res.on('finish', () => {
    httpRequestsInFlight.dec();
    stopTimer({
      method: req.method,
      route: routeLabel(req),
      status: String(res.statusCode),
    });
  });

  // A client that hangs up mid-request never fires `finish`, and the in-flight
  // gauge would drift upward forever.
  res.on('close', () => {
    if (!res.writableEnded) {
      httpRequestsInFlight.dec();
      stopTimer({
        method: req.method,
        route: routeLabel(req),
        status: 'aborted',
      });
    }
  });

  next();
};

/* ----------------------------------------------------------------- TCP --- */

export const tcpDevicesConnected = new Gauge({
  name: 'fuelsense_tcp_devices_connected',
  help: 'Trackers with an open TCP connection right now',
  registers: [registry],
});

export const tcpFramesTotal = new Counter({
  name: 'fuelsense_tcp_frames_total',
  help: 'AVL records received and persisted, by device',
  labelNames: ['imei'] as const,
  registers: [registry],
});

export const tcpHandshakesTotal = new Counter({
  name: 'fuelsense_tcp_handshakes_total',
  help: 'Device handshakes, by outcome',
  labelNames: ['outcome'] as const, // accepted | rejected | error
  registers: [registry],
});

export const tcpParseFailuresTotal = new Counter({
  name: 'fuelsense_tcp_parse_failures_total',
  help: 'Packets discarded because Codec8E parsing threw — telemetry lost',
  labelNames: ['imei'] as const,
  registers: [registry],
});

export const tcpSocketTimeoutsTotal = new Counter({
  name: 'fuelsense_tcp_socket_timeouts_total',
  help: 'Sockets dropped for going silent past the idle timeout',
  labelNames: ['imei'] as const,
  registers: [registry],
});

/**
 * Seconds since the last AVL record from each device.
 *
 * A counter answers "is anything arriving at all"; this answers "which one
 * stopped". Computed at scrape time from the last-seen timestamps rather than
 * kept fresh by a timer, so it costs nothing between scrapes.
 */
const lastFrameAt = new Map<string, number>();

export const recordFrame = (imei: string): void => {
  tcpFramesTotal.inc({ imei });
  lastFrameAt.set(imei, Date.now());
};

export const tcpSecondsSinceLastFrame = new Gauge({
  name: 'fuelsense_tcp_seconds_since_last_frame',
  help: 'Seconds since the last AVL record from a device, since process start',
  labelNames: ['imei'] as const,
  registers: [registry],
  collect() {
    const now = Date.now();
    for (const [imei, at] of lastFrameAt) {
      this.set({ imei }, (now - at) / 1000);
    }
  },
});

/* ------------------------------------------------------------ database --- */

/**
 * `pg` already tracks these three numbers; this just exposes them.
 *
 * `waiting` is the one that matters. Non-zero and sustained means requests are
 * queueing for a connection, which surfaces as slow endpoints across the board
 * with no single slow query to blame.
 */
export const registerPoolMetrics = (pool: Pool): void => {
  new Gauge({
    name: 'fuelsense_db_pool_total',
    help: 'Connections in the pg pool',
    registers: [registry],
    collect() {
      this.set(pool.totalCount);
    },
  });

  new Gauge({
    name: 'fuelsense_db_pool_idle',
    help: 'Idle connections in the pg pool',
    registers: [registry],
    collect() {
      this.set(pool.idleCount);
    },
  });

  new Gauge({
    name: 'fuelsense_db_pool_waiting',
    help: 'Requests queued waiting for a pg connection',
    registers: [registry],
    collect() {
      this.set(pool.waitingCount);
    },
  });
};
