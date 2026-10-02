// packages/react-native-sdk/src/modules/analytics.ts
//
// Amplitude/Mixpanel-compatible analytics SDK for swiss-knife (React Native).
// Drop-in replacement interface.
//
// ## Architecture: thin pass-through to native
//
// Phase 2.3 of the RC rip-and-replace makes the RN Analytics layer a thin
// pass-through to the native event queue:
//
//   - **JS owns the payload shape** — `event_id`, `device_id`, super
//     properties, timed-event duration, identify merging, session id, user
//     id, user properties, groups. These are constructed client-side because
//     they depend on JS-only state (super properties + timed events + user
//     properties live in this module).
//
//   - **Native owns the queue** — disk persistence (iOS Caches /
//     Android cacheDir), exponential back-off with jitter, dead-letter on
//     permanent failure, 5-retry cap. JS can't provide any of that: a JS
//     queue is lost on every JS reload and there is no reliable way to
//     persist + retry from within an RN bridge thread.
//
// The bridge surface is just two methods: `trackEvent(event)` and
// `flushEvents()`. JS calls `trackEvent` once per event with the fully-built
// payload; native persists it and runs its own scheduler. Auto-flush
// scheduling lives in native too (iOS Timer / Android WorkManager). The JS
// `flushIntervalMs` timer is kept as a defensive nudge but the native side
// is the source of truth.
//
// ## device_id source-of-truth: native bridge
//
// `device_id` is sourced from the native SDK (iOS Keychain via
// `SwissKnife.getDeviceId()`, Android EncryptedSharedPreferences via
// `SwissKnife.getDeviceId(context)`) — NEVER generated in JS.
//
// Why: a JS-generated UUID lives in module scope and is reset on every cold
// start. That fragments every user's analytics timeline on every app restart
// (one anonymous user becomes N anonymous users). Native persistence (Keychain
// / EncryptedSharedPreferences) survives process restart AND app reinstall on
// iOS, and survives process restart but NOT auto-backup transfer on Android —
// see `packages/swiss-knife-{ios,android}` for the storage rationale.
//
// ## event_id generation policy
//
// `event_id` is generated **in JS at event-construction time** (the moment
// `track()` is called). Native receives it as-is and writes it to disk.
//
// Why JS-side: the idempotency key needs to be stable across bridge
// round-trips. If native generated it on receipt, a bridge crash mid-call
// could (in theory) result in JS retrying `trackEvent` and native assigning
// a fresh id to what is logically the same event — defeating dedupe at the
// backend `(app_project_id, event_id)` unique index. Generating it in JS,
// before the bridge call, eliminates that window.
//
// ## Startup-race handling
//
// The native `getDeviceId()` call is async. Code that calls `Analytics.track()`
// immediately after `Analytics.init()` may build events before the native
// promise resolves. We handle this by:
//   1. Stamping `device_id` synchronously when the value is already known.
//   2. Awaiting the native promise inside `track()` when it's still pending,
//      then handing the now-stamped event to the native bridge.
//
// Bridge failure falls back to the sentinel string `"unknown-device"` so the
// backend `events.device_id` column stays populated. See the FALLBACK_DEVICE_ID
// constant.

import { getNativeModule } from "./native-shim";

// MARK: - Types

export interface SKAnalyticsConfig {
  apiKey: string;
  serverURL?: string;
  flushQueueSize?: number;
  flushIntervalMs?: number;
  optOut?: boolean;
  trackingSessionEvents?: boolean;
}

export interface SKEvent {
  /**
   * Client-supplied idempotency key (UUID). Generated in JS at event-create
   * time so the key is stable across bridge crashes and the backend dedupes
   * via the `(app_project_id, event_id)` unique index. See the module
   * doc-comment for the rationale.
   */
  event_id: string;
  event_type: string;
  event_properties?: Record<string, unknown>;
  user_id?: string;
  device_id?: string;
  session_id?: number;
  time?: number;
  platform?: string;
  os_name?: string;
  user_properties?: Record<string, unknown>;
  groups?: Record<string, unknown>;
}

// MARK: - Identify (user properties — Amplitude-compatible)

export class SKIdentify {
  private operations: Array<{ op: string; key?: string; value?: unknown }> = [];

  set(property: string, value: unknown): this {
    this.operations.push({ op: "$set", key: property, value });
    return this;
  }

  setOnce(property: string, value: unknown): this {
    this.operations.push({ op: "$setOnce", key: property, value });
    return this;
  }

  unset(property: string): this {
    this.operations.push({ op: "$unset", key: property });
    return this;
  }

