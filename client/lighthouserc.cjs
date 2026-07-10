/* global module */
module.exports = {
  ci: {
    collect: {
      staticDistDir: './dist',
      isSinglePageApplication: true,
      url: ['http://localhost/'],
      numberOfRuns: 3,
      settings: {
        preset: 'desktop',
        chromeFlags: '--headless --no-sandbox --disable-gpu',
      },
    },
    assert: {
      assertions: {
        // The camera and authentication APIs are intentionally unavailable in
        // this static audit. Score the shell and assets, not backend reachability.
        'errors-in-console': 'off',
        'is-crawlable': 'off',
        'service-worker': 'off',
        'installable-manifest': 'off',
        'categories:performance': ['error', { minScore: 0.75 }],
        'categories:accessibility': ['error', { minScore: 0.9 }],
        'categories:best-practices': ['error', { minScore: 0.85 }],
        'categories:seo': ['warn', { minScore: 0.8 }],
        'total-byte-weight': ['error', { maxNumericValue: 900000 }],
        'dom-size': ['warn', { maxNumericValue: 1200 }],
      },
    },
    // Reports may contain UI copy. Keep them in CI artifacts rather than
    // publishing them to Lighthouse's public temporary storage.
    upload: { target: 'filesystem', outputDir: './.lighthouseci/reports' },
  },
}
