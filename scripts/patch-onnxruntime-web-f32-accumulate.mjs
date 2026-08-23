import { readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  EXPECTED_ORT_VERSION,
  patchOrtWebGpuF32Accumulate,
} from "../src/engine/onnxruntime-web-f32-patch.js";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const ortRoot = join(root, "node_modules", "onnxruntime-web");
const ortPackagePath = join(ortRoot, "package.json");
const targetPath = join(ortRoot, "dist", "ort.all.bundle.min.mjs");

const ortPackage = JSON.parse(await readFile(ortPackagePath, "utf8"));
if (ortPackage.version !== EXPECTED_ORT_VERSION) {
  throw new Error(
    `Refusing to patch onnxruntime-web ${ortPackage.version}; expected ${EXPECTED_ORT_VERSION}. `
      + "Review the upstream WebGPU MatMul implementation before changing this pin."
  );
}

const source = await readFile(targetPath, "utf8");
const patched = patchOrtWebGpuF32Accumulate(source);
if (patched === source) {
  console.log(`onnxruntime-web ${EXPECTED_ORT_VERSION} WebGPU FP32-accumulate patch already applied.`);
  process.exit(0);
}

await writeFile(targetPath, patched, "utf8");

console.log(
  `Patched onnxruntime-web ${EXPECTED_ORT_VERSION}: packed WebGPU MatMul now accumulates in FP32 `
    + "while retaining FP16 inputs, weights, and outputs."
);
