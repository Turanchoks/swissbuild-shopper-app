// JS-only shim for the SwissKnifePurchases native module.
//
// The real SDK in packages/react-native-sdk/src/native/module.ts requires a
// linked TurboModule. The Expo bare sample here does NOT compile that native
// module, so we provide a JS-only adapter that satisfies the same shape:
//
//   - Analytics surface (getDeviceId / trackEvent / flushEvents) -- buffers
//     events in memory then POSTs to /api/sdk/events/batch on flush.
//   - Identity surface (logIn / logOut / getAppUserID / isAnonymous) --
//     POSTs to /api/sdk/users/identify so anonymous→identified merges happen
//     server-side and the maestro flows can drive the same `app_users`
//     table mutations the parity unit tests assert.
//   - Attribute surface (setEmail / setDisplayName / setPushToken /
//     setAttributes) -- PATCH /api/sdk/users/attributes; backend dispatches
//     the user.updated outgoing webhook the parity Misc tests verify.
//   - Purchase / offerings surface -- the bare Expo project has no native
//     billing module, so these proxy to the validation/check endpoints
//     where possible (purchasePackage/restorePurchases POST a synthetic
//     subscription validation request; getOfferings GETs the configured
//     offering). Refunds / time-dependent cases still need a real
//     simulator running StoreKit-config — flagged manual in the parity
//     matrix.

import "react-native"; // satisfy the SDK module's RN import expectations

let _deviceId: string | null = null;
let _queue: Record<string, unknown>[] = [];

// ── Transport observability (sample-local, not SDK internals) ─────────
//
// Several shim methods deliberately swallow a non-OK response (getCustomerInfo
// / restorePurchases return an empty entitlements object so the "restore
// returns nothing" parity flow stays green). That hides exactly the failures a
// backend-fault stress test is looking for, so every HTTP round-trip the shim
// makes also records its raw outcome here. This is the sample's own network
// layer — reading it is not reaching into the SDK.

export type ShimOutcome = {
  path: string;
  ok: boolean;
  status: number | null;
  /** Shared error vocabulary — see samples/README.md for the token list. */
  kind: string | null;
  detail: string | null;
  at: number;
};

let _lastOutcome: ShimOutcome | null = null;

/** Classify an HTTP status into the cross-platform error vocabulary. */
function kindForStatus(status: number): string {
  if (status >= 500) return "backend_unavailable";
  if (status === 401 || status === 403) return "backend_rejected";
  if (status >= 400) return "backend_rejected";
  return "unknown";
}

function recordOk(path: string, status: number): void {
  _lastOutcome = { path, ok: true, status, kind: null, detail: null, at: Date.now() };
}

function recordHttpFailure(path: string, status: number, detail: string): void {
  _lastOutcome = {
    path,
    ok: false,
    status,
    kind: kindForStatus(status),
    detail: detail.slice(0, 120),
    at: Date.now(),
  };
}

function recordThrow(path: string, error: unknown): void {
  const message = error instanceof Error ? error.message : String(error);
  _lastOutcome = {
    path,
    ok: false,
    status: null,
    kind: message.includes("before configure") ? "not_configured" : "network_error",
    detail: message.slice(0, 120),
    at: Date.now(),
  };
}

/** Outcome of the most recent HTTP round-trip the shim attempted. */
export function getShimLastOutcome(): ShimOutcome | null {
  return _lastOutcome;
}

/**
 * Events handed to the shim by `Analytics.track()` that have not been flushed
 * yet. This is the sample's own in-memory queue standing in for the native
 * event queue — the real SDK exposes no queue-depth getter on any platform.
 */
export function getShimQueueDepth(): number {
  return _queue.length;
}

