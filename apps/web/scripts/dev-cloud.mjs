// `npm run dev:web:cloud [deckastra|deckastra-prod]`: the web app against a
// hosted Deckastra, without relying on each shell's way of setting a variable.
// Port 3000, because that is the origin the hosted API accepts.
import { spawn } from "node:child_process";

const cloud = process.argv[2] ?? "deckastra";
const child = spawn("npx", ["next", "dev", "-p", "3000"], {
  stdio: "inherit",
  shell: true,
  env: { ...process.env, NEXT_PUBLIC_DECKASTRA_CLOUD: cloud },
});
child.on("exit", (code) => process.exit(code ?? 0));
