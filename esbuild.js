const esbuild = require("esbuild");
const isWatch = process.argv.includes("--watch");
const isDev = isWatch || process.argv.includes("--dev");
const isCliOnly = process.argv.includes("--cli");

const sharedOptions = {
  bundle: true,
  format: "cjs",
  platform: "node",
  target: "node18",
  sourcemap: isDev,
  minify: false,
};

const targets = [
  {
    entryPoints: ["src/extension.ts"],
    outfile: "dist/extension.js",
    external: ["vscode"],
  },
  {
    entryPoints: ["src/build/build-cli.ts"],
    outfile: "dist/build-cli.js",
    banner: {
      js: "#!/usr/bin/env node",
    },
  },
];
const selectedTargets = isCliOnly
  ? targets.filter((target) => target.outfile === "dist/build-cli.js")
  : targets;

if (isWatch) {
  Promise.all(
    selectedTargets.map((target) => esbuild.context({ ...sharedOptions, ...target }))
  ).then((contexts) => {
    return Promise.all(contexts.map((ctx) => ctx.watch())).then(() => {
      console.log("[esbuild] watching...");
    });
  });
} else {
  Promise.all(
    selectedTargets.map((target) => esbuild.build({ ...sharedOptions, ...target }))
  ).then(() => {
    console.log(
      `[esbuild] built ${selectedTargets.map((target) => target.outfile).join(", ")}`
    );
  });
}
