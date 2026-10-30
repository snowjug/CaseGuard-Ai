import { describe, expect, it } from 'vitest';
import { safeErrorCode } from '../src';

describe('safeErrorCode', () => {
  it.each([
    [Object.assign(new Error('boom'), { code: 'ERR_MODULE_NOT_FOUND' }), 'ERR_MODULE_NOT_FOUND'],
    [Object.assign(new Error('boom'), { code: 'ECONNREFUSED' }), 'ECONNREFUSED'],
    [new TypeError('boom'), 'TypeError'],
    [new RangeError('boom'), 'RangeError'],
    [{ name: 'RestError' }, 'RestError'],
  ])('[NFR-SEC-06] reports the identifier of %j', (error, expected) => {
    expect(safeErrorCode(error)).toBe(expected);
  });

  it('[NFR-SEC-06] never returns the message, even when it carries a connection string', () => {
    const message =
      'InstrumentationKey=00000000-0000-0000-0000-00000000fake;IngestionEndpoint=https://x.test/';
    const error = new Error(message);
    error.name = message;

    expect(safeErrorCode(error)).toBe('unknown');
    expect(safeErrorCode(new Error(message))).toBe('Error');
    expect(safeErrorCode(new Error(message))).not.toContain('InstrumentationKey');
  });

  it.each([
    ['a string', 'just text'],
    ['a number', 42],
    ['null', null],
    ['undefined', undefined],
    ['an empty object', {}],
    ['a code with spaces', { code: 'not a code' }],
    ['a code with a line break', { code: 'ERR\nINJECTED' }],
    ['a code that starts with a digit', { code: '1ERR' }],
    ['a numeric code', { code: 404 }],
    ['an over-long code', { code: `E${'X'.repeat(64)}` }],
  ])('[NFR-SEC-06] falls back for %s', (_label, error) => {
    expect(safeErrorCode(error)).toBe('unknown');
    expect(safeErrorCode(error, 'fallback_code')).toBe('fallback_code');
  });

  it('[NFR-SEC-06] survives an object whose getters throw', () => {
    const hostile = {
      get code(): string {
        throw new Error('no code for you');
      },
      get name(): string {
        throw new Error('no name for you');
      },
    };

    expect(safeErrorCode(hostile)).toBe('unknown');
  });

  it('[NFR-SEC-06] prefers the code over the name', () => {
    expect(safeErrorCode(Object.assign(new TypeError('x'), { code: 'ERR_INVALID_URL' }))).toBe(
      'ERR_INVALID_URL',
    );
  });
});
