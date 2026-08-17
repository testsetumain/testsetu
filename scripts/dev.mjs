import { spawn } from "node:child_process";

const children = [
  spawn(process.execPath, ["--watch", "server/index.mjs"], { stdio: "inherit", shell: true }),
  spawn("npm", ["run", "client"], { stdio: "inherit", shell: true })
];

const shutdown = () => {
  for (const child of children) child.kill();
  process.exit(0);
};

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

for (const child of children) {
  child.on("exit", (code) => {
    if (code && code !== 0) shutdown();
  });
}
