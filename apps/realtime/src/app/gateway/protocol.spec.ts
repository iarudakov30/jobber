import {
  PUBLIC_CHANNELS,
  ProtocolError,
  messageFrame,
  parseClientMessage,
  seqOf,
} from './protocol';
import { cookieValue } from './socket-auth';

function refusal(raw: string): { code: string; channel?: string } {
  try {
    parseClientMessage(raw);
  } catch (error) {
    expect(error).toBeInstanceOf(ProtocolError);
    const { code, channel } = error as ProtocolError;
    return channel === undefined ? { code } : { code, channel };
  }
  throw new Error(`${raw} was accepted`);
}

describe('parseClientMessage', () => {
  it('accepts subscribe and unsubscribe to every price channel', () => {
    expect([...PUBLIC_CHANNELS]).toEqual([
      'prices.NXC',
      'prices.BLIP',
      'prices.ORB',
      'prices.WISP',
    ]);
    for (const channel of PUBLIC_CHANNELS) {
      for (const op of ['subscribe', 'unsubscribe'] as const) {
        expect(parseClientMessage(JSON.stringify({ op, channel }))).toEqual({
          op,
          channel,
        });
      }
    }
  });

  it("refuses every user channel, the caller's own too", () => {
    for (const channel of ['user.7', 'user.1', 'user', 'user.*', 'user.#']) {
      expect(refusal(JSON.stringify({ op: 'subscribe', channel }))).toEqual({
        code: 'FORBIDDEN',
        channel,
      });
    }
  });

  it('refuses unknown channels and malformed messages', () => {
    expect(refusal('{"op":"subscribe","channel":"prices.DOGE"}')).toEqual({
      code: 'UNKNOWN_CHANNEL',
      channel: 'prices.DOGE',
    });
    expect(refusal('{"op":"subscribe","channel":"prices.*"}').code).toBe(
      'UNKNOWN_CHANNEL',
    );
    for (const raw of [
      'not json',
      '"subscribe"',
      '[]',
      'null',
      '{"op":"publish","channel":"prices.NXC"}',
      '{"op":"subscribe"}',
      '{"op":"subscribe","channel":7}',
    ]) {
      expect(refusal(raw)).toEqual({ code: 'BAD_REQUEST' });
    }
  });
});

describe('seqOf', () => {
  it("takes a price's seq from its body", () => {
    expect(
      seqOf('prices.NXC', { type: 'price', seq: 812 }, 'price-NXC-812'),
    ).toBe(812);
    for (const seq of [0, -1, 1.5, '812', undefined]) {
      expect(seqOf('prices.NXC', { seq }, undefined)).toBeUndefined();
    }
  });

  it("takes a user message's seq from the outbox id in its messageId", () => {
    expect(seqOf('user.7', { type: 'fill' }, 'outbox-wallet-1234')).toBe(1234);
    expect(seqOf('user.7', {}, 'outbox-some-service-5')).toBe(5);
    for (const id of [
      undefined,
      '',
      'wallet-12',
      'outbox-wallet-',
      'outbox-wallet-x1',
    ]) {
      expect(seqOf('user.7', {}, id)).toBeUndefined();
    }
  });
});

it('messageFrame wraps a message with its channel and seq', () => {
  expect(JSON.parse(messageFrame('user.7', 9, { type: 'fill' }))).toEqual({
    type: 'message',
    channel: 'user.7',
    seq: 9,
    data: { type: 'fill' },
  });
});

it('cookieValue finds the Authentication cookie among others', () => {
  expect(
    cookieValue('a=1; Authentication=abc.def; b=2', 'Authentication'),
  ).toBe('abc.def');
  expect(cookieValue('Authentication=x%3Dy', 'Authentication')).toBe('x=y');
  expect(cookieValue('XAuthentication=1', 'Authentication')).toBeUndefined();
  expect(cookieValue('Authentication=', 'Authentication')).toBeUndefined();
  expect(cookieValue(undefined, 'Authentication')).toBeUndefined();
  expect(
    cookieValue('Authentication=%E0%A4%A', 'Authentication'),
  ).toBeUndefined();
});
