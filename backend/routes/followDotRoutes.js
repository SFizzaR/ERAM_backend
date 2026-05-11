const express = require('express');
const expressAsyncHandler = require('express-async-handler');

const supabase = require('../config/supabaseAdmin');
const { protect } = require('../middleware/protectMiddleware');
const { scoreFollowDotSession } = require('../utils/followDotScoring');

const router = express.Router();

async function ensureChildOwnership(childId, userId) {
  if (!childId) return null;

  const { data, error } = await supabase
    .from('children')
    .select('id, user_id, date_of_birth')
    .eq('id', childId)
    .eq('user_id', userId)
    .single();

  if (error || !data) return null;
  return data;
}

router.post('/score', protect, expressAsyncHandler(async (req, res) => {
  const { childId, childAge, roundEvents, gazeSamples, metadata } = req.body;

  if (!Array.isArray(roundEvents) && !Array.isArray(gazeSamples)) {
    return res.status(400).json({
      message: 'Provide roundEvents or gazeSamples for scoring.',
    });
  }

  if (childId) {
    const child = await ensureChildOwnership(childId, req.user.id);
    if (!child) {
      return res.status(404).json({ message: 'Child not found for this user' });
    }
  }

  const scoring = scoreFollowDotSession({ roundEvents, gazeSamples });

  const warnings = [];
  if (scoring.measurementMode === 'interaction_proxy') {
    warnings.push('Interaction-proxy mode was used (touch behavior). Gaze camera tracking can improve confidence.');
  }
  if (scoring.sampleSize < 6) {
    warnings.push('Low sample size. Consider running more rounds for a more stable estimate.');
  }

  return res.status(200).json({
    childId: childId || null,
    childAge: childAge ?? null,
    measurementMode: scoring.measurementMode,
    sampleSize: scoring.sampleSize,
    scores: scoring.scores,
    ratios: scoring.ratios,
    timing: scoring.timing,
    totals: scoring.totals,
    interpretation: scoring.interpretation,
    formula: scoring.formula,
    warnings,
    metadata: {
      submittedAt: new Date().toISOString(),
      source: metadata?.source || 'follow-the-dot',
      appVersion: metadata?.appVersion || null,
    },
    clinicalDisclaimer: scoring.disclaimer,
  });
}));

module.exports = router;
