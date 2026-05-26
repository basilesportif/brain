/** Simple fuzzy match: lowercase includes check + word overlap score. */
function fuzzyScore(needle, haystack) {
  const n = needle.toLowerCase();
  const h = haystack.toLowerCase();
  if (h === n) return 1000;
  if (h.includes(n)) return 500;
  const nWords = n.split(/\s+/);
  const hWords = new Set(h.split(/\s+/));
  let score = 0;
  for (const w of nWords) {
    if (hWords.has(w)) score += 10;
    else if (h.includes(w)) score += 5;
  }
  return score;
}

module.exports = { fuzzyScore };
