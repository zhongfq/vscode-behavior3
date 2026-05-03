const fs = require("fs");
const os = require("os");
const path = require("path");
const esbuild = require("esbuild");

async function main() {
  const outfile = path.join(os.tmpdir(), `vscode-behavior3-shared-${Date.now()}.cjs`);

  try {
    await esbuild.build({
      entryPoints: [path.join(__dirname, "shared-suite.ts")],
      bundle: true,
      platform: "node",
      format: "cjs",
      target: "node18",
      outfile,
      sourcemap: false,
      logLevel: "silent",
    });

    require(outfile);
  } finally {
    if (fs.existsSync(outfile)) {
      fs.unlinkSync(outfile);
    }
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
