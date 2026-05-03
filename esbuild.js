const esbuild = require("esbuild");
const isWatch = process.argv.includes("--watch");
const isDev = isWatch || process.argv.includes("--dev");

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

if (isWatch) {
  Promise.all(targets.map((target) => esbuild.context({ ...sharedOptions, ...target }))).then((contexts) => {
    return Promise.all(contexts.map((ctx) => ctx.watch())).then(() => {
      console.log("[esbuild] watching...");
    });
  });
} else {
  Promise.all(targets.map((target) => esbuild.build({ ...sharedOptions, ...target }))).then(() => {
    console.log("[esbuild] built extension.js and build-cli.js");
  });
}
