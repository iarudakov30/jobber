import { safeReturnUrl } from './router';

describe('safeReturnUrl', () => {
  it.each([
    ['/wallet?tab=history', '/wallet?tab=history'],
    [undefined, '/'],
    ['//evil.example', '/'],
    ['https://evil.example', '/'],
    ['wallet', '/'],
  ])('%s -> %s', (input, expected) => {
    expect(safeReturnUrl(input)).toBe(expected);
  });
});
