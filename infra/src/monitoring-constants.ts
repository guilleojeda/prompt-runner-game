export const MONITORING_BUCKET_NAME_PREFIX = 'prompt-runner-game-monitoring';
export const MONITORING_AUTH_FUNCTION_NAME = 'prompt-runner-game-monitoring-auth';
export const MONITORING_METRICS_FUNCTION_NAME = 'prompt-runner-game-monitoring-metrics';
export const MONITORING_METRICS_ROLE_NAME =
  'prompt-runner-game-monitoring-metrics-execution-us-east-1';
export const MONITORING_METRICS_LOG_GROUP_NAME = `/aws/lambda/${MONITORING_METRICS_FUNCTION_NAME}`;
export const MONITORING_ASSET_DEPLOYMENT_ROLE_NAME =
  'prompt-runner-game-monitoring-asset-deployment-us-east-1';
export const MONITORING_ASSET_DEPLOYMENT_FUNCTION_NAME =
  'prompt-runner-game-monitoring-assets-deployment-us-east-1';
export const MONITORING_ASSET_DEPLOYMENT_LOG_GROUP_NAME = `/aws/lambda/${MONITORING_ASSET_DEPLOYMENT_FUNCTION_NAME}`;
export const MONITORING_DEPLOYMENT_CFN_POLICY_NAME = 'prompt-runner-game-monitoring-cfn-execution';

export const monitoringBucketNameFor = (account: string, region: string): string =>
  `${MONITORING_BUCKET_NAME_PREFIX}-${account}-${region}`;
