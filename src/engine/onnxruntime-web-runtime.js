import {
  EXPECTED_ORT_VERSION,
  patchOrtWebGpuF32Accumulate,
} from "./onnxruntime-web-f32-patch.js";

export const ORT_DIST_BASE_URL = `https://cdn.jsdelivr.net/npm/onnxruntime-web@${EXPECTED_ORT_VERSION}/dist/`;
const ORT_SCRIPT_URL = `${ORT_DIST_BASE_URL}ort.min.js`;

let ortPromise = null;

export function loadOrt() {
  if (!ortPromise) ortPromise = loadOrtFromJsDelivr();
  return ortPromise;
}

async function loadOrtFromJsDelivr() {
  const response = await fetch(ORT_SCRIPT_URL);
  if (!response.ok) {
    throw new Error(`Failed to fetch onnxruntime-web ${EXPECTED_ORT_VERSION}: ${response.status}`);
  }

  const patchedSource = patchOrtWebGpuF32Accumulate(await response.text());
  const blob = new Blob([patchedSource, "\nexport default ort;\n"], { type: "text/javascript" });
  const moduleUrl = URL.createObjectURL(blob);
  try {
    const loaded = await import(/* @vite-ignore */ moduleUrl);
    const ort = loaded.default;
    if (ort?.env?.versions?.web !== EXPECTED_ORT_VERSION) {
      throw new Error(
        `Unexpected onnxruntime-web version ${ort?.env?.versions?.web ?? "unknown"}; expected ${EXPECTED_ORT_VERSION}.`
      );
    }
    return ort;
  } finally {
    URL.revokeObjectURL(moduleUrl);
  }
}
