/**
 * React Native CLI / Expo autolinking config for the throwaway publish test app.
 *
 * The app's JS imports the swiss-knife SDK modules directly from source
 * (see ./src/swiss-knife/*) and does NOT need the SDK's native Android module
 * for the publish-pipeline smoke test. That native module
 * (`@app-swiss-knife/react-native-sdk` android/) depends on an unpublished AAR
 * `com.appswissknife:swiss-knife-android:0.1.0` that does not exist in any
 * Maven repo or as a Gradle project in this monorepo, so autolinking it breaks
 * `:app:bundleRelease`.
 *
 * Disabling the android platform for this dependency lets the AAB build cleanly
 * while leaving iOS and the JS layer untouched.
 */
module.exports = {
  dependencies: {
    "@app-swiss-knife/react-native-sdk": {
      platforms: {
        android: null,
      },
    },
  },
};
