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
  const raw = Array.isArray(gazeSamples) ? gazeSamples : [];
  // Basic confidence filtering to reduce noisy measurements
  const samples = raw
    .filter((s) => s && (typeof s.timestampMs === 'number') && (typeof s.lookedAt === 'string'))
    .map((s) => ({
      timestampMs: Number(s.timestampMs),
      lookedAt: String(s.lookedAt),
      x: typeof s.x === 'number' ? s.x : null,
      y: typeof s.y === 'number' ? s.y : null,
      confidence: typeof s.confidence === 'number' ? s.confidence : 0,
    }))
    .filter((s) => s.confidence >= 0.35)
    .sort((a, b) => a.timestampMs - b.timestampMs);

  if (samples.length < 2) return null;

  let socialMs = 0;
  let patternMs = 0;
  let objectMs = 0;
  let lookedMs = 0;

  const shiftLatencies = [];
  let previousLabel = null;
  let previousTimestamp = null;
  let labelChanges = 0;

  // Fixation detection (simple): consecutive identical labels are aggregated into fixations.
  const fixationDurations = { face: [], pattern: [] };
  let currentFixationLabel = null;
  let currentFixationStart = null;

  for (const sample of samples) {
    const ts = sample.timestampMs;
    const label = sample.lookedAt || 'none';

    if (previousTimestamp != null) {
      const dt = clamp(ts - previousTimestamp, 0, 500);
      if (label !== 'none') lookedMs += dt;
      if (label === 'face' || label === 'eyes' || label === 'social') socialMs += dt;
      if (label === 'pattern') patternMs += dt;
      if (label === 'object' || label === 'nonsocial') objectMs += dt;

      if (previousLabel && previousLabel !== label) {
        // record shift latency when switching to a non-none label
        if (label !== 'none') shiftLatencies.push(dt);
        labelChanges += 1;
      }
    }

    // fixation aggregation
    if (label !== 'none') {
      if (currentFixationLabel === label) {
        // continue fixation
      } else {
        // close previous fixation
        if (currentFixationLabel && currentFixationStart != null) {
          const dur = ts - currentFixationStart;
          if (fixationDurations[currentFixationLabel]) {
            fixationDurations[currentFixationLabel].push(dur);
          }
        }
        // start new fixation
        currentFixationLabel = label;
        currentFixationStart = ts;
      }
    } else {
      // none label ends current fixation
      if (currentFixationLabel && currentFixationStart != null) {
        const dur = ts - currentFixationStart;
        if (fixationDurations[currentFixationLabel]) {
          fixationDurations[currentFixationLabel].push(dur);
        }
      }
      currentFixationLabel = null;
      currentFixationStart = null;
    }

    previousLabel = label;
    previousTimestamp = ts;
  }

  // close any open fixation at end
  if (currentFixationLabel && currentFixationStart != null && previousTimestamp != null) {
    const dur = previousTimestamp - currentFixationStart;
    if (fixationDurations[currentFixationLabel]) fixationDurations[currentFixationLabel].push(dur);
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

  const totalTimeSec = Math.max(0.001, (samples[samples.length - 1].timestampMs - samples[0].timestampMs) / 1000);
  const saccadeFrequencyHz = labelChanges / totalTimeSec;

  const meanFixation = (arr) => (arr && arr.length ? arr.reduce((s, v) => s + v, 0) / arr.length : 0);
  const fixationFaceMs = meanFixation(fixationDurations.face);
  const fixationPatternMs = meanFixation(fixationDurations.pattern);

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
      // additional temporal metrics
      fixationDurationFaceMs: round2(fixationFaceMs),
      fixationDurationPatternMs: round2(fixationPatternMs),
      saccadeFrequencyHz: round2(saccadeFrequencyHz),
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

function computeEngagementScore(gazeSamples) {
  const raw = Array.isArray(gazeSamples) ? gazeSamples : [];
  const samples = raw
    .filter((s) => s && (typeof s.timestampMs === 'number') && (typeof s.lookedAt === 'string'))
    .map((s) => ({
      timestampMs: Number(s.timestampMs),
      lookedAt: String(s.lookedAt),
      x: typeof s.x === 'number' ? s.x : null,
      y: typeof s.y === 'number' ? s.y : null,
      confidence: typeof s.confidence === 'number' ? s.confidence : 0,
    }))
    .filter((s) => s.confidence >= 0.35)
    .sort((a, b) => a.timestampMs - b.timestampMs);

  if (samples.length < 2) {
    return {
      engagementScore: 0,
      engagementBand: 'Very Low',
      metrics: {
        patternRatio: 0,
        faceRatio: 0,
        stability: 0,
        scatterIndex: 0,
        confidenceConsistency: 0,
      },
    };
  }

  // Step A: Count time on each target
  let patternTime = 0;
  let faceTime = 0;
  let noneTime = 0;
  let totalTime = 0;
  let previousTimestamp = null;

  // Step B: Compute target switches and stability
  let targetSwitches = 0;
  let previousLabel = null;

  // Step C: Collect gaze positions for scatter computation
  const gazePositions = [];

  for (const sample of samples) {
    const ts = sample.timestampMs;
    const label = sample.lookedAt || 'none';

    // Accumulate time on each target
    if (previousTimestamp != null) {
      const dt = clamp(ts - previousTimestamp, 0, 500);
      totalTime += dt;

      if (label === 'face') {
        faceTime += dt;
      } else if (label === 'pattern') {
        patternTime += dt;
      } else {
        noneTime += dt;
      }
    }

    // Count target switches
    if (previousLabel && previousLabel !== label && label !== 'none' && previousLabel !== 'none') {
      targetSwitches += 1;
    }

    // Collect gaze positions for scatter computation
    if (sample.x != null && sample.y != null) {
      gazePositions.push({ x: sample.x, y: sample.y });
    }

    previousLabel = label;
    previousTimestamp = ts;
  }

  const validTime = faceTime + patternTime;

  // Step B: Compute ratios
  const patternRatio = safeDiv(patternTime, validTime || 1);
  const faceRatio = safeDiv(faceTime, validTime || 1);

  // Step C: Compute stability (1 - switches/samples)
  const stability = clamp(1 - safeDiv(targetSwitches, samples.length || 1), 0, 1);

  // Step D: Compute scatter index (variance of gaze movement)
  let scatterIndex = 0;
  if (gazePositions.length > 1) {
    const meanX = gazePositions.reduce((s, p) => s + p.x, 0) / gazePositions.length;
    const meanY = gazePositions.reduce((s, p) => s + p.y, 0) / gazePositions.length;
    const varX = gazePositions.reduce((s, p) => s + Math.pow(p.x - meanX, 2), 0) / gazePositions.length;
    const varY = gazePositions.reduce((s, p) => s + Math.pow(p.y - meanY, 2), 0) / gazePositions.length;
    const scatterVariance = varX + varY;
    // Normalize scatter to [0, 1]: high scatter = 1, low scatter = 0
    scatterIndex = clamp(scatterVariance / 100000, 0, 1);
  }

  // Step E: Compute confidence-weighted consistency (average confidence)
  const avgConfidence = safeDiv(
    samples.reduce((s, sample) => s + sample.confidence, 0),
    samples.length || 1,
  );

  // Step F: Final Engagement Score formula
  // E = 0.4P + 0.25F + 0.2S + 0.15C
  // where:
  // P = pattern attention ratio
  // F = face attention ratio
  // S = stability score
  // C = confidence-weighted consistency
  const engagementScore01 =
    0.4 * patternRatio +
    0.25 * faceRatio +
    0.2 * stability +
    0.15 * avgConfidence;

  const engagementScore = round2(clamp(engagementScore01 * 100, 0, 100));

  // Step G: Determine engagement band
  let engagementBand = 'Very Low';
  if (engagementScore >= 80) {
    engagementBand = 'Highly Engaged';
  } else if (engagementScore >= 60) {
    engagementBand = 'Moderate Engagement';
  } else if (engagementScore >= 40) {
    engagementBand = 'Low Engagement';
  }

  return {
    engagementScore,
    engagementBand,
    metrics: {
      patternRatio: round2(patternRatio),
      faceRatio: round2(faceRatio),
      stability: round2(stability),
      scatterIndex: round2(scatterIndex),
      confidenceConsistency: round2(avgConfidence),
      targetSwitches,
      totalSamples: samples.length,
    },
  };
}

function scoreFollowDotSession({ roundEvents, gazeSamples }) {
  const gazeScoring = computeFromGazeSamples(gazeSamples);
  const base = gazeScoring || computeFromRoundEvents(roundEvents);
  const ati = buildAutismTraitIndex(base.metrics);
  const engagement = computeEngagementScore(gazeSamples);

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
      engagementScore: engagement.engagementScore,
      engagementBand: engagement.engagementBand,
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
    engagement: engagement.metrics,
    interpretation: ati.interpretation,
    engagementInterpretation: engagement.engagementBand,
    formula: {
      autismTraitIndex: '0.35*(SocialDeficit) + 0.25*(PatternPreference) + 0.20*(EyeAvoidance) + 0.20*(AttentionRigidity)',
      engagementScore: 'E = 0.4*PatternRatio + 0.25*FaceRatio + 0.2*Stability + 0.15*ConfidenceConsistency',
      note: 'All components are normalized to 0-100.',
    },
    disclaimer: 'Screening support only. This is not a medical diagnosis.',
  };
}

module.exports = {
  scoreFollowDotSession,
};
