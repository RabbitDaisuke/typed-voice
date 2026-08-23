import { cp, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const destination = join(root, "public");

await mkdir(destination, { recursive: true });
await Promise.all([
  cp(join(root, "LICENSE"), join(destination, "LICENSE.txt")),
  cp(join(root, "NOTICE"), join(destination, "NOTICE.txt")),
  cp(join(root, "THIRD_PARTY_NOTICES.md"), join(destination, "THIRD_PARTY_NOTICES.md")),
  mkdir(join(destination, "licenses"), { recursive: true }).then(() =>
    cp(join(root, "licenses"), join(destination, "licenses"), { recursive: true })
  ),
  mkdir(join(destination, "licenses"), { recursive: true }).then(() =>
    cp(join(root, "third_party", "kanalizer", "LICENSE"), join(destination, "licenses", "VOICEVOX-KANALIZER-LICENSE.txt"))
  ),
]);

console.log("Copied legal notices.");
