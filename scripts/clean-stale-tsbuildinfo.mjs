import { existsSync, readFileSync, rmSync } from "node:fs";
import { join, relative, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const rootTsconfig = JSON.parse(readFileSync(join(root, "tsconfig.json"), "utf8"));

for (const reference of rootTsconfig.references ?? []) {
  const dir = join(root, reference.path);
  const tsconfigPath = join(dir, "tsconfig.json");
  if (!existsSync(tsconfigPath)) continue;

  const { compilerOptions } = JSON.parse(readFileSync(tsconfigPath, "utf8"));
  const outDir = compilerOptions?.outDir;
  if (!outDir) continue;

  const buildinfo = join(dir, "tsconfig.tsbuildinfo");
  if (existsSync(buildinfo) && !existsSync(join(dir, outDir))) {
    rmSync(buildinfo);
    console.log(
      `Removed stale ${relative(root, buildinfo)}: ${join(reference.path, outDir)} is missing`,
    );
  }
}
