// Verifies ONLY the SMTP login — no email is sent, no data is fetched. Reads the
// SMTP_* vars from .env (locally) or the environment. Run: npm run verify:smtp
import nodemailer from "nodemailer";
import { config } from "../src/config.js";

const { host, port, user, pass } = config.email;
console.log(`Host : ${host || "(unset)"}:${port}`);
console.log(`User : ${user || "(unset)"}`);
console.log(`Pass : ${pass ? `${pass.length} chars` : "(unset)"}`);
if (pass && /\s/.test(pass)) {
  console.log("WARNING: password contains spaces. Gmail App Passwords must be stored with NO spaces.");
}

if (!host || !user || !pass) {
  console.error("\nMissing SMTP_HOST / SMTP_USER / SMTP_PASS. Put them in .env or the environment.");
  process.exit(1);
}

const transport = nodemailer.createTransport({
  host,
  port,
  secure: port === 465,
  auth: { user, pass },
});

try {
  await transport.verify();
  console.log("\nSMTP login OK — the server accepted these credentials.");
} catch (err) {
  console.error("\nSMTP login FAILED:", (err as Error).message);
  process.exit(1);
}
