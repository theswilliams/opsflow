/**
 * Deterministic normalisation used for duplicate detection. Pure and side-effect free.
 * Two records are "the same customer/address" when their normalised keys are equal — no fuzzy scoring,
 * so results are reproducible and the lookup is an indexed equality match.
 */
const LEGAL_SUFFIXES = new Set(["ltd", "limited", "ltee", "inc", "incorporated", "corp", "corporation", "co", "company", "llc", "llp", "lp", "plc", "gmbh", "sa"]);

const fold = (s: string) =>
  s
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[.'’`]/g, "")
    .replace(/&/g, " and ")
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();

/** "ABC Building Supplies, Ltd." → "abc building supplies" */
export function normalizeCustomer(name: string): string {
  let tokens = fold(name).split(" ").filter(Boolean);
  if (tokens.length > 1 && tokens[0] === "the") tokens = tokens.slice(1);
  while (tokens.length > 1 && LEGAL_SUFFIXES.has(tokens[tokens.length - 1]!)) tokens.pop();
  return tokens.join(" ");
}

const STREET_TYPES: Record<string, string> = {
  street: "st", st: "st", avenue: "ave", ave: "ave", av: "ave", road: "rd", rd: "rd", drive: "dr", dr: "dr",
  boulevard: "blvd", blvd: "blvd", lane: "ln", ln: "ln", court: "ct", ct: "ct", crescent: "cres", cres: "cres",
  place: "pl", pl: "pl", highway: "hwy", hwy: "hwy", parkway: "pkwy", pkwy: "pkwy", terrace: "ter", terr: "ter", trail: "trl", trl: "trl", way: "way",
};
const REGIONS: Record<string, string> = {
  ontario: "on", on: "on", quebec: "qc", qc: "qc", manitoba: "mb", mb: "mb", alberta: "ab", ab: "ab",
  "british columbia": "bc", bc: "bc", "nova scotia": "ns", ns: "ns", "new brunswick": "nb", nb: "nb",
};
const DIRECTIONS: Record<string, string> = { north: "n", south: "s", east: "e", west: "w", n: "n", s: "s", e: "e", w: "w" };

/** "125 King Street, London, Ontario" and "125 king st london on" share a key. */
export function normalizeAddress(address: string): string {
  let text = fold(address);
  for (const [long, short] of Object.entries(REGIONS)) if (long.includes(" ")) text = text.replaceAll(long, short);
  return text
    .split(" ")
    .filter(Boolean)
    .map((t) => STREET_TYPES[t] ?? REGIONS[t] ?? DIRECTIONS[t] ?? t)
    .join(" ");
}
