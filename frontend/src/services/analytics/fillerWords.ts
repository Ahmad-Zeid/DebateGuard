const FILLER_WORDS = new Set([
  "um",
  "uh",
  "erm",
  "hmm",
  "like",
  "you know",
  "i mean",
  "sort of",
  "kind of",
  "basically",
  "actually",
  "literally",
]);

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z\s']/g, " ")
    .split(/\s+/)
    .filter(Boolean);
}

export function countWords(text: string): number {
  return tokenize(text).length;
}

export function countFillerWords(text: string): number {
  const lower = text.toLowerCase();
  const tokens = tokenize(text);

  let count = 0;
  for (const token of tokens) {
    if (FILLER_WORDS.has(token)) {
      count += 1;
    }
  }

  // Multi-word fillers are counted once per occurrence in addition to token-level checks.
  const multiWordPatterns = ["you know", "i mean", "sort of", "kind of"];
  for (const phrase of multiWordPatterns) {
    const matches = lower.match(new RegExp(`\\b${phrase}\\b`, "g"));
    if (matches) {
      count += matches.length;
    }
  }

  return count;
}

export function fillerWordDensity(text: string): number {
  const wordCount = countWords(text);
  if (wordCount === 0) {
    return 0;
  }

  return countFillerWords(text) / wordCount;
}
