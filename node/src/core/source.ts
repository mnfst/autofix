// Which SDK the app wrapped — classified from the SDK's own request headers.
//
// Client-claimed, analytics only, and coarse on purpose: the enum below is the
// ONLY thing derived from the caller's headers that ever leaves the process.
// Raw headers carry SDK versions, OS, retry counts — none of that travels
// (the anonymization stance extends to metadata).
//
// Fingerprints, verified against the published packages:
//   Vercel AI SDK  user-agent contains "ai-sdk/<provider>/<version>"
//                  (appended by @ai-sdk/provider-utils' withUserAgentSuffix)
//   OpenAI SDK     "OpenAI/JS <v>" ("AzureOpenAI/JS <v>" for the Azure client)
//   Anthropic SDK  "Anthropic/JS <v>"

// The three SDK values are the heal API's contract, not our vocabulary: it
// rejects anything outside them. `unknown` is ours alone and stops at
// heal-api.ts, which omits the header rather than sending it.
export type SdkSource = 'openai-sdk' | 'anthropic-sdk' | 'vercel-sdk' | 'unknown';

export function detectSource(headers: Headers): SdkSource {
  // A type is not a runtime contract at this boundary. The caller sits on the
  // fetch path holding `init.headers` — a HeadersInit that may be a plain
  // object or an array of pairs, and that engine.ts already has to cast and
  // wrap. TypeScript erases the annotation above, so an unwrapped value would
  // throw out of the wrapper on every request. Classification is analytics;
  // it never justifies a throw the caller wouldn't have had without autofix.
  if (typeof headers?.get !== 'function') return 'unknown';
  const ua = headers.get('user-agent') ?? '';
  // ai-sdk APPENDS its suffix to any existing UA, so this test must win.
  if (ua.includes('ai-sdk/')) return 'vercel-sdk';
  if (ua.includes('OpenAI/')) return 'openai-sdk';
  if (ua.includes('Anthropic/')) return 'anthropic-sdk';
  return 'unknown';
}
