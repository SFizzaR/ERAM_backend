const supabase = require('../config/supabaseAdmin');

async function saveFollowDotSession({
  userId,
  childId,
  assessmentMode,
  measurementMode,
  roundEvents,
  gazeSamples,
  scores,
  ratios,
  timing,
  totals,
  interpretation,
  warnings,
  metadata,
  sourceRoute,
}) {
  const payload = {
    user_id: userId || null,
    child_id: childId || null,
    assessment_mode: assessmentMode || null,
    measurement_mode: measurementMode || null,
    round_events: Array.isArray(roundEvents) ? roundEvents : [],
    gaze_samples: Array.isArray(gazeSamples) ? gazeSamples : [],
    scores: scores || null,
    ratios: ratios || null,
    timing: timing || null,
    totals: totals || null,
    interpretation: interpretation || null,
    warnings: warnings || [],
    metadata: metadata || {},
    source_route: sourceRoute || null,
  };

  const { data, error } = await supabase
    .from('followdot_sessions')
    .insert([payload])
    .select('id')
    .single();

  if (error) {
    throw error;
  }

  return data;
}

module.exports = {
  saveFollowDotSession,
};