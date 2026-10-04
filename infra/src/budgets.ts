import * as cdk from 'aws-cdk-lib';
import { aws_budgets as budgets } from 'aws-cdk-lib';
import { Construct } from 'constructs';
import type { PrivateLimits } from './private-limits.js';

export const BUDGET_NAME_PREFIX = 'prompt-runner-game';

/** Notifications only: no account-wide shutdown or IAM budget actions. */
export function createBillingBudgets(scope: Construct, limits: PrivateLimits): void {
  const notification = (
    threshold: number,
  ): budgets.CfnBudget.NotificationWithSubscribersProperty => ({
    notification: {
      notificationType: 'ACTUAL',
      comparisonOperator: 'GREATER_THAN',
      thresholdType: 'ABSOLUTE_VALUE',
      threshold,
    },
    subscribers: [{ subscriptionType: 'EMAIL', address: limits.billing.recipient }],
  });
  const costTypes = {
    includeTax: true,
    includeSupport: true,
    includeSubscription: true,
    includeUpfront: true,
    includeRecurring: true,
    includeOtherSubscription: true,
    includeCredit: false,
    includeRefund: false,
    useBlended: false,
    useAmortized: false,
    includeDiscount: true,
  };
  // AWS Budgets accepts at most five notifications on each budget. Both
  // monthly budgets measure the same full-account scope, split only for alerts.
  for (const [index, thresholds] of [
    limits.billing.monthlyThresholds.slice(0, 5),
    limits.billing.monthlyThresholds.slice(5),
  ].entries()) {
    new budgets.CfnBudget(scope, `AccountMonthlyBudget${index + 1}`, {
      budget: {
        budgetName: `${BUDGET_NAME_PREFIX}-account-monthly-${index + 1}`,
        budgetType: 'COST',
        timeUnit: 'MONTHLY',
        budgetLimit: { amount: cdk.Token.asNumber(limits.billing.monthlyUsd), unit: 'USD' },
        costTypes,
      },
      notificationsWithSubscribers: thresholds.map(notification),
    });
  }
  new budgets.CfnBudget(scope, 'BedrockDailyBudget', {
    budget: {
      budgetName: `${BUDGET_NAME_PREFIX}-bedrock-daily`,
      budgetType: 'COST',
      timeUnit: 'DAILY',
      budgetLimit: { amount: cdk.Token.asNumber(limits.dailyGlobalUsd), unit: 'USD' },
      // Claude is billed under its Marketplace provider. Resolve the actual
      // account's service dimensions privately, including native Bedrock.
      costFilters: { Service: limits.billing.bedrockServices },
      costTypes,
    },
    notificationsWithSubscribers: [notification(cdk.Token.asNumber(limits.dailyGlobalUsd))],
  });
}
