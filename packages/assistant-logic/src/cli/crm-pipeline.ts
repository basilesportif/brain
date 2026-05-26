#!/usr/bin/env node
// @ts-nocheck
/**
 * Show business pipeline summary — count and deal value by status.
 *
 * No flags required.
 * Output: JSON summary grouped by business status.
 */
import { pipelineSummary } from "../lib/crm-store.js";

function main() {
  try {
    const summary = pipelineSummary();
    console.log(JSON.stringify({ ok: true, pipeline: summary }, null, 2));
  } catch (err) {
    console.error(JSON.stringify({ error: err.message }));
    process.exit(1);
  }
}

main();
