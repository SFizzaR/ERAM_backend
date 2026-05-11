function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function safeDiv(numerator, denominator) {
  if (!denominator) return 0;
  return numerator / denominator;
}

function toPct01(value01) {
  return clamp(value01 * 100, 0, 100);
}

function round2(value) {
  return Math.round(value * 100) / 100;
}

function normalizeLatencyToScore(latencyMs, goodMs, badMs) {
  if (latencyMs <= goodMs) return 100;
  if (latencyMs >= badMs) return 0;
  const normalized = (latencyMs - goodMs) / (badMs - goodMs);
  return clamp((1 - normalized) * 100, 0, 100);
}

function computeFromRoundEvents(roundEvents) {
  const rounds = Array.isArray(roundEvents) ? roundEvents : [];

  let totalFaceTouches = 0;
  let totalPatternTouches = 0;
  let totalTouches = 0;
  let totalDurationMs = 0;

  let faceRounds = 0;
  let avoidedFaceRounds = 0;
  const firstFixationLatencies = [];
  const shiftLatencies = [];
  const touchRates = [];

  for (const round of rounds) {
    const durationMs = Math.max(1, Number(round.durationMs || 0));
    const touchesFace = Math.max(0, Number(round.touches?.face || 0));
    const touchesPattern = Math.max(0, Number(round.touches?.pattern || 0));
    const touchesRound = touchesFace + touchesPattern;

    const facePresent = Number(round.faceStimulusCount || 0) > 0;
    const patternPresent = Number(round.patternStimulusCount || 0) > 0;

    totalFaceTouches += touchesFace;
    totalPatternTouches += touchesPattern;
    totalTouches += touchesRound;
    totalDurationMs += durationMs;

    touchRates.push(safeDiv(touchesRound, durationMs / 1000));

    if (facePresent) {
      faceRounds += 1;
      if (touchesFace === 0) {
        avoidedFaceRounds += 1;
      }
    }

    if (round.firstTouchLatencyMs != null) {
      const latency = Math.max(0, Number(round.firstTouchLatencyMs));
      firstFixationLatencies.push(latency);
      shiftLatencies.push(latency);
    }

    if (round.firstTouchTarget === 'face' && patternPresent && facePresent) {
      // Fast first fixation toward a social cue contributes positively.
      const socialLeadLatency = Math.max(0, Number(round.firstTouchLatencyMs || 0));
      shiftLatencies.push(socialLeadLatency);
    }
  }

  const avgFirstFixLatencyMs = firstFixationLatencies.length
    ? firstFixationLatencies.reduce((sum, v) => sum + v, 0) / firstFixationLatencies.length
    : 0;

  const avgShiftLatencyMs = shiftLatencies.length
    ? shiftLatencies.reduce((sum, v) => sum + v, 0) / shiftLatencies.length
    : 0;

  const avgTouchRate = touchRates.length
    ? touchRates.reduce((sum, v) => sum + v, 0) / touchRates.length
    : 0;

  const touchRateVariance = touchRates.length
    ? touchRates.reduce((sum, v) => sum + Math.pow(v - avgTouchRate, 2), 0) / touchRates.length
    : 0;

  const touchRateStd = Math.sqrt(touchRateVariance);

  const socialAttentionRatio01 = safeDiv(totalFaceTouches, totalTouches || 1);
  const patternPreference01 = safeDiv(totalPatternTouches, totalTouches || 1);
  const eyeAvoidance01 = safeDiv(avoidedFaceRounds, faceRounds || 1);

  // Touch variability can approximate smoothness/consistency of engagement.
  const trackingStabilityScore = clamp(100 - touchRateStd * 18, 0, 100);

  const attentionFlexibilityScore = normalizeLatencyToScore(avgShiftLatencyMs || avgFirstFixLatencyMs || 1600, 350, 2600);

  const socialAttentionScore = toPct01(socialAttentionRatio01);
  const patternPreferenceScore = toPct01(patternPreference01);
  const eyeAvoidanceScore = toPct01(eyeAvoidance01);

  // Positive values indicate stronger pattern attraction relative to social attention.
  const preferenceBalance01 = safeDiv(
    patternPreference01 - socialAttentionRatio01 + 1,
    2,
  );

  return {
    mode: 'interaction_proxy',
    sampleSize: rounds.length,
    totals: {
      totalRounds: rounds.length,
      totalDurationMs: round2(totalDurationMs),
      totalTouches,
      totalFaceTouches,
      totalPatternTouches,
      faceRounds,
      avoidedFaceRounds,
    },
    metrics: {
      socialAttentionRatio: round2(socialAttentionRatio01),
      patternPreferenceRatio: round2(patternPreference01),
      eyeAvoidanceRatio: round2(eyeAvoidance01),
      averageFirstFixationLatencyMs: round2(avgFirstFixLatencyMs),
      averageAttentionShiftLatencyMs: round2(avgShiftLatencyMs),
      socialAttentionScore: round2(socialAttentionScore),
      patternPreferenceScore: round2(patternPreferenceScore),
      eyeAvoidanceScore: round2(eyeAvoidanceScore),
      trackingStabilityScore: round2(trackingStabilityScore),
      attentionFlexibilityScore: round2(attentionFlexibilityScore),
      stimulusPreferenceIndex: round2(toPct01(preferenceBalance01)),
    },
  };
}

