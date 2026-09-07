/**
 * Convenience: run a public tunnel to the local server so real mail clients can
 * reach the pixel. Tries `cloudflared` then `ngrok`. After it prints a URL, put
 * that URL in .env as BASE_URL and restart `npm run dev`.
 */
import { spawn } from "node:child_process";
import { config as loadEnv } from "dotenv";

loadEnv();
const port = process.env.PORT ?? "8787";

function which(cmd: string): Promise<boolean> {
  return new Promise((res) => {
    const p = spawn("which", [cmd]);
    p.on("exit", (code) => res(code === 0));
    p.on("error", () => res(false));
  });
}

async function main() {
  if (await which("cloudflared")) {
    console.log(`Starting cloudflared tunnel to http://localhost:${port} ...`);
    console.log("Copy the https://<...>.trycloudflare.com URL into .env as BASE_URL,");
    console.log("then restart `npm run dev`.\n");
    spawn("cloudflared", ["tunnel", "--url", `http://localhost:${port}`], {
      stdio: "inherit",
    });
    return;
  }
  if (await which("ngrok")) {
    console.log(`Starting ngrok tunnel to http://localhost:${port} ...`);
    spawn("ngrok", ["http", port], { stdio: "inherit" });
    return;
  }
  console.error("Neither `cloudflared` nor `ngrok` is installed.");
  console.error("  brew install cloudflared     (recommended)");
  console.error("  brew install ngrok/ngrok/ngrok");
  process.exit(1);
}

main();
