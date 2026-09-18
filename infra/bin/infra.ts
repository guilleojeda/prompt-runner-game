import * as cdk from 'aws-cdk-lib';
import { PromptRunnerAccessStack } from '../src/access-stack.js';
import { APPLICATION_ACCOUNT, APPLICATION_REGION, PromptRunnerHostingStack } from '../src/stack.js';

const app = new cdk.App();
const targetAccount = process.env.CDK_DEFAULT_ACCOUNT;
const targetRegion = process.env.CDK_DEFAULT_REGION;
if (targetAccount && targetAccount !== APPLICATION_ACCOUNT) {
  throw new Error(
    `Refusing to synthesize for account ${targetAccount}; expected ${APPLICATION_ACCOUNT}.`,
  );
}
if (targetRegion && targetRegion !== APPLICATION_REGION) {
  throw new Error(
    `Refusing to synthesize for region ${targetRegion}; expected ${APPLICATION_REGION}.`,
  );
}

const sharedEnvironment = {
  account: APPLICATION_ACCOUNT,
  region: APPLICATION_REGION,
};

new PromptRunnerAccessStack(app, 'PromptRunnerAccess', {
  env: sharedEnvironment,
  githubOidcProviderArn:
    process.env.GITHUB_OIDC_PROVIDER_ARN ?? app.node.tryGetContext('githubOidcProviderArn'),
});

new PromptRunnerHostingStack(app, 'PromptRunnerHosting', {
  env: sharedEnvironment,
  assetDeploymentRoleArn:
    process.env.ASSET_DEPLOYMENT_ROLE_ARN ?? app.node.tryGetContext('assetDeploymentRoleArn'),
  buildRevision:
    process.env.BUILD_REVISION ?? process.env.GITHUB_SHA ?? app.node.tryGetContext('buildRevision'),
});
