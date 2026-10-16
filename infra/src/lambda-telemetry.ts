import * as lambda from 'aws-cdk-lib/aws-lambda';
import { Construct } from 'constructs';

/** The published AWS Distro for OpenTelemetry layer used by the Node.js 22 Lambdas. */
export const AWS_OTEL_LAYER_ARN =
  'arn:aws:lambda:us-east-1:615299751070:layer:AWSOpenTelemetryDistroJs:16';

/**
 * Settings shared by the three application Lambdas. The layer sends traces over
 * Lambda's built-in X-Ray delivery path; metrics and log exporting stay disabled.
 */
export const LAMBDA_TELEMETRY_ENVIRONMENT = {
  AWS_LAMBDA_EXEC_WRAPPER: '/opt/otel-instrument',
  OTEL_AWS_APPLICATION_SIGNALS_ENABLED: 'false',
  OTEL_METRICS_EXPORTER: 'none',
  OTEL_LOGS_EXPORTER: 'none',
  OTEL_TRACES_EXPORTER: 'otlp',
  OTEL_NODE_ENABLED_INSTRUMENTATIONS: 'aws-lambda',
  OTEL_NODE_DISABLED_INSTRUMENTATIONS: 'aws-sdk,http',
  AWS_REDACT_SPAN_ATTRIBUTES: 'url.full',
} as const;

/**
 * Return the bounded CDK options applied to each application Lambda. A distinct
 * layer construct id keeps this helper safe when several functions share a stack.
 */
export const lambdaTelemetryOptions = (
  scope: Construct,
  layerConstructId: string,
  environment: Record<string, string>,
): Pick<
  lambda.FunctionProps,
  'architecture' | 'tracing' | 'loggingFormat' | 'layers' | 'environment'
> => ({
  architecture: lambda.Architecture.X86_64,
  tracing: lambda.Tracing.ACTIVE,
  loggingFormat: lambda.LoggingFormat.JSON,
  layers: [lambda.LayerVersion.fromLayerVersionArn(scope, layerConstructId, AWS_OTEL_LAYER_ARN)],
  environment: {
    ...environment,
    ...LAMBDA_TELEMETRY_ENVIRONMENT,
  },
});
