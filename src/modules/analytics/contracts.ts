import { z } from 'zod';
export const dashboardSchema = z
  .object({ period: z.enum(['7d', '30d', '90d', '12m']).default('30d') })
  .strict();
export const recentSchema = z
  .object({ limit: z.coerce.number().int().min(1).max(20).default(5) })
  .strict();

export type DashboardPeriod = '7d' | '30d' | '90d' | '12m';

export type DashboardSummary = {
  period: DashboardPeriod;
  range: { from: string; to: string };
  summary: {
    revenue: number;
    expenses: number;
    deliveryFees: number;
    productionCost: number;
    netProfit: number;
    orderCount: number;
    profitMarginPercent: number;
 undatedExpenses:{count:number;amount:number};
  };
  trend: {
    revenuePercent: number;
    profitPercent: number;
    expensesPercent: number;
  };
  graph: { date: string; revenue: number; expenses: number; netProfit: number }[];
  topItem: {
    recipeId: string | null;
    name: string;
    imageUrl: string | null;
    unitsSold: number;
    revenue: number;
    netProfit: number;
  } | null;
  orderProfitability: {
    average: number;
    median: number;
    sampleSize: number;
  };
  lowStock: {
    id: string;
    name: string;
    unit: string;
    currentQuantity: number;
    reorderLevel: number;
  }[];
};
