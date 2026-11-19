import { errorText } from './rabbit.connection';

describe('errorText', () => {
  it('uses the message when there is one', () => {
    expect(errorText(new Error('SMTP refused'))).toBe('SMTP refused');
  });

  it('spells out an error with an empty message, as nodemailer throws it', () => {
    // AggregateError itself needs lib es2021; this has the same shape.
    const error = Object.assign(new Error(''), {
      name: 'AggregateError',
      code: 'ESOCKET',
      errors: [
        new Error('connect ECONNREFUSED ::1:1025'),
        new Error('connect ECONNREFUSED 127.0.0.1:1025'),
      ],
    });

    expect(errorText(error)).toBe(
      'connect ECONNREFUSED ::1:1025; connect ECONNREFUSED 127.0.0.1:1025; ESOCKET',
    );
  });

  it('falls back to the error name, then to String()', () => {
    expect(errorText(new TypeError(''))).toBe('TypeError');
    expect(errorText('plain')).toBe('plain');
  });
});
