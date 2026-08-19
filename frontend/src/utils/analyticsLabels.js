// Humanizes the engine's raw measure labels (audit UX-6): the wire format is
// 'agg(field.key)' — correct for machines, jarring on a chart axis. One
// helper shared by the table and the dashboard so the wording cannot fork.
const AGG_LABELS = {
  sum: 'Sum of',
  avg: 'Average',
  min: 'Lowest',
  max: 'Highest',
};

export function humanMeasureLabel(raw, byKey, t) {
  if (raw === 'count') return t('analytics.count', 'Bottles');
  const m = /^(sum|avg|min|max)\((.+)\)$/.exec(raw);
  if (!m) return raw;
  const fieldLabel = byKey?.get?.(m[2])?.label || m[2];
  const agg = t(`analytics.agg.${m[1]}`, AGG_LABELS[m[1]] || m[1]);
  return `${agg} ${fieldLabel}`;
}
