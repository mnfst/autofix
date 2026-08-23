import { autofix } from '@mnfst/autofix';

if (typeof autofix !== 'function') {
  throw new TypeError('The public package entry point must export autofix');
}
