export type MetricValue = number | 'N/A';

export interface MetricPeriods {
  hours24: MetricValue;
  days3: MetricValue;
  days7: MetricValue;
}

export interface MonitoringUser {
  id: string;
  email: string;
  /** ISO UTC timestamp, or the literal N/A when the source has no date. */
  registeredAt: string;
  lastActiveAt: string;
  attempts: MetricPeriods;
  bedrockCostUsd: MetricPeriods;
  maxScore: MetricValue;
}

export interface MonitoringSnapshot {
  asOf: string;
  generatedAt: string;
  registeredUsers: MetricValue;
  newUsers: MetricPeriods;
  activeUsers: MetricPeriods;
  bedrockCostUsd: MetricPeriods;
  users: MonitoringUser[];
}
