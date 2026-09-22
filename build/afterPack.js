const { execSync } = require("child_process");
const path = require("path");

// Sign a single path, ignoring "not an Mach-O" errors for non-binary files.
function sign(target) {
  try {
    execSync(`codesign --force --sign - "${target}"`, { stdio: "pipe" });
  } catch (e) {
    // Ignore files that aren't signable (scripts, plists, etc.)
    const msg = (e.stderr || e.stdout || "").toString();
    if (
      !msg.includes("is not an Mach-O file") &&
      !msg.includes("bundle format unrecognized")
    ) {
      throw e;
    }
  }
}

exports.default = async function afterPack(context) {
  if (context.electronPlatformName !== "darwin") return;

  const appPath = path.join(
    context.appOutDir,
    `${context.packager.appInfo.productFilename}.app`,
  );

  console.log(`Ad-hoc re-signing (inside-out): ${appPath}`);

  // Step 1: sign every Mach-O leaf (deepest first) — dylibs, but also the
  // plain executables and native addons that are not dylibs: the framework's
  // Helpers/chrome_crashpad_handler, Squirrel's ShipIt, and the .node addons
  // under app.asar.unpacked. An unsigned leaf makes the enclosing framework's
  // signature fail ("code object is not signed at all / In subcomponent:
  // …/Helpers/chrome_crashpad_handler", measured 2026-09-22), and Apple
  // Silicon refuses to load unsigned native code at all.
  execSync(
    `find "${appPath}/Contents/Frameworks" "${appPath}/Contents/Resources" -type f \\( -name "*.dylib" -o -name "*.so" -o -name "*.node" -o -perm -u+x \\) -print0 | xargs -0 -n1 codesign --force --sign - 2>&1 | grep -v -e "is not a Mach-O file" -e "bundle format unrecognized" -e "^$" || true`,
    { stdio: "inherit", shell: "/bin/bash" },
  );

  // Step 2: sign XPC services and nested .app bundles inside Frameworks
  execSync(
    `find "${appPath}/Contents/Frameworks" -mindepth 1 -maxdepth 4 \\( -name "*.xpc" -o -name "*.app" \\) -prune | while IFS= read -r f; do codesign --force --sign - "$f" 2>/dev/null || true; done`,
    { stdio: "inherit", shell: "/bin/bash" },
  );

  // Step 3: sign each .framework (the versioned bundle, not through symlinks)
  // A framework that fails to sign must fail the build here, not surface
  // later as an outer-app signing error with the cause discarded.
  execSync(
    `find "${appPath}/Contents/Frameworks" -mindepth 1 -maxdepth 1 -name "*.framework" -print0 | xargs -0 -n1 codesign --force --sign -`,
    { stdio: "inherit", shell: "/bin/bash" },
  );

  // Step 4: sign the outer .app
  execSync(`codesign --force --sign - "${appPath}"`, { stdio: "inherit" });

  console.log("Ad-hoc re-signing complete.");
};
