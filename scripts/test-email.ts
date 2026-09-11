// Proves the email path end-to-end: builds a realistic (non-baseline) digest
// and sends it through a nodemailer Ethereal test inbox (no real credentials).
// Prints a preview URL you can open to see the rendered HTML email.
// Run: npm run test:email
import nodemailer from "nodemailer";
import { buildDigest } from "../src/core/digest.js";
import type { Opportunity, OppChange } from "../src/core/types.js";

function o(p: Partial<Opportunity>): Opportunity {
  return {
    source: "treasury-forecast",
    id: "x",
    fingerprint: "fp",
    title: "",
    agency: "Treasury",
    oppType: "New",
    url: "https://osdbu.forecast.treasury.gov/",
    fitTag: "direct-fit",
    matchedTerms: [],
    ...p,
  };
}

const newOpps: Opportunity[] = [
  o({
    source: "usaspending-predict",
    oppType: "Predicted",
    crossRef: "predicted-not-forecasted",
    title: "INFORMATION TECHNOLOGY PROGRAM MANAGEMENT SERVICES",
    bureau: "Internal Revenue Service",
    naics: "541512",
    estValue: "$44,284,003",
    popEnd: "2026-07-26",
    incumbent: "BOOZ ALLEN HAMILTON INC",
    matchedTerms: ["naics:541512"],
    fitTag: "direct-fit",
  }),
  o({
    oppType: "Recompete",
    title: "DevOps Software Development Services",
    bureau: "Alcohol and Tobacco Tax and Trade Bureau",
    naics: "541512",
    psc: "DA01",
    estValue: "> $50M to < or = $100M",
    awardQuarter: "FY 2025 Q3",
    bureauPoc: "Melissa Harbarger",
    programOfficePoc: "Mike Miller",
    matchedTerms: ["kw:software development", "naics:541512", "psc:DA01"],
  }),
  o({
    oppType: "New",
    fitTag: "adjacent",
    title: "Case Management Workflow Modernization",
    bureau: "Financial Crimes Enforcement Network",
    naics: "541519",
    estValue: "> $1M to < or = $5M",
    awardQuarter: "FY 2026 Q1",
    matchedTerms: ["kw:case management", "kw:modernization"],
  }),
  o({
    source: "acquisition-gateway",
    oppType: "Recompete",
    title: "Enterprise Network for Lifecycle Information Support and Technology (ENLIST)",
    agency: "General Services Administration",
    bureau: "FAS-Federal Acquisition Service",
    naics: "541512",
    estValue: "$250M - $499M",
    awardQuarter: "FY 2027 Q2",
    solicitationDate: "09/01/2026",
    bureauPoc: "Jane Doe",
    matchedTerms: ["naics:541512", "kw:modernization"],
    fitTag: "direct-fit",
  }),
];

const changedOpps: OppChange[] = [
  {
    opp: o({ title: "Logical Follow-On for BPA 2033H622A00005", bureau: "Bureau of the Fiscal Service" }),
    changes: [{ field: "award timing", from: "FY 2025 Q3", to: "FY 2026 Q1" }],
  },
];

const mail = buildDigest({ newOpps, changedOpps, isBaseline: false, totalTracked: 458 });

const acct = await nodemailer.createTestAccount();
const transport = nodemailer.createTransport({
  host: "smtp.ethereal.email",
  port: 587,
  auth: { user: acct.user, pass: acct.pass },
});
const info = await transport.sendMail({
  from: "Forecast Bot <bot@example.test>",
  to: "you@example.com",
  subject: mail.subject,
  text: mail.text,
  html: mail.html,
});

console.log("Subject:", mail.subject);
console.log("Sent OK, messageId:", info.messageId);
console.log("HTML bytes:", mail.html.length);
console.log("\nOpen this to view the rendered email:");
console.log(nodemailer.getTestMessageUrl(info));
