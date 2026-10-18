import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig } from "./config.js";
import { CharacterEngine } from "./engine.js";
import { DiscordGatewayError, startDiscord } from "./discord.js";

export async function startCli(args: string[] = process.argv.slice(2)): Promise<void> {
  if (args.length !== 1 || !args[0]) {
    throw new Error("Usage: mars-characters <config.yaml>");
  }
  const config = await loadConfig(args[0]);
  const engine = new CharacterEngine(config);
  const gateway = await startDiscord(config, engine, {
    onError: (error) => { console.error(`${error.code}: ${error.message}`); },
  });
  let stopping = false;
  const stop = () => {
    if (stopping) return;
    stopping = true;
    engine.close();
    process.off("SIGINT", stop);
    process.off("SIGTERM", stop);
    void gateway.close().catch(() => {
      console.error("Discord shutdown failed");
      process.exitCode = 1;
    });
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  void startCli().catch((error: unknown) => {
    // Config parser and SDK errors can contain private paths, YAML values, and credential URLs.
    const message = error instanceof DiscordGatewayError ? error.message
      : process.argv.length !== 3 ? "Usage: mars-characters <config.yaml>"
      : "Character gateway startup failed; check local configuration";
    console.error(message);
    process.exitCode = 1;
  });
}
