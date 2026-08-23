import { autofix } from '@mnfst/autofix';

const wrappedFetch: typeof globalThis.fetch = autofix();
void wrappedFetch;
