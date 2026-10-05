import * as cdk from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import { describe, expect, it } from 'vitest';
import { createAuthenticationResources } from './auth.js';

const synthesizeAuthentication = () => {
  const stack = new cdk.Stack();
  createAuthenticationResources(stack, {
    region: 'us-east-1',
    productionWebOrigin: 'https://game.example.test/',
    identityRateLimit: 37,
  });
  return Template.fromStack(stack);
};

// First CDK synthesis also pays construct startup cost under the full suite.
describe('authentication infrastructure', { timeout: 15_000 }, () => {
  it('uploads a logo within Cognito’s supported 1:1 to 4:1 aspect ratio', () => {
    const template = synthesizeAuthentication();
    const branding = Object.values(template.findResources('AWS::Cognito::ManagedLoginBranding'))[0];
    const logo = branding.Properties.Assets.find(
      (asset: { Category: string }) => asset.Category === 'FORM_LOGO',
    );
    const svg = Buffer.from(logo.Bytes, 'base64').toString('utf8');
    const root = svg.match(/^<svg\b[^>]*>/u)?.[0] ?? '';
    const width = Number(root.match(/\bwidth="([\d.]+)"/u)?.[1]);
    const height = Number(root.match(/\bheight="([\d.]+)"/u)?.[1]);
    expect(width).toBeGreaterThan(0);
    expect(height).toBeGreaterThan(0);
    expect(width / height).toBeGreaterThanOrEqual(1);
    expect(width / height).toBeLessThanOrEqual(4);
    expect(svg).toContain('Robot Runner');
  });

  it('associates an allow-by-default, five-minute per-IP rate rule with the user pool', () => {
    const template = synthesizeAuthentication();
    const webAclResources = template.findResources('AWS::WAFv2::WebACL');
    const webAcls = Object.values(webAclResources);
    expect(webAcls).toHaveLength(1);
    const acl = webAcls[0].Properties;
    expect(acl).toMatchObject({
      Scope: 'REGIONAL',
      DefaultAction: { Allow: {} },
      Rules: [
        {
          Action: { Block: {} },
          Priority: 0,
          Statement: {
            RateBasedStatement: {
              AggregateKeyType: 'IP',
              EvaluationWindowSec: 300,
              Limit: 37,
            },
          },
          VisibilityConfig: {
            CloudWatchMetricsEnabled: false,
            SampledRequestsEnabled: false,
          },
        },
      ],
    });

    const associations = Object.values(template.findResources('AWS::WAFv2::WebACLAssociation'));
    expect(associations).toHaveLength(1);
    expect(associations[0].Properties).toEqual({
      ResourceArn: { 'Fn::GetAtt': ['UserPool', 'Arn'] },
      WebACLArn: { 'Fn::GetAtt': [Object.keys(webAclResources)[0], 'Arn'] },
    });
    template.resourceCountIs('AWS::WAFv2::LoggingConfiguration', 0);
  });

  it('limits only the selected registration and recovery operations and managed-login paths', () => {
    const template = synthesizeAuthentication();
    const statement = Object.values(template.findResources('AWS::WAFv2::WebACL'))[0].Properties
      .Rules[0].Statement.RateBasedStatement.ScopeDownStatement.OrStatement.Statements as Array<
      Record<string, unknown>
    >;
    const operations = statement
      .map((entry) => entry.ByteMatchStatement as Record<string, unknown> | undefined)
      .filter((entry) => entry?.FieldToMatch && 'SingleHeader' in (entry.FieldToMatch as object))
      .map((entry) => entry!.SearchString as string);
    const paths = statement
      .map((entry) => entry.ByteMatchStatement as Record<string, unknown> | undefined)
      .filter((entry) => entry?.FieldToMatch && 'UriPath' in (entry.FieldToMatch as object))
      .map((entry) => entry!.SearchString as string);

    expect(new Set(operations)).toEqual(
      new Set([
        'SignUp',
        'ConfirmSignUp',
        'ResendConfirmationCode',
        'ForgotPassword',
        'ConfirmForgotPassword',
      ]),
    );
    expect(new Set(paths)).toEqual(
      new Set([
        '/signup',
        '/confirm',
        '/confirmUser',
        '/resendcode',
        '/forgotPassword',
        '/confirmforgotPassword',
      ]),
    );
    expect(JSON.stringify(statement)).not.toContain('x-amz-target');
    expect(JSON.stringify(statement)).not.toMatch(/oauth2\/(?:token|userInfo)|\/login|\/attempts/u);
  });
});
