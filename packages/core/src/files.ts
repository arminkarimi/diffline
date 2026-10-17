// Which changed files are generated (lockfiles, minified bundles, snapshots, build output). They're folded on the
// review page and left out of the risk score's changed lines, so one list decides both.

const GENERATED = [
  /(^|\/)package-lock\.json$/, /(^|\/)npm-shrinkwrap\.json$/, /(^|\/)yarn\.lock$/, /(^|\/)pnpm-lock\.yaml$/,
  /(^|\/)Cargo\.lock$/, /(^|\/)go\.sum$/, /(^|\/)poetry\.lock$/, /(^|\/)Gemfile\.lock$/,
  /\.min\.(js|css)$/, /\.snap$/, /(^|\/)dist\//,
];

/** True for a path the review treats as generated. */
export function isGenerated(path: string): boolean {
  return GENERATED.some((re) => re.test(path));
}
