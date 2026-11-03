import { createServer } from "node:http";
import { createFakePlatform } from "./app.ts";

const required = (name: string): string => {
  const value = process.env[name];
  if (value === undefined || value === "") throw new Error(`${name} must be set.`);
  return value;
};

const platform = createFakePlatform({
  serverUrl: required("SERVER_URL"),
  secret: required("WEBHOOK_SECRET"),
});
const port = Number(process.env["PORT"] ?? 8090);
const server = createServer((request, response) => void platform.handle(request, response));

server.listen(port, () => console.log(JSON.stringify({ level: "info", message: "Fake platform listening.", port })));
for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.once(signal, () => server.close(() => process.exit(0)));
}
