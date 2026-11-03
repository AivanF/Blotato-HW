/**
 * Drives the whole Docker Compose stack through the pricing flow, killing the server mid-flow.
 * Run with `pnpm e2e`. Set KEEP=1 to leave the stack running afterwards.
 */
import { execFileSync } from "node:child_process";

const SERVER = "http://localhost:8080";
const PLATFORM = "http://localhost:8090";

type Sent = {
  key: string;
  action: { kind: string; text: string; recipient?: { kind: string } };
};

const compose = (...args: string[]): void => {
  execFileSync("docker", ["compose", ...args], { stdio: "inherit" });
};

/**
 * Plain `docker`, because some Compose versions also kill and restart dependencies, and a
 * restarted Postgres here has lost its data.
 */
const docker = (action: "kill" | "start", service: string): void => {
  const id = execFileSync("docker", ["compose", "ps", "-q", service], { encoding: "utf8" }).trim();
  execFileSync("docker", [action, id], { stdio: "inherit" });
};

const step = (message: string): void => console.log(`\n▶ ${message}`);

const check = (condition: boolean, message: string): void => {
  if (!condition) throw new Error(`Check failed: ${message}`);
  console.log(`  ✓ ${message}`);
};

const simulate = async (type: "comment" | "message", body: object): Promise<number> => {
  const response = await fetch(`${PLATFORM}/simulate/${type}`, {
    method: "POST",
    body: JSON.stringify({ account: "acme", ...body }),
  });
  return response.status;
};

const sent = async (): Promise<Sent[]> => (await fetch(`${PLATFORM}/sent`)).json() as Promise<Sent[]>;

const waitFor = async (what: string, ready: () => Promise<boolean>, timeoutMs = 30_000) => {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await ready().catch(() => false)) return;
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}.`);
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
};

const healthy = async (): Promise<boolean> => (await fetch(`${SERVER}/healthz`)).ok;

const query = (sql: string): string =>
  execFileSync(
    "docker",
    ["compose", "exec", "-T", "postgres", "psql", "-U", "automations", "-tAc", sql],
    { encoding: "utf8" },
  ).trim();

const main = async (): Promise<void> => {
  step("Starting the stack");
  compose("up", "-d", "--build", "--wait");

  step("Alice comments \"Pricing?\", and Bob comments off-topic");
  check((await simulate("comment", { from: "alice", fromName: "Alice", text: "Pricing?" })) === 200, "the server acknowledged Alice's comment");
  check((await simulate("comment", { id: "evt-bob", from: "bob", text: "Nice photo!" })) === 200, "the server acknowledged Bob's comment");
  await waitFor("the reply and the ask", async () => (await sent()).length >= 2);

  step("Killing the server mid-flow, before Alice answers");
  docker("kill", "server");

  step("Alice answers while the server is down");
  const answer = { id: "evt-alice-email", from: "alice", text: "sure, it's alice@example.com" };
  check((await simulate("message", answer)) === 502, "the webhook failed, so the platform must retry it");

  step("Restarting the server");
  docker("start", "server");
  await waitFor("the server to be healthy", healthy);

  step("The platform retries the webhook, twice");
  check((await simulate("message", answer)) === 200, "the retry was acknowledged");
  check((await simulate("message", answer)) === 200, "the duplicate was acknowledged");
  await waitFor("the link", async () => (await sent()).some((message) => message.action.text.includes("https://")));
  await new Promise((resolve) => setTimeout(resolve, 2_000));

  step("Checking what was sent");
  const messages = await sent();
  const byKind = (kind: string, recipient?: string) =>
    messages.filter(
      (message) => message.action.kind === kind && (recipient === undefined || message.action.recipient?.kind === recipient),
    );
  check(byKind("replyToComment").length === 1, "exactly one comment reply");
  check(byKind("sendDm", "viaComment").length === 1, "exactly one private reply, the ask");
  check(byKind("sendDm", "contact").length === 1, "exactly one follow-up DM, the link");
  check(byKind("sendDm", "contact")[0]?.action.text.includes("alice@example.com") === true, "the link DM thanks Alice by email");
  // Idempotency keys contain the trigger event's id.
  check(messages.every((message) => !message.key.includes("evt-bob")), "nothing was sent about Bob's comment");

  step("Checking the database");
  check(query("SELECT email FROM contacts WHERE contact_id = 'alice'") === "alice@example.com", "Alice's email is saved");
  check(query("SELECT nickname FROM contacts WHERE contact_id = 'alice'") === "Alice", "Alice's nickname is saved");
  check(query("SELECT state->>'outcome' FROM runs WHERE contact_id = 'alice'") === "completed", "Alice's run completed");
  check(query("SELECT count(*) FROM runs WHERE contact_id = 'bob'") === "0", "Bob's comment started no run");

  console.log("\n✅ End-to-end test passed.");
};

try {
  await main();
} catch (error) {
  console.error(`\n❌ ${error instanceof Error ? error.message : String(error)}`);
  console.error("Server logs:");
  try {
    compose("logs", "--tail", "40", "server");
  } catch {
    // The logs are only a debugging aid.
  }
  process.exitCode = 1;
} finally {
  if (process.env["KEEP"] === undefined) compose("down");
}
