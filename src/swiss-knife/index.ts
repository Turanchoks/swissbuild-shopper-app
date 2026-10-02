// samples/maestro-app/src/swiss-knife/index.ts
//
// Module surface for the maestro sample app. The only sample-local wrapper
// left is analytics.ts, which imports getNativeModule from ./native-shim
// instead of ../native/module (the TurboModule isn't compiled into the bare
// Expo project).
//
// CrashReporting and Performance are re-exported straight from the SDK
// sources — the E2E flows exercise the SHIPPED SDK code, not a fork. Using a
// deep import (../../../../packages/.../modules/*) instead of the package
// root keeps tsc from traversing the SDK's native bridge file, which has
// typing incompatible with the Expo 56 react-native types here. Metro
// resolves these fine: Expo's metro-config auto-detects the pnpm monorepo
// and watches the workspace root.

export { Analytics, SKIdentify, SKRevenue } from "./analytics";
export type { SKAnalyticsConfig, SKEvent } from "./analytics";

// Direct deep imports into the real SDK — see header comment.
export {
  CrashReporting,
  SKErrorBoundary,
  parseStackTrace,
} from "@app-swiss-knife/react-native-sdk/modules/crash-reporting";
export type {
  CrashReportingConfig,
  SKCrashEvent,
  SKCrashBreadcrumb,
  SKCrashUser,
} from "@app-swiss-knife/react-native-sdk/modules/crash-reporting";

export { Performance } from "@app-swiss-knife/react-native-sdk/modules/performance";
export type {
  PerformanceConfig,
  SKTransaction,
  SKSpan,
} from "@app-swiss-knife/react-native-sdk/modules/performance";

export { configureNativeShim, setUserIdForShim } from "./native-shim";
