// Node ESM 로더 훅 — 프로젝트가 쓰는 확장자 없는 상대 import(`../api/collect`)를
// `.ts` / `.tsx` 로 해석해 준다. 단위 검증 스크립트 실행 전용.
import { existsSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, resolve as resolvePath } from "node:path";

export async function resolve(specifier, context, next) {
  if ((specifier.startsWith("./") || specifier.startsWith("../")) &&
      !/\.[mc]?[jt]sx?$/.test(specifier) && !/\.json$/.test(specifier)) {
    const base = context.parentURL ? dirname(fileURLToPath(context.parentURL)) : process.cwd();
    for (const ext of [".ts", ".tsx", "/index.ts", "/index.tsx", ".js"]) {
      const cand = resolvePath(base, specifier + ext);
      if (existsSync(cand)) {
        return next(pathToFileURL(cand).href, context);
      }
    }
  }
  return next(specifier, context);
}
