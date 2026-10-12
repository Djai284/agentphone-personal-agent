// Bring the test database up to the current migrations before a run (non-destructive; each test
// truncates the tables it uses).
import { execSync } from "node:child_process";
import { fileURLToPath } from "node:url";

export default function setup() {
  const url = process.env.TEST_DATABASE_URL;
  if (!url) throw new Error("TEST_DATABASE_URL is not set (see .env.example), and `npm run db:up` must be running.");
  execSync("npx prisma migrate deploy", {
    cwd: fileURLToPath(new URL("..", import.meta.url)),
    env: { ...process.env, DATABASE_URL: url },
    stdio: "pipe",
  });
}