function computeFromGazeSamples(gazeSamples) {
  const samples = Array.isArray(gazeSamples) ? gazeSamples : [];
  if (samples.length < 2) {
    return null;
  }

  let socialMs = 0;
  let patternMs = 0;
  let objectMs = 0;
  let lookedMs = 0;

  const shiftLatencies = [];
  let previousLabel = null;
  let previousTimestamp = null;

  for (const sample of samples) {
    const ts = Number(sample.timestampMs || 0);
    const label = String(sample.lookedAt || 'none');

    if (previousTimestamp != null) {
      const dt = clamp(ts - previousTimestamp, 0, 120);
      if (label !== 'none') lookedMs += dt;
      if (label === 'face' || label === 'eyes' || label === 'social') socialMs += dt;
      if (label === 'pattern') patternMs += dt;
      if (label === 'object' || label === 'nonsocial') objectMs += dt;

      if (previousLabel && previousLabel !== label && label !== 'none') {
        shiftLatencies.push(dt);
      }
    }

    previousLabel = label;
    previousTimestamp = ts;
  }

  const nonSocialMs = patternMs + objectMs;
  const socialAttentionRatio01 = safeDiv(socialMs, lookedMs || 1);
  const patternPreference01 = safeDiv(patternMs, lookedMs || 1);

  const attentionFlexibilityScore = normalizeLatencyToScore(
    shiftLatencies.length
      ? shiftLatencies.reduce((sum, v) => sum + v, 0) / shiftLatencies.length
      : 1400,
    120,
    1200,
  );

  const trackingStabilityScore = clamp(55 + safeDiv(samples.length, 2), 0, 100);

  const preferenceBalance01 = safeDiv(nonSocialMs - socialMs + lookedMs, lookedMs * 2 || 1);

  return {
    mode: 'gaze',
    sampleSize: samples.length,
    totals: {
      socialMs: round2(socialMs),
      nonSocialMs: round2(nonSocialMs),
      patternMs: round2(patternMs),
      objectMs: round2(objectMs),
      lookedMs: round2(lookedMs),
    },
    metrics: {
      socialAttentionRatio: round2(socialAttentionRatio01),
      patternPreferenceRatio: round2(patternPreference01),
      eyeAvoidanceRatio: round2(1 - socialAttentionRatio01),
      averageFirstFixationLatencyMs: 0,
      averageAttentionShiftLatencyMs: shiftLatencies.length
        ? round2(shiftLatencies.reduce((sum, v) => sum + v, 0) / shiftLatencies.length)
        : 0,
      socialAttentionScore: round2(toPct01(socialAttentionRatio01)),
      patternPreferenceScore: round2(toPct01(patternPreference01)),
      eyeAvoidanceScore: round2(toPct01(1 - socialAttentionRatio01)),
      trackingStabilityScore: round2(trackingStabilityScore),
      attentionFlexibilityScore: round2(attentionFlexibilityScore),
      stimulusPreferenceIndex: round2(toPct01(preferenceBalance01)),
    },
  };
}

function buildAutismTraitIndex(metrics) {
  const socialDeficit = 100 - metrics.socialAttentionScore;
  const attentionRigidity = 100 - metrics.attentionFlexibilityScore;

  const ati =
    0.35 * socialDeficit +
    0.25 * metrics.patternPreferenceScore +
    0.2 * metrics.eyeAvoidanceScore +
    0.2 * attentionRigidity;

  let interpretation = 'Minimal autism-related traits in this screening context';
  if (ati >= 76) {
    interpretation = 'Strong behavioral indicators in this screening context';
  } else if (ati >= 51) {
    interpretation = 'Moderate autism-related traits in this screening context';
  } else if (ati >= 26) {
    interpretation = 'Mild autism-related traits in this screening context';
  }

  return {
    autismTraitIndex: round2(clamp(ati, 0, 100)),
    interpretation,
  };
}

function scoreFollowDotSession({ roundEvents, gazeSamples }) {
  const gazeScoring = computeFromGazeSamples(gazeSamples);
  const base = gazeScoring || computeFromRoundEvents(roundEvents);
  const ati = buildAutismTraitIndex(base.metrics);

  return {
    measurementMode: base.mode,
    sampleSize: base.sampleSize,
    totals: base.totals,
    scores: {
      socialAttentionScore: base.metrics.socialAttentionScore,
      patternPreferenceScore: base.metrics.patternPreferenceScore,
      trackingStabilityScore: base.metrics.trackingStabilityScore,
      attentionFlexibilityScore: base.metrics.attentionFlexibilityScore,
      eyeAvoidanceScore: base.metrics.eyeAvoidanceScore,
      stimulusPreferenceIndex: base.metrics.stimulusPreferenceIndex,
      autismTraitIndex: ati.autismTraitIndex,
    },
    ratios: {
      socialAttentionRatio: base.metrics.socialAttentionRatio,
      patternPreferenceRatio: base.metrics.patternPreferenceRatio,
      eyeAvoidanceRatio: base.metrics.eyeAvoidanceRatio,
    },
    timing: {
      averageFirstFixationLatencyMs: base.metrics.averageFirstFixationLatencyMs,
      averageAttentionShiftLatencyMs: base.metrics.averageAttentionShiftLatencyMs,
    },
    interpretation: ati.interpretation,
    formula: {
      autismTraitIndex: '0.35*(SocialDeficit) + 0.25*(PatternPreference) + 0.20*(EyeAvoidance) + 0.20*(AttentionRigidity)',
      note: 'All components are normalized to 0-100.',
    },
    disclaimer: 'Screening support only. This is not a medical diagnosis.',
  };
}

module.exports = {
  scoreFollowDotSession,
};
