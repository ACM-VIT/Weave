const { withAppBuildGradle } = require('expo/config-plugins');

// android/ is generated and ignored. Keep release signing policy in source so
// rebuilding the native project cannot restore Expo's debug-signing fallback.
module.exports = function withAndroidReleaseSigning(config) {
  return withAppBuildGradle(config, result => {
    if (result.modResults.language !== 'groovy') {
      throw new Error('Weave release signing requires the Groovy Android build template.');
    }
    const statement = 'apply from: new File(rootProject.projectDir.parentFile, "scripts/android-release-signing.gradle")';
    if (!result.modResults.contents.includes(statement)) {
      result.modResults.contents += `\n// Weave release signing policy\n${statement}\n`;
    }
    return result;
  });
};
