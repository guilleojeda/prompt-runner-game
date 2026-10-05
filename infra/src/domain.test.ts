import { runInNewContext } from 'node:vm';
import { describe, expect, it } from 'vitest';
import { PUBLIC_DOMAIN, PUBLIC_ORIGIN, publicRoutingCode } from './domain.js';

const route = (uri: string, host = PUBLIC_DOMAIN, querystring: Record<string, unknown> = {}) =>
  runInNewContext(`${publicRoutingCode}; handler(event);`, {
    event: { request: { uri, method: 'GET', headers: { host: { value: host } }, querystring } },
  });

describe('public website routing', () => {
  it('rewrites only known clean page paths and keeps query data on the request', () => {
    const query = { code: { value: 'opaque%2Bcode' }, state: { value: 'opaque-state' } };
    expect(route('/jugar', PUBLIC_DOMAIN, query)).toMatchObject({
      uri: '/jugar/index.html',
      querystring: query,
    });
    expect(route('/privacidad').uri).toBe('/privacidad/index.html');
    expect(route('/').uri).toBe('/');
    expect(route('/assets/missing.js').uri).toBe('/assets/missing.js');
    expect(route('/unknown').uri).toBe('/unknown');
  });

  it.each([
    ['/bienvenida.html', '/'],
    ['/index.html', '/'],
    ['/jugar/', '/jugar'],
    ['/jugar/index.html', '/jugar'],
    ['/privacidad/', '/privacidad'],
    ['/privacidad/index.html', '/privacidad'],
  ])('redirects %s to its canonical page %s', (input, canonical) => {
    expect(route(input)).toMatchObject({
      statusCode: 301,
      headers: { location: { value: `${PUBLIC_ORIGIN}${canonical}` } },
    });
  });

  it('moves the legacy CloudFront host to the public origin while preserving encoded and repeated query values', () => {
    expect(
      route('/jugar/', 'd1ilpq1n58tzqo.cloudfront.net', {
        code: { value: 'opaque%2Bcode' },
        tag: { value: 'one', multiValue: [{ value: 'one' }, { value: 'two%20words' }] },
      }),
    ).toMatchObject({
      statusCode: 301,
      headers: {
        location: { value: `${PUBLIC_ORIGIN}/jugar?code=opaque%2Bcode&tag=one&tag=two%20words` },
      },
    });
  });
});
