import {
  canonicalJson,
  decodeResponse,
  encodeResponse,
  hashRequest,
} from './canonical';

describe('canonicalJson / hashRequest', () => {
  it('ignores key order at every level and drops undefined', () => {
    const a = {
      input: { toEmail: 'b@x.com', amount: '100', extra: undefined },
    };
    const b = { input: { amount: '100', toEmail: 'b@x.com' } };

    expect(canonicalJson(a)).toBe(canonicalJson(b));
    expect(hashRequest(a)).toBe(hashRequest(b));
    expect(hashRequest(a)).toMatch(/^[0-9a-f]{64}$/);
  });

  it('tells apart requests that differ anywhere', () => {
    const base = { input: { amount: '100', list: [1, 2] } };

    expect(hashRequest(base)).not.toBe(
      hashRequest({ input: { amount: '101', list: [1, 2] } }),
    );
    expect(hashRequest(base)).not.toBe(
      hashRequest({ input: { amount: '100', list: [2, 1] } }),
    );
  });

  it('handles objects without a prototype (GraphQL input objects) and bigints', () => {
    const input = Object.assign(Object.create(null), { amount: 100n });

    expect(canonicalJson({ input })).toBe(
      '{"input":{"amount":{"$bigint":"100"}}}',
    );
  });
});

describe('encodeResponse / decodeResponse', () => {
  it('round-trips bigints and dates that plain JSON would lose', () => {
    const value = {
      transactionId: 't1',
      amount: 1250n,
      at: new Date('2026-11-16T21:44:04.258Z'),
      nested: [{ big: -(2n ** 63n) }, null, 'x'],
    };

    expect(decodeResponse(encodeResponse(value))).toEqual(value);
  });

  it('encodes undefined as null', () => {
    expect(decodeResponse(encodeResponse(undefined))).toBeNull();
  });
});
