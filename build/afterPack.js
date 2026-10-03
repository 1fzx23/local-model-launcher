/**
 * afterPack hook: strip files the launcher never uses.
 *
 * The app is a pure UI shell (model list / downloader / llama-server launcher) —
 * it never shows a browser's own about/license page and never falls back to the
 * Vulkan software rasteriser, so those payloads are dead weight.
 *
 * Kept intentionally:
 *   ffmpeg.dll   - Electron loads it during browser-process startup even with no
 *                  <video>/<audio> in the UI. Deleting it yields a process with
 *                  no window and no error. Verified on 1.1.2-slim: keep it.
 *   icudtl.dat, resources.pak, chrome_*.pak - text/UI rendering, Chinese needs
 *                  icudtl.dat or you get tofu boxes.
 *   libEGL/libGLESv2 - GPU rasterisation for normal page compositing.
 */
exports.default = async function afterPack(context) {
  const fs = require('fs');
  const path = require('path');

  const outDir = context.appOutDir;

  const targets = [
    'vk_swiftshader.dll',            // 6 MB - Vulkan software rasteriser fallback
    'vk_swiftshader_icd.json',
    'LICENSES.chromium.html',        // 9 MB - not shown anywhere in the app
    'LICENSE.electron.txt',
  ];

  let freed = 0;
  for (const rel of targets) {
    const p = path.join(outDir, rel);
    try {
      if (fs.existsSync(p)) {
        freed += fs.statSync(p).size;
        fs.rmSync(p, { force: true });
        console.log(`  [slim] removed ${rel}`);
      }
    } catch (e) {
      console.warn(`  [slim] could not remove ${rel}: ${e.message}`);
    }
  }

  // Drop the unused locale packs; electronLanguages already trims them, this
  // catches anything the builder copied before the filter applied.
  const localesDir = path.join(outDir, 'locales');
  const keep = new Set(['zh-CN.pak', 'en-US.pak']);
  try {
    if (fs.existsSync(localesDir)) {
      for (const f of fs.readdirSync(localesDir)) {
        if (!f.endsWith('.pak') || keep.has(f)) continue;
        const p = path.join(localesDir, f);
        try { freed += fs.statSync(p).size; fs.rmSync(p, { force: true }); } catch { }
      }
    }
  } catch { }

  console.log(`  [slim] freed ${(freed / 1048576).toFixed(1)} MB`);
};
