// samples/maestro-app/App.tsx
//
// REAL E2E test for the swiss-knife React Native SDK.
//
// Every button on this screen calls the public SDK API — Analytics.track /
// .identify / .revenue / .flush, CrashReporting.captureException /
// .captureMessage / .flush / .captureUserFeedback, and
// Performance.startTransaction / .finish. CrashReporting and Performance are
// the REAL SDK sources (deep imports into packages/react-native-sdk via
// ./src/swiss-knife/index.ts); only Analytics is a sample-local wrapper.
//
// The Analytics module talks to a native module by design; this app provides
// a JS-side shim for that bridge (./src/swiss-knife/native-shim.ts) that
// POSTs the SDK-built event payloads to /api/sdk/events/batch. Everything
// above the shim — event_id generation, identify merging, revenue helpers,
// session id — is the actual SDK code.
//
// CrashReporting and Performance already use fetch() internally, so they
// require no shim and exercise the SDK end-to-end against the real backend.

import { useEffect, useState, useRef } from "react";
import {
  View,
  Text,
  TouchableOpacity,
  ScrollView,
  StyleSheet,
  Platform,
  LogBox,
  NativeModules,
} from "react-native";
import { StatusBar } from "expo-status-bar";

// Hide RN dev warning toasts — they intercept Maestro's view hierarchy and
// pop up over the test buttons.
LogBox.ignoreAllLogs(true);

import {
  Analytics,
  CrashReporting,
  Performance,
  SKIdentify,
  SKRevenue,
  configureNativeShim,
  setUserIdForShim,
} from "./src/swiss-knife";
// Parity flows talk to the backend identity / purchases / attributes
// surfaces directly via the shim (which is what the SDK's Purchases
// module also resolves to in this bare Expo build).
import {
  getNativeModule,
  getShimQueueDepth,
} from "./src/swiss-knife/native-shim";
import {
  applyDiagResult,
  initialDiagState,
  runDiagOp,
  type DiagResult,
} from "./src/diagnostics";
// samples/fixtures of the defaults, shared
// with the native samples' fixtures.swift / fixtures.kt bindings.
import {
  API_KEY as DEFAULT_API_KEY,
  SERVER_URL as DEFAULT_SERVER_URL,
} from "./src/fixtures";

// SERVER_URL → EXPO_PUBLIC_API_URL (inlined by Metro at bundle time) → here.
// Point EXPO_PUBLIC_API_URL at a fault-injecting proxy and every SDK call in
// this app follows it; the value in use is rendered in the diagnostics panel.
const API_URL = process.env.EXPO_PUBLIC_API_URL ?? DEFAULT_SERVER_URL;
const API_URL_SOURCE = process.env.EXPO_PUBLIC_API_URL
  ? "env"
  : "fixture-default";
const API_KEY = process.env.EXPO_PUBLIC_API_KEY ?? DEFAULT_API_KEY;

// Unique per launch so each test run is independent and easy to grep in DB.
const RUN_ID = Math.random().toString(36).slice(2, 10);
const ANON_ID = `maestro_anon_${RUN_ID}`;
const USER_ID = `maestro_user_${RUN_ID}`;

type ButtonProps = { id: string; label: string; onPress: () => void };

// Module scope so a re-render updates the text in place instead of remounting
// the native view — Maestro reads the view hierarchy while these change.
const DiagLine = ({ id, text }: { id: string; text: string }) => (
  <Text testID={id} accessibilityLabel={text} style={styles.diagLine} numberOfLines={1}>
    {text}
  </Text>
);

const DiagBtn = ({ id, label, onPress }: ButtonProps) => (
  <TouchableOpacity
    testID={id}
    accessibilityLabel={id}
    style={styles.diagButton}
    onPress={onPress}
  >
    <Text style={styles.buttonText}>{label}</Text>
  </TouchableOpacity>
);

