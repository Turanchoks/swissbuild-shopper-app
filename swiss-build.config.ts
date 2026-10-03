export default {
  app: {
    appProjectId: "ed6d26ab-6ec7-47c2-a203-80fc7273a2c1",
    name: "SwissBuild Test",
    iosBundleId: "com.remneys.swissbuildtest",
    androidPackageName: "com.remneys.swissbuildtest",
    defaultLocale: "en-US",
  },
  paths: {
    root: ".",
    stateDir: ".swiss-build",
    artifactsDir: ".swiss-build/artifacts",
    logsDir: ".swiss-build/logs",
    metadataDir: "store",
  },
  ios: {
    enabled: true,
    builder: "xcodebuild",
    workspace: "ios/maestroapp.xcworkspace",
    scheme: "maestroapp",
    configuration: "Release",
    signing: {
      // swiss-knife provisions the certificate and profile with the stored
      // App Store Connect key (asc-api mode only fetches an existing pair,
      // whose private key a fresh build machine does not hold).
      mode: "managed",
      teamId: "LQPQQX6JP6",
      bundleId: "com.remneys.swissbuildtest",
    },
  },
  android: {
    enabled: true,
    projectDir: "android",
    gradleWrapper: "android/gradlew",
    track: "internal",
    packageName: "com.remneys.swissbuildtest",
  },
  stages: {
    internal: [
      { uses: "ios.build", with: { profile: "appstore" } },
      { uses: "android.build", with: { profile: "internal" } },
    ],
  },
};
