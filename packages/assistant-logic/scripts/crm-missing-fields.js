#!/usr/bin/env node
/**
 * List contacts with missing key fields (email, phone, company, title).
 *
 * No flags required.
 * Output: JSON list of people and which fields are missing.
 */
const { contactsWithMissingFields } = require("./lib/crm-store");

function main() {
  try {
    const contacts = contactsWithMissingFields();
    console.log(JSON.stringify({ ok: true, count: contacts.length, contacts }, null, 2));
  } catch (err) {
    console.error(JSON.stringify({ error: err.message }));
    process.exit(1);
  }
}

main();
