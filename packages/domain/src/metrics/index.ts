export { computeAvoidableEffort, isUsableScenario, type AvoidableEffortInput } from './ase';
export {
  ASE_COMPONENT_SPECS,
  ASE_NOTICE,
  type AvoidableComponentDetail,
  type AvoidableEffortEstimate,
  type AvoidableEffortState,
  type ComponentSpec,
} from './ase-model';
export {
  summarizeAvoidableEffort,
  toAvoidableEffortDetails,
  type AvoidableEffortSummary,
} from './ase-details';
export {
  computeEfficiency,
  type CheaperEquivalent,
  type EfficiencyInput,
  type EfficiencyReport,
  type FigureBasis,
  type LabelledFigure,
  type UnitPrices,
} from './efficiency';
export {
  computeReasoningEfficiency,
  type ReasoningDecision,
  type ReasoningEfficiency,
} from './reasoning';
export { buildMetricEstimates, metricStatus, type MetricEstimatesInput } from './estimates';
export {
  COMPARISON_NOTICE,
  buildComparisonNarrative,
  buildComparisonRows,
  buildMetricCards,
  type ComparisonSide,
  type MetricCardOptions,
} from './cards';
export {
  buildAnalyticsOverview,
  GENERIC_ASSUMPTION_SUBJECT,
  type AnalyticsInput,
  type AnalyticsOptions,
} from './analytics';
