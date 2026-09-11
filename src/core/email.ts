// Sends the digest over SMTP, or prints it (DRY_RUN=1) so you can preview
// without configuring or hitting a mail server.

import nodemailer from "nodemailer";
import { config } from "../config.js";
import type { Mail } from "./digest.js";

export async function sendOrPrint(mail: Mail): Promise<void> {
  if (config.dryRun) {
    console.log("\n=== DRY RUN — email NOT sent ===");
    console.log("To:", config.email.to || "(unset)");
    console.log("Subject:", mail.subject);
    console.log("\n--- text body ---\n" + mail.text + "\n");
    return;
  }

  const { host, port, user, pass, to, from } = config.email;
  if (!host || !user || !pass || !to) {
    throw new Error(
      "Email not configured (need SMTP_HOST, SMTP_USER, SMTP_PASS, ALERT_TO). Run with DRY_RUN=1 to preview instead."
    );
  }

  const transport = nodemailer.createTransport({
    host,
    port,
    secure: port === 465, // implicit TLS on 465; STARTTLS otherwise
    auth: { user, pass },
  });

  const info = await transport.sendMail({
    from: from || user,
    to,
    subject: mail.subject,
    text: mail.text,
    html: mail.html,
  });
  console.log(`Email sent: ${info.messageId} -> ${to}`);
}
