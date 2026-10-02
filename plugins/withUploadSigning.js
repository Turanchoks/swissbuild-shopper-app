/**
 * Expo config plugin: wire a Google Play *upload* signing config into the
 * generated `android/app/build.gradle`.
 *
 * The `android/` folder is produced by `expo prebuild` and is gitignored, so
 * the signing wiring cannot live in a committed `build.gradle`. This plugin
 * re-applies it on every prebuild, keeping the (secret-free) wiring in version
 * control while the keystore + passwords stay OUTSIDE the repo.
 *
 * Credentials are read from Gradle properties at build time — NONE are
 * hardcoded here:
 *
 *   SWISSBUILDTEST_UPLOAD_STORE_FILE      absolute path to the upload .jks
 *   SWISSBUILDTEST_UPLOAD_STORE_PASSWORD  keystore password
 *   SWISSBUILDTEST_UPLOAD_KEY_ALIAS       key alias
 *   SWISSBUILDTEST_UPLOAD_KEY_PASSWORD    key password
 *
 * Supply them via `~/.gradle/gradle.properties`, the `ORG_GRADLE_PROJECT_*`
 * env vars, or `-P` flags. swiss-build's `android.build` action can also inject
 * `-Pandroid.injected.signing.*` directly, which AGP honors without this
 * plugin; this config plugin is the persistent, prebuild-safe alternative.
 *
 * When the credentials are absent the release build falls back to the debug
 * signing config, so debug builds and other contributors are unaffected.
 */
// Import via `expo/config-plugins` (re-export) rather than the bare
// `@expo/config-plugins` package — the latter is a transitive dep and is not
// reliably resolvable from this directory under pnpm's strict node_modules,
// which breaks the `export:embed` JS-bundling step during a release build.
const { withAppBuildGradle } = require("expo/config-plugins");

const RELEASE_SIGNING_CONFIG = `        // Release / upload signing for Google Play. Injected by
        // plugins/withUploadSigning.js — credentials come from Gradle
        // properties (NOT committed) and reference a keystore outside the repo.
        release {
            if (project.hasProperty('SWISSBUILDTEST_UPLOAD_STORE_FILE')) {
                storeFile file(project.property('SWISSBUILDTEST_UPLOAD_STORE_FILE'))
                storePassword project.property('SWISSBUILDTEST_UPLOAD_STORE_PASSWORD')
                keyAlias project.property('SWISSBUILDTEST_UPLOAD_KEY_ALIAS')
                keyPassword project.property('SWISSBUILDTEST_UPLOAD_KEY_PASSWORD')
            }
        }
`;

/** Insert the `release { ... }` block into the `signingConfigs { ... }` stanza. */
function addReleaseSigningConfig(contents) {
  if (contents.includes("SWISSBUILDTEST_UPLOAD_STORE_FILE")) {
    return contents; // already applied
  }
  // Anchor on the end of the default `debug { ... }` signing config block.
  const anchor = /(signingConfigs\s*\{[\s\S]*?debug\s*\{[\s\S]*?\}\n)/;
  if (!anchor.test(contents)) {
    throw new Error(
      "withUploadSigning: could not locate signingConfigs.debug to anchor the release config"
    );
  }
  return contents.replace(anchor, `$1${RELEASE_SIGNING_CONFIG}`);
}

/** Point the `release` build type at the upload signing config when present. */
function pointReleaseBuildTypeAtSigningConfig(contents) {
  // Expo's default release buildType uses `signingConfig signingConfigs.debug`.
  return contents.replace(
    /(buildTypes\s*\{[\s\S]*?release\s*\{[\s\S]*?)signingConfig signingConfigs\.debug/,
    "$1signingConfig project.hasProperty('SWISSBUILDTEST_UPLOAD_STORE_FILE') ? signingConfigs.release : signingConfigs.debug"
  );
}

module.exports = function withUploadSigning(config) {
  return withAppBuildGradle(config, (cfg) => {
    if (cfg.modResults.language !== "groovy") {
      throw new Error(
        `withUploadSigning: expected groovy build.gradle, got ${cfg.modResults.language}`
      );
    }
    let contents = cfg.modResults.contents;
    contents = addReleaseSigningConfig(contents);
    contents = pointReleaseBuildTypeAtSigningConfig(contents);
    cfg.modResults.contents = contents;
    return cfg;
  });
};
