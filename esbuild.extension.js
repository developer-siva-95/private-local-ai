import * as esbuild from "esbuild";
import { argv } from "node:process";

const isWatch = argv.includes("--watch");

const buildOptions = {
  entryPoints: ["src/extension/extension.ts"],
  bundle: true,
  outfile: "dist-ext/extension.cjs",
    external: [
    "vscode",
    "node:fs",
    "node:fs/promises",
    "node:path",
    "node:crypto",
    "node:dns/promises",
    "node:readline",
    "node:os",
    "node:child_process",
    "node:url",
    "node:util",
    "node:buffer",
    "node:stream",
    "node:events",
    "node:net",
    "node:http",
    "node:https",
    "node:process",
    "node:assert",
    "node:timers",
  ],
  format: "cjs",
  platform: "node",
  target: "node18",
  sourcemap: true,
  minify: false,
  tsconfig: "tsconfig.extension.json",
  logLevel: "info",
  /*
   * This banner forces the output file to be
   * treated as CommonJS even when package.json
   * has "type": "module".
   *
   * VS Code extension host requires CommonJS.
   * Without this, Node throws:
   * "module is not defined in ES module scope"
   */
  banner: {
    js: '"use strict";',
  },
};

if (isWatch) {
  const ctx = await esbuild.context(buildOptions);
  await ctx.watch();
  console.log("Watching for changes...");
} else {
  await esbuild.build(buildOptions);
  console.log("Extension built successfully.");
}