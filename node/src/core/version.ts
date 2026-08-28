// The version this SDK reports to the heal API. tests/version.test.ts keeps it
// equal to package.json, so a release bump that misses one of the two fails CI
// instead of shipping a User-Agent that lies about which client is calling.
export const VERSION = '0.3.2';
