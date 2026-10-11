// A last check before a review reaches GitHub: text that looks like a secret. Agents read pull request content that
// can try to steer them, and their findings can be adopted into a review, so a key or token that slipped into a
// finding must not be posted by accident.

const PATTERNS: Array<[RegExp, string]> = [
  [/-----BEGIN (?:[A-Z]+ )*PRIVATE KEY-----/, "a private key"],
  [/\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{36,}\b/, "a GitHub token"],
  [/\bgithub_pat_[A-Za-z0-9_]{60,}\b/, "a GitHub token"],
  [/\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/, "an AWS access key"],
  [/\bxox[abposr]-[A-Za-z0-9-]{10,}\b/, "a Slack token"],
  [/\bsk-ant-[A-Za-z0-9_-]{20,}\b/, "an Anthropic API key"],
  [/\bsk-(?:proj-)?[A-Za-z0-9_-]{32,}\b/, "an OpenAI API key"],
  [/\bAIza[0-9A-Za-z_-]{35}\b/, "a Google API key"],
  [/\b[a-z][a-z0-9+.-]*:\/\/[^\s/:@]+:[^\s/@]{6,}@[^\s/]+/i, "a URL with a password"],
];

/** What looks like a secret in each named text: "a GitHub token in the summary". Empty when nothing does. */
export function findSecrets(texts: Array<{ where: string; text: string }>): string[] {
  const found: string[] = [];
  for (const { where, text } of texts) {
    for (const [re, what] of PATTERNS) {
      if (re.test(text)) {
        found.push(`${what} in ${where}`);
        break;
      }
    }
  }
  return found;
}
