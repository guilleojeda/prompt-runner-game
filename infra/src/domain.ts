import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';

export const PUBLIC_DOMAIN = 'robotrunner.guilleojeda.com';
export const PUBLIC_ORIGIN = `https://${PUBLIC_DOMAIN}`;
export const PUBLIC_HOSTED_ZONE_ID_PARAMETER = '/prompt-runner-game/domain/hosted-zone-id';
export const PUBLIC_ROUTING_FUNCTION_NAME = 'prompt-runner-game-public-routing';

/** The zone is prepared once by an operator before delegating it from the other account. */
export function publicHostedZoneId(scope: Construct): string {
  return new cdk.CfnParameter(scope, 'PublicHostedZoneId', {
    type: 'AWS::SSM::Parameter::Value<String>',
    default: PUBLIC_HOSTED_ZONE_ID_PARAMETER,
  }).valueAsString;
}

/** Keep exact page rewrites separate from missing assets: never turn an asset error into HTML. */
export const publicRoutingCode = `function handler(event) {
  var request = event.request;
  var path = request.uri;
  var canonicalPath = path;
  if (path === '/bienvenida.html' || path === '/index.html') canonicalPath = '/';
  if (path === '/jugar/' || path === '/jugar/index.html') canonicalPath = '/jugar';
  if (path === '/privacidad/' || path === '/privacidad/index.html') canonicalPath = '/privacidad';
  if (request.headers.host.value !== '${PUBLIC_DOMAIN}' || canonicalPath !== path) {
    var parts = [];
    var query = request.querystring || {};
    for (var key in query) {
      var values = query[key].multiValue || [query[key]];
      for (var index = 0; index < values.length; index++) {
        parts.push(key + '=' + values[index].value);
      }
    }
    return {
      statusCode: 301,
      statusDescription: 'Moved Permanently',
      headers: { location: { value: '${PUBLIC_ORIGIN}' + canonicalPath + (parts.length ? '?' + parts.join('&') : '') } }
    };
  }
  if (path === '/jugar') request.uri = '/jugar/index.html';
  if (path === '/privacidad') request.uri = '/privacidad/index.html';
  return request;
}`;