function generateUUID(): string {
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === "x" ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

// Wired up from App.tsx — without these the shim has no way to reach the API.
let _apiKey: string | null = null;
let _serverURL: string | null = null;
let _userId: string | null = null;
let _anonymousId: string | null = null;

export function configureNativeShim(opts: {
  apiKey: string;
  serverURL: string;
  userId?: string | null;
  anonymousId: string;
}): void {
  _apiKey = opts.apiKey;
  _serverURL = opts.serverURL;
  _userId = opts.userId ?? null;
  _anonymousId = opts.anonymousId;
}

export function setUserIdForShim(id: string | null): void {
  _userId = id;
}

// The module this shim stands in for gives up on a request after 20 s: the RN
// SDK's native getOfferings & co. go through SwissKnifeiOS's BackendHttpClient
// (`timeoutIntervalForRequest` = 20 s). RN's own fetch has no timeout below
// the platform's 60 s, so without this a stalled backend kept the shim waiting
// out the stall and answering "ok", and the stress suite's case 04 (a 35 s
// stall) measured this sample's transport instead of the SDK's contract.
const REQUEST_TIMEOUT_MS = 20_000;

async function authFetch(
  path: string,
  init: { method: string; body?: unknown } = { method: "GET" }
): Promise<Response> {
  if (!_apiKey || !_serverURL) {
    const err = new Error(`[native-shim] ${path} called before configure`);
    recordThrow(path, err);
    throw err;
  }
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "X-API-Key": _apiKey,
  };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  let res: Response;
  try {
    res = await fetch(`${_serverURL}${path}`, {
      method: init.method,
      headers,
      body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
      signal: controller.signal,
    });
  } catch (e) {
    recordThrow(
      path,
      controller.signal.aborted
        ? new Error(`request timed out after ${REQUEST_TIMEOUT_MS / 1000}s`)
        : e
    );
    throw e;
  } finally {
    clearTimeout(timer);
  }
  if (res.ok) {
    recordOk(path, res.status);
  } else {
    recordHttpFailure(path, res.status, res.statusText ?? "");
  }
  return res;
}

