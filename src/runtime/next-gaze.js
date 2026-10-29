// Predictions are categorical hypotheses in a single decision's candidate space.
export function validateNextGaze(value, candidates) {
  if (value === null) return;
  if (!value || Object.keys(value).join(',') !== 'rankedTargetIds' || !Array.isArray(value.rankedTargetIds) || value.rankedTargetIds.length > 3 || new Set(value.rankedTargetIds).size !== value.rankedTargetIds.length || value.rankedTargetIds.some(id => ![...candidates.map(c => c.objectId), 'unknown', 'outside_view'].includes(id))) throw new TypeError('invalid next gaze');
}