  add(property: string, value: number): this {
    this.operations.push({ op: "$add", key: property, value });
    return this;
  }

  append(property: string, value: unknown): this {
    this.operations.push({ op: "$append", key: property, value });
    return this;
  }

  prepend(property: string, value: unknown): this {
    this.operations.push({ op: "$prepend", key: property, value });
    return this;
  }

  remove(property: string, value: unknown): this {
    this.operations.push({ op: "$remove", key: property, value });
    return this;
  }

  union(property: string, values: unknown[]): this {
    this.operations.push({ op: "$union", key: property, value: values });
    return this;
  }

  clearAll(): this {
    this.operations.push({ op: "$clearAll" });
    return this;
  }

  /** @internal */
  _getOperations() {
    return this.operations;
  }
}

// MARK: - Revenue

export class SKRevenue {
  productId: string = "";
  quantity: number = 1;
  price: number = 0;
  revenueType?: string;
  receipt?: string;
  eventProperties?: Record<string, unknown>;
}

// MARK: - Main SDK

/** Sentinel device_id when the native bridge fails. Documented in module doc-comment. */
const FALLBACK_DEVICE_ID = "unknown-device";

let _config: SKAnalyticsConfig | null = null;
let _userId: string | undefined;
/**
 * The resolved device id. `null` until the native bridge resolves (or until
 * `setDeviceId` is called). When `null`, `track()` awaits the native promise
 * before stamping the outgoing event so every event sent across the bridge
 * carries a `device_id`.
 */
let _deviceId: string | null = null;
/**
 * In-flight (or settled) promise for the native `getDeviceId()` call. `track()`
 * awaits this to guarantee every emitted event carries a `device_id`. Resolves
 * to the sentinel on bridge failure (never rejects to callers).
 */
let _deviceIdPromise: Promise<string> | null = null;
let _sessionId: number = Date.now();
let _userProperties: Record<string, unknown> = {};
let _groups: Record<string, unknown> = {};
let _superProperties: Record<string, unknown> = {};
let _timedEvents: Record<string, number> = {};
let _flushTimer: ReturnType<typeof setInterval> | null = null;