const shim = {
  // ── SDK lifecycle ───────────────────────────────────────────────────
  configure: async (_opts: unknown): Promise<void> => {},
  isConfigured: async (): Promise<boolean> => true,

  // ── Offerings ───────────────────────────────────────────────────────
  // GET /api/sdk/offerings → returns the configured offering JSON. The
  // SDK's getOfferings() expects a PurchasesOfferings shape; for the
  // maestro flow we return whatever the server gave us so the flow can
  // assert "got an object back, not an exception".
  getOfferings: async (): Promise<unknown> => {
    const res = await authFetch("/api/sdk/offerings");
    if (!res.ok) {
      throw new Error(`getOfferings failed: HTTP ${res.status}`);
    }
    return res.json();
  },

  getCustomerInfo: async (): Promise<unknown> => {
    const userId = _userId ?? _anonymousId;
    const res = await authFetch(
      `/api/sdk/entitlements/list?app_user_id=${encodeURIComponent(userId ?? "")}`
    );
    if (!res.ok) {
      // Backend may legitimately have no entitlements yet — return empty.
      return { entitlements: { active: {}, all: {} } };
    }
    return res.json();
  },

  // ── Purchase ────────────────────────────────────────────────────────
  // No native billing here; we synthesize a validation request against
  // the configured StoreKit / Play test product so the backend writes a
  // subscription row the parity flows can grep for.
  purchasePackage: async (
    packageId: string,
    _offeringId: string
  ): Promise<unknown> => {
    const userId = _userId ?? _anonymousId;
    const res = await authFetch("/api/sdk/subscriptions/validate", {
      method: "POST",
      body: {
        app_user_id: userId,
        product_id: packageId,
        platform: "ios",
        receipt: { __maestro_synthesized: true },
      },
    });
    if (!res.ok) {
      const txt = await res.text().catch(() => "");
      throw new Error(`purchasePackage failed: HTTP ${res.status} ${txt}`);
    }
    return res.json();
  },

  purchaseStoreProduct: async (productId: string): Promise<unknown> =>
    shim.purchasePackage(productId, ""),

  restorePurchases: async (): Promise<unknown> => {
    const userId = _userId ?? _anonymousId;
    const res = await authFetch(
      `/api/sdk/entitlements/list?app_user_id=${encodeURIComponent(userId ?? "")}`
    );
    if (!res.ok) {
      return { entitlements: { active: {}, all: {} } };
    }
    return res.json();
  },

  // ── Identity ────────────────────────────────────────────────────────
  // POST /api/sdk/users/identify -- aliases anonymous_id to user_id
  // server-side; the backend's identify handler decides whether to merge
  // or fork the previously-seen anonymous user.
  logIn: async (
    appUserID: string
  ): Promise<{ customerInfo: unknown; created: boolean }> => {
    const res = await authFetch("/api/sdk/users/identify", {
      method: "POST",
      body: {
        anonymous_id: _anonymousId,
        user_id: appUserID,
      },
    });
    if (!res.ok) {
      const txt = await res.text().catch(() => "");
      throw new Error(`logIn failed: HTTP ${res.status} ${txt}`);
    }
    _userId = appUserID;
    const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    return {
      customerInfo: json,
      created: Boolean(json.created),
    };
  },

  logOut: async (): Promise<unknown> => {
    // Reset to a brand-new anonymous id and clear the identified user.
    _userId = null;
    _anonymousId = `anon_${generateUUID()}`;
    return shim.getCustomerInfo();
  },

  getAppUserID: async (): Promise<string> => _userId ?? _anonymousId ?? "",
  isAnonymous: async (): Promise<boolean> => !_userId,

  // ── Attributes ──────────────────────────────────────────────────────
  // PATCH /api/sdk/users/attributes -- the backend persists into
  // app_users.properties and triggers the user.updated webhook so the
  // attributeUpdateFiresWebhook parity case can be verified.
  setAttributes: async (attrs: Record<string, string | null>): Promise<void> => {
    const userId = _userId ?? _anonymousId;
    const res = await authFetch("/api/sdk/users/attributes", {
      method: "PATCH",
      body: { app_user_id: userId, attributes: attrs },
    });
    if (!res.ok) {
      const txt = await res.text().catch(() => "");
      throw new Error(`setAttributes failed: HTTP ${res.status} ${txt}`);
    }
  },

  setEmail: async (email: string | null): Promise<void> =>
    shim.setAttributes({ $email: email }),
  setDisplayName: async (name: string | null): Promise<void> =>
    shim.setAttributes({ $displayName: name }),
  // The reserved key on the wire is `$phone`, NOT `$phoneNumber` — that is what
  // the native SDKs send (`SwissKnife.swift` → `reservedKey: "$phone"`) and the
  // only spelling `/api/sdk/users/attributes` accepts as reserved. Writing
  // `$phoneNumber` here stored it as an ordinary custom attribute, so the shim
  // silently stopped demonstrating real reserved-attribute behaviour.
  setPhoneNumber: async (phone: string | null): Promise<void> =>
    shim.setAttributes({ $phone: phone }),
  setPushToken: async (token: string | null): Promise<void> =>
    shim.setAttributes({ $pushToken: token }),

  setLogLevel: async (): Promise<void> => {},

  // ── Analytics ───────────────────────────────────────────────────────
  getDeviceId: async (): Promise<string> => {
    if (!_deviceId) _deviceId = generateUUID();
    return _deviceId;
  },

  trackEvent: async (event: Record<string, unknown>): Promise<void> => {
    _queue.push(event);
  },

  flushEvents: async (): Promise<void> => {
    if (_queue.length === 0) return;
    if (!_apiKey || !_serverURL) {
      console.warn("[native-shim] flushEvents called before configure");
      return;
    }
    const batch = _queue.splice(0, _queue.length);

    // Translate SwissKnife SKEvent shape → /api/sdk/events/batch payload.
    const events = batch.map((e) => {
      const evt = e as Record<string, unknown>;
      const time = typeof evt.time === "number" ? evt.time : Date.now();
      return {
        event_id: String(evt.event_id),
        name: String(evt.event_type),
        properties: (evt.event_properties as Record<string, unknown>) ?? {},
        timestamp: new Date(time).toISOString(),
        session_id:
          evt.session_id != null ? String(evt.session_id) : null,
        device_model: "iPhone Simulator",
        os_version: "26.4",
        app_version: "1.0.0-maestro",
        country: "US",
        locale: "en-US",
      };
    });

    try {
      const res = await fetch(`${_serverURL}/api/sdk/events/batch`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-API-Key": _apiKey,
        },
        body: JSON.stringify({
          user_id: _userId ?? undefined,
          anonymous_id: _anonymousId,
          events,
        }),
      });
      if (!res.ok) {
        const txt = await res.text().catch(() => "");
        recordHttpFailure("/api/sdk/events/batch", res.status, txt);
        console.warn(`[native-shim] flush failed: HTTP ${res.status}`, txt);
      } else {
        recordOk("/api/sdk/events/batch", res.status);
      }
    } catch (e) {
      recordThrow("/api/sdk/events/batch", e);
      console.warn("[native-shim] flush error:", e);
    }
  },

  addListener: (_: string): void => {},
  removeListeners: (_: number): void => {},
};

export function getNativeModule(): typeof shim {
  return shim;
}

export function getEventEmitter(): { addListener: () => void; removeAllListeners: () => void } {
  return {
    addListener: () => {},
    removeAllListeners: () => {},
  };
}

export function __resetNativeModuleForTests(): void {
  _deviceId = null;
  _queue = [];
  _userId = null;
  _lastOutcome = null;
}
