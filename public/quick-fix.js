const QUICK_FIXES = Object.freeze([
  Object.freeze({
    version: "2026-08-24-ort-jsdelivr-cache-migration-v1",
    applyOnFreshInstall: true,
    async apply() {
      const targetCache = await caches.open("typed-voice-onnxruntime-web-1.27.0");
      const legacyBaseUrl = new URL(self.registration.scope);
      const cdnBaseUrl = "https://cdn.jsdelivr.net/npm/onnxruntime-web@1.27.0/dist/";
      for (const name of [
        "ort-wasm-simd-threaded.jsep.mjs",
        "ort-wasm-simd-threaded.jsep.wasm",
      ]) {
        const targetUrl = `${cdnBaseUrl}${name}`;
        if (await targetCache.match(targetUrl)) continue;
        const legacyResponse = await caches.match(new URL(name, legacyBaseUrl).href);
        if (!legacyResponse) continue;
        await targetCache.put(targetUrl, legacyResponse.clone());
      }
    },
  }),
]);
self.__typedVoiceQuickFixVersions = Object.freeze(QUICK_FIXES.map(({ version }) => version));

self.__typedVoiceQuickFixInstall = async () => {
  for (const fix of QUICK_FIXES) {
    if (!fix.applyOnFreshInstall) continue;
    await fix.apply();
  }
};

self.__typedVoiceQuickFixActivate = async (knownVersions = []) => {
  for (const fix of QUICK_FIXES) {
    if (knownVersions.includes(fix.version)) continue;
    await fix.apply();
    knownVersions.push(fix.version);
  }
};