function generateUUID(): string {
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === "x" ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

/**
 * Detect whether we're in a React Native runtime (`navigator` is defined by RN's
 * polyfill) vs plain Node. Wrapped in a function so the `navigator` global
 * reference is hidden behind a runtime check the TS lib doesn't have to know
 * about — we set `tsconfig.lib = ES2020` which omits `dom`/`webworker`, so a
 * bare `typeof navigator` triggers `Cannot find name 'navigator'`.
 */
function detectOsName(): string {
  return typeof (globalThis as { navigator?: unknown }).navigator !== "undefined"
    ? "rn"
    : "node";
}

/**
 * Kick off the native `getDeviceId()` call and resolve `_deviceIdPromise`.
 * Always resolves (never rejects) — bridge failure produces the sentinel so
 * `track()` can always make progress.
 */
function loadDeviceIdFromNative(): Promise<string> {
  const p = (async () => {
    try {
      const id = await getNativeModule().getDeviceId();
      if (typeof id === "string" && id.length > 0) {
        _deviceId = id;
        return id;
      }
      console.warn(
        `[SwissKnife Analytics] native getDeviceId() returned an empty value; falling back to "${FALLBACK_DEVICE_ID}"`
      );
      _deviceId = FALLBACK_DEVICE_ID;
      return FALLBACK_DEVICE_ID;
    } catch (e) {
      console.warn(
        `[SwissKnife Analytics] native getDeviceId() failed; falling back to "${FALLBACK_DEVICE_ID}":`,
        e
      );
      _deviceId = FALLBACK_DEVICE_ID;
      return FALLBACK_DEVICE_ID;
    }
  })();
  _deviceIdPromise = p;
  return p;
}

/**
 * Fire-and-forget send to the native bridge. We do NOT throw out of the public
 * `track()`/`identify()`/etc. surface because analytics is fire-and-forget for
 * app code — app authors don't want a typo-in-event-name or a bridge hiccup to
 * propagate up the call stack. Failures are logged once.
 */
function sendToNativeFireAndForget(event: SKEvent): void {
  void (async () => {
    try {
      await getNativeModule().trackEvent(event as unknown as Record<string, unknown>);
    } catch (e) {
      console.warn(
        `[SwissKnife Analytics] native trackEvent() failed (event will be dropped):`,
        e
      );
    }
  })();
}

/**
 * Build a fully-stamped event from `eventType` + props + current SDK state.
 * Awaits the native device-id promise when the cached id is still null.
 * The returned event is ready to hand to the native bridge.
 */
async function buildEvent(
  eventType: string,
  eventProperties: Record<string, unknown> | undefined,
  overrides?: Partial<SKEvent>
): Promise<SKEvent> {
  // Merge super properties (event props override)
  const mergedProps: Record<string, unknown> = { ..._superProperties, ...eventProperties };

  // Timed event duration
  if (_timedEvents[eventType]) {
    mergedProps.$duration = (Date.now() - _timedEvents[eventType]) / 1000;
    delete _timedEvents[eventType];
  }

  // Resolve device_id. Synchronous when already cached; otherwise await the
  // native bridge promise (kicked off in init()) so every event handed to
  // native has a device_id stamped.
  let deviceId = _deviceId;
  if (deviceId == null) {
    if (_deviceIdPromise == null) loadDeviceIdFromNative();
    deviceId = (await _deviceIdPromise) ?? FALLBACK_DEVICE_ID;
  }

  return {
    event_id: generateUUID(),
    event_type: eventType,
    event_properties: mergedProps,
    user_id: _userId ?? "",
    device_id: deviceId,
    session_id: _sessionId,
    time: Date.now(),
    platform: "React Native",
    os_name: detectOsName(),
    user_properties: { ..._userProperties },
    groups: { ..._groups },
    ...overrides,
  };
}

export const Analytics = {
  // MARK: Initialize

  /**
   * Configure the analytics SDK. Kicks off (but does not block on) the native
   * `device_id` fetch — callers do not need to `await init()`. Events tracked
   * before the native promise resolves are still sent with `device_id`
   * stamped because `track()` internally awaits the native promise before
   * crossing the bridge.
   */
  init(config: SKAnalyticsConfig): Promise<void> {
    _config = {
      flushQueueSize: 30,
      flushIntervalMs: 30_000,
      optOut: false,
      trackingSessionEvents: true,
      ...config,
    };
    _sessionId = Date.now();

    if (_flushTimer) clearInterval(_flushTimer);
    // Native owns the authoritative flush scheduling (iOS Timer / Android
    // WorkManager). The JS-side interval is kept as a defensive nudge for
    // cases where native scheduling is delayed (e.g. WorkManager under
    // app standby) — it just delegates to the native flush.
    _flushTimer = setInterval(() => {
      void Analytics.flush();
    }, _config.flushIntervalMs!);

    // Kick off the native device-id fetch unless an explicit `setDeviceId`
    // already seeded a value during this process (test seam / consumer
    // override). When already seeded, keep that promise resolved.
    if (_deviceId == null && _deviceIdPromise == null) {
      loadDeviceIdFromNative();
    }

    if (_config.trackingSessionEvents) {
      Analytics.track("[SwissKnife] Session Start");
    }

    // Return the device-id promise so tests / consumers that want to await
    // initialization can. Resolves to void; the inner string is captured in
    // `_deviceId`. We swallow the result because consumers should read it via
    // `Analytics.getDeviceId()` once init resolves.
    return (_deviceIdPromise ?? Promise.resolve("")).then(() => undefined);
  },

  // MARK: Track events (Amplitude-compatible)

  track(eventType: string, eventProperties?: Record<string, unknown>) {
    if (_config?.optOut) return;
    // Fire-and-forget: build the event (await native device-id if needed),
    // then push it across the bridge. The caller does not need to `await`.
    void (async () => {
      const event = await buildEvent(eventType, eventProperties);
      sendToNativeFireAndForget(event);
    })();
  },

  // MARK: Screen tracking (Mixpanel-compatible)

  trackScreen(name: string, properties?: Record<string, unknown>) {
    Analytics.track("[SwissKnife] Screen Viewed", {
      ...properties,
      "[SwissKnife] Screen Name": name,
    });
  },

  // MARK: User identity

  setUserId(userId: string | undefined) {
    _userId = userId;
  },

  getUserId(): string | undefined {
    return _userId;
  },

  /**
   * Override the device id. Useful for tests and for consumers who want to
   * tie analytics to an external identity. Once called, the native bridge
   * value is ignored for the lifetime of this Analytics module (until
   * `reset()`).
   */
  setDeviceId(deviceId: string) {
    _deviceId = deviceId;
    _deviceIdPromise = Promise.resolve(deviceId);
  },

  /**
   * Returns the resolved device id, or `null` if the native bridge has not yet
   * resolved AND no explicit override has been set. Most callers should await
   * `init()` first.
   */
  getDeviceId(): string | null {
    return _deviceId;
  },

  getSessionId(): number {
    return _sessionId;
  },

  identify(identify: SKIdentify) {
    if (_config?.optOut) return;
    // Snapshot operations before async hop in case the caller mutates `identify`
    // (defensive — SKIdentify is a builder and re-use is unusual but possible).
    const operations = identify._getOperations();

    // Apply locally before the async hop so any subsequent track() picks up
    // the new user properties without waiting on the bridge round-trip.
    for (const op of operations) {
      if (op.op === "$set" && op.key) {
        _userProperties[op.key] = op.value;
      }
    }

    void (async () => {
      const event = await buildEvent("$identify", undefined, {
        event_type: "$identify",
        user_properties: { $set: operations },
      });
      sendToNativeFireAndForget(event);
    })();
  },

  // Super properties (Mixpanel-compatible)
  registerSuperProperties(properties: Record<string, unknown>) {
    Object.assign(_superProperties, properties);
  },

  registerSuperPropertiesOnce(properties: Record<string, unknown>) {
    for (const [k, v] of Object.entries(properties)) {
      if (!(k in _superProperties)) _superProperties[k] = v;
    }
  },

  getSuperProperties(): Record<string, unknown> {
    return { ..._superProperties };
  },

  unregisterSuperProperty(property: string) {
    delete _superProperties[property];
  },

  clearSuperProperties() {
    _superProperties = {};
  },

  // Time events (Mixpanel-compatible)
  timeEvent(eventName: string) {
    _timedEvents[eventName] = Date.now();
  },

  // Group helper (Mixpanel-compatible)
  addGroup(groupType: string, groupName: string) {
    const existing = _groups[groupType];
    if (Array.isArray(existing)) {
      if (!existing.includes(groupName)) existing.push(groupName);
    } else {
      _groups[groupType] = [groupName];
    }
  },

  reset() {
    _userId = undefined;
    // Drop both the cached id and the in-flight promise; next init() (or the
    // explicit kickoff below) will refetch from native. This matches the
    // "fresh anonymous identity" semantics callers expect from reset().
    _deviceId = null;
    _deviceIdPromise = null;
    _userProperties = {};
    _groups = {};
    _superProperties = {};
    _timedEvents = {};
    _sessionId = Date.now();
  },

  // MARK: Groups (Amplitude-compatible)

  setGroup(groupType: string, groupName: string | string[]) {
    _groups[groupType] = groupName;
  },

  groupIdentify(groupType: string, groupName: string, identify: SKIdentify) {
    if (_config?.optOut) return;
    const operations = identify._getOperations();
    void (async () => {
      const event = await buildEvent("$groupidentify", undefined, {
        event_type: "$groupidentify",
        groups: { [groupType]: groupName },
        user_properties: { $set: operations },
      });
      sendToNativeFireAndForget(event);
    })();
  },

  // MARK: Revenue (Amplitude + Mixpanel compatible)

  revenue(revenue: SKRevenue) {
    const props: Record<string, unknown> = {
      ...revenue.eventProperties,
      $productId: revenue.productId,
      $quantity: revenue.quantity,
      $price: revenue.price,
    };
    if (revenue.revenueType) props.$revenueType = revenue.revenueType;
    Analytics.track("revenue_amount", props);
  },

  // Mixpanel-compatible
  trackCharge(amount: number, properties?: Record<string, unknown>) {
    Analytics.track("revenue_amount", { ...properties, $amount: amount });
  },

  // MARK: Flush

  /**
   * Ask the native side to flush its disk-backed queue. Fire-and-forget — the
   * actual HTTP work runs natively (iOS GCD with back-off; Android
   * WorkManager). This promise resolves as soon as the flush job is scheduled.
   *
   * No-op when the bridge is not linked (we don't keep a JS-side queue any
   * more — there's nothing to send). Errors are swallowed with a single warning
   * so background flushers don't crash the host app.
   */
  async flush() {
    try {
      await getNativeModule().flushEvents();
    } catch (e) {
      console.warn(`[SwissKnife Analytics] native flushEvents() failed:`, e);
    }
  },

  // MARK: Opt out

  setOptOut(optOut: boolean) {
    if (_config) _config.optOut = optOut;
  },

  // MARK: Shutdown

  shutdown() {
    if (_flushTimer) {
      clearInterval(_flushTimer);
      _flushTimer = null;
    }
    void Analytics.flush();
  },
};
