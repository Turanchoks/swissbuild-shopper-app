// samples/maestro-app/src/diagnostics.ts
//
// State behind the on-screen diagnostics panel in App.tsx.
//
// Maestro can only assert on what the app renders. The SDK's failure surface
// is thin — `Analytics.flush()` resolves whether or not delivery worked, there
// is no public error callback or connection-state listener, and no queue-depth
// getter — so this app keeps its own counters and renders them with stable
// testIDs. The identifier and token vocabulary is mirrored verbatim in
// samples/ios-maestro-app and samples/android-maestro-app so one flow shape
// drives all three platforms.

import { getShimLastOutcome, type ShimOutcome } from "./swiss-knife/native-shim";

/** Stable operation tokens rendered into `diag-last-op`. */
export type DiagOp =
  | "track_event"
  | "identify"
  | "fetch_offerings"
  | "fetch_customer_info";

/**
 * Stable status tokens rendered into `diag-last-status`.
 *
 * `dispatched` is deliberately distinct from `ok`: `Analytics.track()` hands
 * the event to the queue and `flush()` resolves regardless of what the
 * backend said, so the app cannot claim delivery succeeded. Reporting that as
 * `ok` would make a stress test pass while the backend is down.
 */
export type DiagStatus = "none" | "ok" | "error" | "dispatched";

export type DiagState = {
  lastOp: string;
  lastStatus: DiagStatus;
  lastErrorKind: string;
  lastDetail: string;
  okCount: number;
  failCount: number;
};

export type DiagResult = {
  op: DiagOp;
  status: DiagStatus;
  errorKind: string;
  detail: string;
};

export const initialDiagState: DiagState = {
  lastOp: "none",
  lastStatus: "none",
  lastErrorKind: "none",
  lastDetail: "none",
  okCount: 0,
  failCount: 0,
};

export function applyDiagResult(prev: DiagState, result: DiagResult): DiagState {
  return {
    lastOp: result.op,
    lastStatus: result.status,
    lastErrorKind: result.errorKind,
    lastDetail: result.detail.slice(0, 120) || "none",
    okCount:
      result.status === "ok" || result.status === "dispatched"
        ? prev.okCount + 1
        : prev.okCount,
    failCount: result.status === "error" ? prev.failCount + 1 : prev.failCount,
  };
}

function kindFromThrow(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  if (message.includes("before configure")) return "not_configured";
  const httpMatch = /HTTP (\d{3})/.exec(message);
  if (httpMatch) {
    const status = Number(httpMatch[1]);
    if (status >= 500) return "backend_unavailable";
    if (status >= 400) return "backend_rejected";
  }
  return "network_error";
}

function detailOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Drive one SDK operation and turn it into an assertable result.
 *
 * The shim behind the SDK deliberately swallows some non-OK responses (a
 * missing entitlements list is a legitimate empty result for the restore
 * parity flow). That is exactly the failure a backend-fault stress test cares
 * about, so we compare the shim's last transport outcome before and after the
 * call and report a swallowed failure as `error`.
 */
export async function runDiagOp(
  op: DiagOp,
  work: () => Promise<string>
): Promise<DiagResult> {
  const before: ShimOutcome | null = getShimLastOutcome();
  try {
    const detail = await work();
    const after = getShimLastOutcome();
    if (after && after !== before && !after.ok) {
      return {
        op,
        status: "error",
        errorKind: after.kind ?? "unknown",
        detail: `${after.path} ${after.detail ?? ""}`.trim(),
      };
    }
    return { op, status: "ok", errorKind: "none", detail };
  } catch (e) {
    const after = getShimLastOutcome();
    const kind =
      after && after !== before && !after.ok
        ? (after.kind ?? "unknown")
        : kindFromThrow(e);
    return { op, status: "error", errorKind: kind, detail: detailOf(e) };
  }
}
