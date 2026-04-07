const { calculateAge } = require('./ageCalculator');

const MIN_ATTEMPTS_FOR_STABLE_SIGNAL = 8;

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function safeDivide(numerator, denominator) {
  if (!denominator) return 0;
  return numerator / denominator;
}

function computeMaxScoreFromDeltas(scoreDeltas = []) {
  let running = 0;
  let maxScore = 0;

  for (const delta of scoreDeltas) {
    running += Number(delta || 0);
    if (running > maxScore) maxScore = running;
  }

  return maxScore;
}

function computeSessionFeatures(attempts = []) {
  const totalAttempts = attempts.length;
  const correctAttempts = attempts.filter((a) => a.is_correct === true).length;
  const totalResponseTimeMs = attempts.reduce((sum, a) => sum + Number(a.response_time_ms || 0), 0);
  const totalClipDurationMs = attempts.reduce((sum, a) => sum + Number(a.clip_duration_ms || 0), 0);
  const levelReached = attempts.reduce((maxLevel, a) => Math.max(maxLevel, Number(a.level || 1)), 1);
  const maxScore = computeMaxScoreFromDeltas(attempts.map((a) => Number(a.score_delta || 0)));

  const correctAnswerRate = safeDivide(correctAttempts, totalAttempts);
  const meanResponseTimeMs = safeDivide(totalResponseTimeMs, totalAttempts);
  const meanClipDurationMs = safeDivide(totalClipDurationMs, totalAttempts);
  const absoluteResponseTimeMs = meanResponseTimeMs - meanClipDurationMs;

  return {
    totalAttempts,
    correctAttempts,
    correctAnswerRate,
    meanResponseTimeMs,
    meanClipDurationMs,
    absoluteResponseTimeMs,
    levelReached,
    maxScore,
  };
}

function chooseRiskLevel(score01) {
  if (score01 < 0.35) return 'low';
  if (score01 < 0.65) return 'moderate';
  return 'high';
}

function calculateAgeBand(dateOfBirth) {
  const age = calculateAge(dateOfBirth);
  return Number.isInteger(age) ? age : null;
}

function scoreWithNorms(features, normRow) {
  const carStd = Number(normRow.correct_answer_rate_std || 0.08);
  const artStd = Number(normRow.absolute_response_time_std_ms || 700);

  const zCar = (features.correctAnswerRate - Number(normRow.correct_answer_rate_mean || 0.7)) / carStd;
  const zArt = (features.absoluteResponseTimeMs - Number(normRow.absolute_response_time_mean_ms || 1500)) / artStd;

  const progressionPenalty = features.levelReached <= 2 ? 0.5 : 0;

  // Higher risk if CAR is lower and absolute response time is higher.
  const raw = (0.58 * (-zCar)) + (0.37 * zArt) + (0.05 * progressionPenalty);
  const normalized = clamp((raw + 2) / 4, 0, 1);

  return {
    riskScore01: normalized,
    method: 'norm-referenced-zscore',
    methodDetails: {
      zCar,
      zArt,
      progressionPenalty,
      normId: normRow.id,
    },
  };
}

function scoreHeuristic(features) {
  const carRisk = clamp((0.75 - features.correctAnswerRate) / 0.35, 0, 1);
  const artRisk = clamp((features.absoluteResponseTimeMs - 1200) / 3500, 0, 1);
  const progressionRisk =
    features.levelReached <= 1 ? 1 :
      features.levelReached === 2 ? 0.6 :
        features.levelReached === 3 ? 0.25 : 0;

  const score01 = (0.55 * carRisk) + (0.35 * artRisk) + (0.10 * progressionRisk);

  return {
    riskScore01: clamp(score01, 0, 1),
    method: 'paper-aligned-heuristic',
    methodDetails: {
      carRisk,
      artRisk,
      progressionRisk,
    },
  };
}

function inferRisk({ features, normRow }) {
  const scoring = normRow ? scoreWithNorms(features, normRow) : scoreHeuristic(features);
  const riskLevel = chooseRiskLevel(scoring.riskScore01);

  const confidence =
    features.totalAttempts < MIN_ATTEMPTS_FOR_STABLE_SIGNAL
      ? 'low'
      : normRow
        ? 'high'
        : 'medium';

  return {
    riskLevel,
    riskScore01: scoring.riskScore01,
    confidence,
    method: scoring.method,
    methodDetails: scoring.methodDetails,
  };
}

module.exports = {
  computeSessionFeatures,
  inferRisk,
  calculateAgeBand,
  MIN_ATTEMPTS_FOR_STABLE_SIGNAL,
};