export default function App() {
  const [log, setLog] = useState<string[]>([]);
  const [lastEventId, setLastEventId] = useState<string | null>(null);
  const [diag, setDiag] = useState(initialDiagState);
  const [queueDepth, setQueueDepth] = useState(0);
  const scrollRef = useRef<ScrollView>(null);

  const addLog = (msg: string) =>
    setLog((prev) => [
      `${new Date().toLocaleTimeString("en-US", { hour12: false })} ${msg}`,
      ...prev,
    ]);

  useEffect(() => {
    // Wire up the JS-side native-module shim so Analytics has somewhere to
    // hand its events to. The shim translates SKEvent payloads to the
    // backend's /api/sdk/events/batch shape on flush.
    configureNativeShim({
      apiKey: API_KEY,
      serverURL: API_URL,
      anonymousId: ANON_ID,
    });

    // Initialize the SDK modules. Each call exercises the public SDK init.
    void Analytics.init({
      apiKey: API_KEY,
      serverURL: API_URL,
      flushQueueSize: 1,
      flushIntervalMs: 60_000,
      // Disable session-start auto-track to keep `events` table easy to grep.
      trackingSessionEvents: false,
    });

    CrashReporting.init({
      apiKey: API_KEY,
      serverURL: API_URL,
      environment: "maestro",
      release: "1.0.0-maestro",
      enableAutoBreadcrumbs: false,
      // Wave-2 C2: capture a masked screenshot via the native bridge on
      // captureException/fatal and upload it as an event attachment after
      // the event flush. Skips silently when the native module doesn't
      // implement captureScreenshot yet.
      attachScreenshot: true,
    });

    Performance.init({
      apiKey: API_KEY,
      serverURL: API_URL,
      environment: "maestro",
      release: "1.0.0-maestro",
      enableAutoHTTP: false,
    });

    addLog(`SDK initialized (run_id=${RUN_ID})`);
  }, []);

  // ── 1. Track Event ────────────────────────────────────────────────────
  const trackEvent = async () => {
    try {
      Analytics.track("maestro_button_pressed", {
        source: "e2e_test",
        run_id: RUN_ID,
      });
      // Give the fire-and-forget call a tick to hand off to the shim.
      await new Promise((r) => setTimeout(r, 50));
      await Analytics.flush();
      addLog(`Track Event: flushed (run_id=${RUN_ID})`);
    } catch (e) {
      addLog(`Track Event Error: ${e}`);
    }
  };

  // ── 2. Identify User ──────────────────────────────────────────────────
  const identifyUser = async () => {
    try {
      Analytics.setUserId(USER_ID);
      setUserIdForShim(USER_ID);
      const id = new SKIdentify();
      id.set("plan", "premium");
      id.set("signup_source", "maestro");
      id.set("run_id", RUN_ID);
      id.setOnce("first_seen", Date.now());
      Analytics.identify(id);
      await new Promise((r) => setTimeout(r, 50));
      await Analytics.flush();
      addLog(`Identify: flushed user=${USER_ID}`);
    } catch (e) {
      addLog(`Identify Error: ${e}`);
    }
  };

  // ── 3. Track Revenue ──────────────────────────────────────────────────
  const trackRevenue = async () => {
    try {
      const rev = new SKRevenue();
      rev.productId = "maestro_premium_monthly";
      rev.price = 9.99;
      rev.quantity = 1;
      rev.eventProperties = { run_id: RUN_ID };
      Analytics.revenue(rev);
      await new Promise((r) => setTimeout(r, 50));
      await Analytics.flush();
      addLog(`Revenue: flushed price=9.99`);
    } catch (e) {
      addLog(`Revenue Error: ${e}`);
    }
  };

  // ── 4. Capture Error ──────────────────────────────────────────────────
  const captureError = async () => {
    try {
      // Auto-breadcrumbs are off in this app (they'd wrap the shim's own API
      // calls) — add a manual one so the breadcrumb pipeline is exercised.
      CrashReporting.addBreadcrumb({
        category: "ui.tap",
        message: `maestro tapped btn-capture-error run_id=${RUN_ID}`,
        level: "info",
      });
      try {
        throw new Error(`Maestro E2E test error - run_id=${RUN_ID}`);
      } catch (e) {
        const result = CrashReporting.captureException(e as Error, {
          tags: { source: "maestro_e2e", run_id: RUN_ID },
        });
        setLastEventId(result.eventId);
      }
      await CrashReporting.flush();
      addLog(`Error: captured + flushed`);
    } catch (e) {
      addLog(`Error capture failed: ${e}`);
    }
  };

  // ── 4b. Capture Error with Screenshot ─────────────────────────────────
  // Exercises the wave-2 attachScreenshot path end-to-end: captureException
  // → native SKCrashReporting.captureScreenshot() → multipart POST to
  // /api/sdk/errors/attachments once the event flush succeeds. The e2e
  // harness asserts an error_event_attachment row landed for the project.
  const captureErrorWithScreenshot = async () => {
    try {
      const result = CrashReporting.captureException(
        new Error(`Maestro screenshot error - run_id=${RUN_ID}`),
        { tags: { source: "maestro_e2e_screenshot", run_id: RUN_ID } }
      );
      setLastEventId(result.eventId);
      await CrashReporting.flush();
      // The attachment uploads fire-and-forget AFTER the flush — give the
      // capture + upload a beat before logging success.
      await new Promise((r) => setTimeout(r, 500));
      addLog(
        `ErrorWithScreenshot: flushed event=${result.eventId.slice(0, 8)}`
      );
    } catch (e) {
      addLog(`ErrorWithScreenshot failed: ${e}`);
    }
  };

  // ── 5. Capture Message ────────────────────────────────────────────────
  const captureMessage = async () => {
    try {
      CrashReporting.captureMessage(
        `Maestro test warning message run_id=${RUN_ID}`,
        "warning"
      );
      await CrashReporting.flush();
      addLog(`Message: captured + flushed`);
    } catch (e) {
      addLog(`Message Error: ${e}`);
    }
  };

  // ── 6. Start Transaction ──────────────────────────────────────────────
  const startTransaction = async () => {
    try {
      const tx = Performance.startTransaction(
        `Maestro E2E Transaction ${RUN_ID}`,
        "test.maestro"
      );
      tx.setTag("run_id", RUN_ID);
      const span = tx.startChild("test.span", "Child span from maestro");
      await new Promise((r) => setTimeout(r, 100));
      span.finish("ok");
      tx.finish("ok");
      // tx.finish sends asynchronously; give it a tick.
      await new Promise((r) => setTimeout(r, 200));
      addLog(`Transaction: finished name=${tx.name}`);
    } catch (e) {
      addLog(`Transaction Error: ${e}`);
    }
  };

  // ── 7. Show Session ───────────────────────────────────────────────────
  const showSession = async () => {
    try {
      const sessionId = Analytics.getSessionId();
      addLog(`Session: id=${sessionId} ts=${new Date(sessionId).toISOString()}`);
    } catch (e) {
      addLog(`Session Error: ${e}`);
    }
  };

  // ── 8a. Fatal Error (uncaught) ────────────────────────────────────────
  // Throws OUTSIDE any handler so ErrorUtils' global handler fires with
  // isFatal=true — exercising the SDK's crashed-session marking and (with
  // persistence) next-launch delivery. The e2e flow relaunches the app after
  // tapping this, then asserts the error_issue + crashed session landed.
  const fatalError = () => {
    addLog(`Fatal: throwing uncaught error in 500ms…`);
    setTimeout(() => {
      throw new Error(`Maestro fatal error - run_id=${RUN_ID}`);
    }, 500);
  };

  // ── 8b. Unhandled Promise Rejection ───────────────────────────────────
  // Rejects without a catch handler so the SDK's promise-rejection tracking
  // (not try/catch, not captureException) has to pick it up.
  const unhandledRejection = () => {
    addLog(`Rejection: firing unhandled Promise.reject…`);
    Promise.reject(
      new Error(`Maestro unhandled rejection - run_id=${RUN_ID}`)
    );
  };

  // ── 8c. Native crash (SIGABRT) ────────────────────────────────────────
  // Kills the process below JS — exercises the native signal handler,
  // pending-crash persistence, and next-launch delivery of both the crash
  // event and the crashed session.
  const nativeCrash = () => {
    addLog(`Native: calling SKCrashReporting.crashNative() in 500ms…`);
    setTimeout(() => {
      NativeModules.SKCrashReporting?.crashNative();
    }, 500);
  };

  // ── 8. Send Feedback ──────────────────────────────────────────────────
  const sendFeedback = async () => {
    try {
      // Always create a fresh anchor event so the feedback has a real
      // eventId to attach to. (React state is async — we can't rely on
      // `lastEventId` being populated from earlier taps in the same flow.)
      const r = CrashReporting.captureException(
        new Error(`feedback anchor run_id=${RUN_ID}`)
      );
      await CrashReporting.flush();
      // captureUserFeedback returns void but fires fetch synchronously.
      await CrashReporting.captureUserFeedback({
        eventId: r.eventId,
        name: "Maestro Tester",
        email: "maestro@test.com",
        comments: `Automated feedback from E2E test run_id=${RUN_ID}`,
      });
      // Give the underlying fetch a tick to complete.
      await new Promise((res) => setTimeout(res, 300));
      addLog(`Feedback: sent for event=${r.eventId.slice(0, 8)}`);
    } catch (e) {
      addLog(`Feedback Error: ${e}`);
    }
  };

  // ── Parity: Purchases ─────────────────────────────────────────────────
  const purchaseMonthly = async () => {
    try {
      await getNativeModule().purchasePackage("com.swissknife.test.monthly", "");
      addLog(`OK: PurchaseMonthly`);
    } catch (e) {
      addLog(`ERR: PurchaseMonthly -> ${e}`);
    }
  };
  const purchaseYearlyTrial = async () => {
    try {
      await getNativeModule().purchasePackage("com.swissknife.test.yearly", "");
      addLog(`OK: PurchaseYearlyTrial`);
    } catch (e) {
      addLog(`ERR: PurchaseYearlyTrial -> ${e}`);
    }
  };
  const restorePurchases = async () => {
    try {
      await getNativeModule().restorePurchases();
      addLog(`OK: Restore`);
    } catch (e) {
      addLog(`ERR: Restore -> ${e}`);
    }
  };
  const getEntitlements = async () => {
    try {
      const info = await getNativeModule().getCustomerInfo();
      addLog(`OK: Entitlements ${JSON.stringify(info).slice(0, 60)}`);
    } catch (e) {
      addLog(`ERR: Entitlements -> ${e}`);
    }
  };

  // ── Parity: Offerings ─────────────────────────────────────────────────
  const fetchOfferings = async () => {
    try {
      const o = await getNativeModule().getOfferings();
      addLog(`OK: Offerings ${JSON.stringify(o).slice(0, 60)}`);
    } catch (e) {
      addLog(`ERR: Offerings -> ${e}`);
    }
  };
  const getCurrentOffering = fetchOfferings;

  // ── Parity: Identity ──────────────────────────────────────────────────
  const logIn = async () => {
    try {
      await getNativeModule().logIn(USER_ID);
      setUserIdForShim(USER_ID);
      addLog(`OK: LogIn user=${USER_ID}`);
    } catch (e) {
      addLog(`ERR: LogIn -> ${e}`);
    }
  };
  const logOut = async () => {
    try {
      await getNativeModule().logOut();
      setUserIdForShim(null);
      addLog(`OK: LogOut`);
    } catch (e) {
      addLog(`ERR: LogOut -> ${e}`);
    }
  };
  const getAppUserId = async () => {
    try {
      const uid = await getNativeModule().getAppUserID();
      addLog(`OK: AppUserID=${uid}`);
    } catch (e) {
      addLog(`ERR: AppUserID -> ${e}`);
    }
  };

  // ── Parity: Attributes ────────────────────────────────────────────────
  const setEmail = async () => {
    try {
      await getNativeModule().setEmail("maestro_rn@e2e.local");
      addLog(`OK: SetEmail`);
    } catch (e) {
      addLog(`ERR: SetEmail -> ${e}`);
    }
  };
  const setDisplayName = async () => {
    try {
      await getNativeModule().setDisplayName("Maestro RN Tester");
      addLog(`OK: SetDisplayName`);
    } catch (e) {
      addLog(`ERR: SetDisplayName -> ${e}`);
    }
  };
  const setPushToken = async () => {
    try {
      await getNativeModule().setPushToken(`maestro_rn_push_${RUN_ID}`);
      addLog(`OK: SetPushToken`);
    } catch (e) {
      addLog(`ERR: SetPushToken -> ${e}`);
    }
  };
  const setCustomAttr = async () => {
    try {
      await getNativeModule().setAttributes({ foo: "bar", run_id: RUN_ID });
      addLog(`OK: SetCustomAttr`);
    } catch (e) {
      addLog(`ERR: SetCustomAttr -> ${e}`);
    }
  };

  // ── Diagnostics ───────────────────────────────────────────────────────
  //
  // Everything a stress flow needs to assert on when the backend is
  // misbehaving. Identifiers and value tokens are mirrored verbatim in
  // samples/ios-maestro-app and samples/android-maestro-app.
  //
  // The counters only move for the four `diag-btn-*` controls below. That is
  // deliberate: they are the operations a flow drives one at a time, so the
  // counters stay a clean signal instead of picking up stray taps on the
  // parity buttons.

  const finishDiag = (result: DiagResult) => {
    setDiag((prev) => applyDiagResult(prev, result));
    setQueueDepth(getShimQueueDepth());
    addLog(`DIAG: ${result.op} ${result.status}`);
  };

  // Analytics has no delivery callback — `flush()` resolves whether or not
  // the backend accepted the batch — so this reports `dispatched`, never
  // `ok`. The shim's transport outcome is surfaced in `last_detail` so a
  // flow can still see that the POST failed.
  const diagTrackEvent = async () => {
    Analytics.track("maestro_rn_diag_event", { source: "rn_diag" });
    await new Promise((r) => setTimeout(r, 50));
    await Analytics.flush();
    finishDiag({
      op: "track_event",
      status: "dispatched",
      errorKind: "none",
      detail: "no delivery callback on Analytics.flush",
    });
  };

  /** Same fire-and-forget caveat as `diagTrackEvent`. */
  const diagIdentify = async () => {
    Analytics.setUserId(`${USER_ID}_diag`);
    setUserIdForShim(`${USER_ID}_diag`);
    const id = new SKIdentify();
    id.set("source", "rn_diag");
    Analytics.identify(id);
    await new Promise((r) => setTimeout(r, 50));
    await Analytics.flush();
    finishDiag({
      op: "identify",
      status: "dispatched",
      errorKind: "none",
      detail: "no delivery callback on Analytics.flush",
    });
  };

  const diagFetchOfferings = async () => {
    finishDiag(
      await runDiagOp("fetch_offerings", async () => {
        const offerings = await getNativeModule().getOfferings();
        return `offerings=${JSON.stringify(offerings).slice(0, 60)}`;
      })
    );
  };

  const diagFetchCustomerInfo = async () => {
    finishDiag(
      await runDiagOp("fetch_customer_info", async () => {
        const info = await getNativeModule().getCustomerInfo();
        return `customer_info=${JSON.stringify(info).slice(0, 60)}`;
      })
    );
  };

  const diagReset = () => {
    setDiag(initialDiagState);
    setQueueDepth(getShimQueueDepth());
  };

  const Btn = ({ id, label, onPress }: ButtonProps) => (
    <TouchableOpacity
      testID={id}
      accessibilityLabel={id}
      style={styles.button}
      onPress={onPress}
    >
      <Text style={styles.buttonText}>{label}</Text>
    </TouchableOpacity>
  );

  return (
    <View style={styles.container}>
      <StatusBar style="light" />
      <Text style={styles.title}>Swiss Knife SDK Real E2E</Text>
      <Text style={styles.subtitle}>run_id={RUN_ID}</Text>

      <View testID="diag-panel" style={styles.diagPanel}>
        <DiagLine id="diag-server-url" text={`server_url=${API_URL}`} />
        <DiagLine
          id="diag-server-url-source"
          text={`server_url_source=${API_URL_SOURCE}`}
        />
        <DiagLine id="diag-last-op" text={`last_op=${diag.lastOp}`} />
        <DiagLine id="diag-last-status" text={`last_status=${diag.lastStatus}`} />
        <DiagLine id="diag-last-error" text={`last_error=${diag.lastErrorKind}`} />
        <DiagLine id="diag-last-detail" text={`last_detail=${diag.lastDetail}`} />
        <DiagLine id="diag-ok-count" text={`ok_count=${diag.okCount}`} />
        <DiagLine id="diag-fail-count" text={`fail_count=${diag.failCount}`} />
        {/* Unlike iOS / Android — where every queue store is `internal` —
            this sample owns its JS event queue, so a real depth is
            renderable. It is the shim's queue, not the SDK's. */}
        <DiagLine id="diag-queue-depth" text={`queue_depth=${queueDepth}`} />
        <View style={styles.diagButtons}>
          <DiagBtn id="diag-btn-track-event" label="Diag Track" onPress={diagTrackEvent} />
          <DiagBtn id="diag-btn-identify" label="Diag Identify" onPress={diagIdentify} />
          <DiagBtn
            id="diag-btn-fetch-offerings"
            label="Diag Offerings"
            onPress={diagFetchOfferings}
          />
          <DiagBtn
            id="diag-btn-fetch-customer-info"
            label="Diag CustInfo"
            onPress={diagFetchCustomerInfo}
          />
          <DiagBtn id="diag-btn-reset" label="Diag Reset" onPress={diagReset} />
        </View>
      </View>

      <View style={styles.buttons}>
        <Btn id="btn-track-event" label="Track Event" onPress={trackEvent} />
        <Btn id="btn-identify" label="Identify User" onPress={identifyUser} />
        <Btn id="btn-revenue" label="Track Revenue" onPress={trackRevenue} />
        <Btn id="btn-capture-error" label="Capture Error" onPress={captureError} />
        <Btn
          id="btn-error-with-screenshot"
          label="Error + Screenshot"
          onPress={captureErrorWithScreenshot}
        />
        <Btn id="btn-capture-message" label="Capture Message" onPress={captureMessage} />
        <Btn id="btn-transaction" label="Start Transaction" onPress={startTransaction} />
        <Btn id="btn-session" label="Show Session" onPress={showSession} />
        <Btn id="btn-feedback" label="Send Feedback" onPress={sendFeedback} />
        <Btn id="btn-fatal-error" label="Fatal Error" onPress={fatalError} />
        <Btn
          id="btn-unhandled-rejection"
          label="Unhandled Rejection"
          onPress={unhandledRejection}
        />
        <Btn id="btn-native-crash" label="Native Crash" onPress={nativeCrash} />
        {/* Parity: Purchases */}
        <Btn id="btn-purchase-monthly" label="Purchase Monthly" onPress={purchaseMonthly} />
        <Btn id="btn-purchase-yearly-trial" label="Purchase Yearly (Trial)" onPress={purchaseYearlyTrial} />
        <Btn id="btn-restore" label="Restore Purchases" onPress={restorePurchases} />
        <Btn id="btn-customer-info" label="Get Entitlements" onPress={getEntitlements} />
        {/* Parity: Offerings */}
        <Btn id="btn-fetch-offerings" label="Fetch Offerings" onPress={fetchOfferings} />
        <Btn id="btn-get-current-offering" label="Get Current Offering" onPress={getCurrentOffering} />
        {/* Parity: Identity */}
        <Btn id="btn-login" label="Log In" onPress={logIn} />
        <Btn id="btn-logout" label="Log Out" onPress={logOut} />
        <Btn id="btn-get-app-user-id" label="Get AppUserID" onPress={getAppUserId} />
        {/* Parity: Attributes */}
        <Btn id="btn-set-email" label="Set Email" onPress={setEmail} />
        <Btn id="btn-set-display-name" label="Set Display Name" onPress={setDisplayName} />
        <Btn id="btn-set-push-token" label="Set Push Token" onPress={setPushToken} />
        <Btn id="btn-set-custom-attr" label="Set Custom Attr" onPress={setCustomAttr} />
      </View>

      <Text style={styles.subtitle}>Log ({log.length})</Text>
      <ScrollView
        style={styles.log}
        ref={scrollRef}
        testID="log-view"
      >
        {log.map((entry, i) => (
          <Text
            key={i}
            testID={`log-entry-${i}`}
            accessibilityLabel={entry}
            style={styles.logEntry}
          >
            {entry}
          </Text>
        ))}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: "#0d1117",
    paddingTop: Platform.OS === "ios" ? 60 : 40,
    paddingHorizontal: 16,
  },
  title: {
    fontSize: 22,
    fontWeight: "700",
    color: "#fff",
    marginBottom: 4,
  },
  subtitle: {
    fontSize: 12,
    color: "#8b949e",
    marginTop: 12,
    marginBottom: 6,
  },
  buttons: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 8,
  },
  button: {
    backgroundColor: "#21262d",
    borderColor: "#30363d",
    borderWidth: 1,
    paddingHorizontal: 10,
    paddingVertical: 8,
    borderRadius: 6,
    minWidth: 110,
  },
  buttonText: {
    color: "#58a6ff",
    fontSize: 12,
    fontWeight: "600",
    textAlign: "center",
  },
  diagPanel: {
    backgroundColor: "#161b22",
    borderColor: "#30363d",
    borderWidth: 1,
    borderRadius: 6,
    padding: 6,
    marginBottom: 8,
  },
  diagLine: {
    color: "#c9d1d9",
    fontFamily: Platform.OS === "ios" ? "Menlo" : "monospace",
    fontSize: 10,
    lineHeight: 13,
  },
  diagButtons: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 6,
    marginTop: 6,
  },
  diagButton: {
    backgroundColor: "#21262d",
    borderColor: "#30363d",
    borderWidth: 1,
    paddingHorizontal: 8,
    paddingVertical: 6,
    borderRadius: 6,
    minWidth: 100,
  },
  log: {
    flex: 1,
    // Guard against the log collapsing to zero height now that the
    // diagnostics panel shares the fixed-height screen with it — the parity
    // flows assert `log-entry-0` is visible.
    minHeight: 70,
    backgroundColor: "#161b22",
    borderRadius: 6,
    padding: 8,
    marginTop: 4,
  },
  logEntry: {
    color: "#c9d1d9",
    fontFamily: Platform.OS === "ios" ? "Menlo" : "monospace",
    fontSize: 11,
    marginBottom: 2,
  },
});
