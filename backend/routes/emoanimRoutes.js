const express = require('express');
const expressAsyncHandler = require('express-async-handler');

const supabase = require('../config/supabaseAdmin');
const { protect } = require('../middleware/protectMiddleware');
const {
  computeSessionFeatures,
  inferRisk,
  calculateAgeBand,
  MIN_ATTEMPTS_FOR_STABLE_SIGNAL,
} = require('../utils/emoanimRisk');

const router = express.Router();

const ALLOWED_EMOTIONS = ['fear', 'sadness', 'happiness', 'anger'];
const ALLOWED_OPTION_FORMATS = ['emoji', 'real_faces'];

function validateEmotion(emotion) {
  return ALLOWED_EMOTIONS.includes(String(emotion || '').toLowerCase());
}

function normalizeEmotion(emotion) {
  return String(emotion || '').toLowerCase();
}

async function ensureChildOwnership(childId, userId) {
  const { data, error } = await supabase
    .from('children')
    .select('id, user_id, date_of_birth')
    .eq('id', childId)
    .eq('user_id', userId)
    .single();

  if (error || !data) return null;
  return data;
}

async function getSessionOwnedByUser(sessionId, userId) {
  const { data, error } = await supabase
    .from('emoanim_sessions')
    .select('*')
    .eq('id', sessionId)
    .eq('user_id', userId)
    .single();

  if (error || !data) return null;
  return data;
}

router.post('/session/start', protect, expressAsyncHandler(async (req, res) => {
  const { childId } = req.body;

  if (!childId) {
    return res.status(400).json({ message: 'childId is required' });
  }

  const child = await ensureChildOwnership(childId, req.user.id);
  if (!child) {
    return res.status(404).json({ message: 'Child not found for this user' });
  }

  const sessionInsert = {
    user_id: req.user.id,
    child_id: child.id,
    language: 'en',
    status: 'in_progress',
    started_at: new Date().toISOString(),
  };

  const { data: session, error } = await supabase
    .from('emoanim_sessions')
    .insert([sessionInsert])
    .select('*')
    .single();

  if (error || !session) {
    return res.status(500).json({
      message: 'Failed to create EmoAnim session',
      error: error ? error.message : 'Unknown error',
    });
  }

  return res.status(201).json({
    sessionId: session.id,
    status: session.status,
    startedAt: session.started_at,
  });
}));

router.post('/event', protect, expressAsyncHandler(async (req, res) => {
  const {
    sessionId,
    level,
    clipId,
    clipDurationMs,
    selectedEmotion,
    correctEmotion,
    responseTimeMs,
    scoreDelta,
    hasSound,
    optionsFormat,
  } = req.body;

  if (!sessionId || !level || !clipId || clipDurationMs == null || responseTimeMs == null || scoreDelta == null) {
    return res.status(400).json({ message: 'sessionId, level, clipId, clipDurationMs, responseTimeMs and scoreDelta are required' });
  }

  if (Number(level) < 1 || Number(level) > 4) {
    return res.status(400).json({ message: 'level must be between 1 and 4' });
  }

  if (!validateEmotion(selectedEmotion) || !validateEmotion(correctEmotion)) {
    return res.status(400).json({ message: `selectedEmotion/correctEmotion must be one of: ${ALLOWED_EMOTIONS.join(', ')}` });
  }

  if (optionsFormat && !ALLOWED_OPTION_FORMATS.includes(optionsFormat)) {
    return res.status(400).json({ message: 'optionsFormat must be emoji or real_faces' });
  }

  if (Number(responseTimeMs) < Number(clipDurationMs)) {
    return res.status(400).json({ message: 'responseTimeMs cannot be smaller than clipDurationMs' });
  }

  const session = await getSessionOwnedByUser(sessionId, req.user.id);
  if (!session) {
    return res.status(404).json({ message: 'Session not found for this user' });
  }

  if (session.status !== 'in_progress') {
    return res.status(409).json({ message: 'Session is not active' });
  }

  const normalizedSelected = normalizeEmotion(selectedEmotion);
  const normalizedCorrect = normalizeEmotion(correctEmotion);
  const isCorrect = normalizedSelected === normalizedCorrect;

  const attemptInsert = {
    session_id: session.id,
    child_id: session.child_id,
    level: Number(level),
    clip_id: String(clipId),
    clip_duration_ms: Number(clipDurationMs),
    selected_emotion: normalizedSelected,
    correct_emotion: normalizedCorrect,
    response_time_ms: Number(responseTimeMs),
    is_correct: isCorrect,
    score_delta: Number(scoreDelta),
    has_sound: typeof hasSound === 'boolean' ? hasSound : null,
    options_format: optionsFormat || null,
    created_at: new Date().toISOString(),
  };

  const { data: attempt, error } = await supabase
    .from('emoanim_attempts')
    .insert([attemptInsert])
    .select('id, is_correct, score_delta')
    .single();

  if (error || !attempt) {
    return res.status(500).json({
      message: 'Failed to save event',
      error: error ? error.message : 'Unknown error',
    });
  }

  return res.status(201).json({
    eventId: attempt.id,
    isCorrect: attempt.is_correct,
    scoreDelta: attempt.score_delta,
  });
}));

router.post('/session/end', protect, expressAsyncHandler(async (req, res) => {
  const { sessionId } = req.body;

  if (!sessionId) {
    return res.status(400).json({ message: 'sessionId is required' });
  }

  const session = await getSessionOwnedByUser(sessionId, req.user.id);
  if (!session) {
    return res.status(404).json({ message: 'Session not found for this user' });
  }

  const { data: attempts, error: attemptsError } = await supabase
    .from('emoanim_attempts')
    .select('*')
    .eq('session_id', session.id)
    .order('created_at', { ascending: true });

  if (attemptsError) {
    return res.status(500).json({ message: 'Failed to load attempts', error: attemptsError.message });
  }

  if (!attempts || attempts.length === 0) {
    return res.status(400).json({ message: 'Cannot close session without attempts' });
  }

  const child = await ensureChildOwnership(session.child_id, req.user.id);
  if (!child) {
    return res.status(404).json({ message: 'Child not found for this session' });
  }

  const features = computeSessionFeatures(attempts);
  const childAge = calculateAgeBand(child.date_of_birth);

  let normRow = null;
  if (childAge !== null) {
    const { data } = await supabase
      .from('emoanim_norms')
      .select('*')
      .lte('age_min', childAge)
      .gte('age_max', childAge)
      .eq('active', true)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();

    normRow = data || null;
  }

  const risk = inferRisk({ features, normRow });

  const endedAt = new Date().toISOString();

  const featuresRow = {
    session_id: session.id,
    total_attempts: features.totalAttempts,
    correct_attempts: features.correctAttempts,
    correct_answer_rate: features.correctAnswerRate,
    mean_response_time_ms: features.meanResponseTimeMs,
    mean_clip_duration_ms: features.meanClipDurationMs,
    absolute_response_time_ms: features.absoluteResponseTimeMs,
    level_reached: features.levelReached,
    max_score: features.maxScore,
    computed_at: endedAt,
  };

  const riskRow = {
    session_id: session.id,
    risk_level: risk.riskLevel,
    risk_score_01: risk.riskScore01,
    confidence: risk.confidence,
    method: risk.method,
    method_details: risk.methodDetails,
    norm_id: normRow ? normRow.id : null,
    evaluated_at: endedAt,
  };

  const { error: featuresError } = await supabase
    .from('emoanim_session_features')
    .upsert([featuresRow], { onConflict: 'session_id' });

  if (featuresError) {
    return res.status(500).json({ message: 'Failed to save computed features', error: featuresError.message });
  }

  const { error: riskError } = await supabase
    .from('emoanim_risk_results')
    .upsert([riskRow], { onConflict: 'session_id' });

  if (riskError) {
    return res.status(500).json({ message: 'Failed to save risk result', error: riskError.message });
  }

  const { error: closeError } = await supabase
    .from('emoanim_sessions')
    .update({ status: 'completed', ended_at: endedAt })
    .eq('id', session.id)
    .eq('user_id', req.user.id);

  if (closeError) {
    return res.status(500).json({ message: 'Failed to close session', error: closeError.message });
  }

  const warning = features.totalAttempts < MIN_ATTEMPTS_FOR_STABLE_SIGNAL
    ? `Low number of attempts (${features.totalAttempts}). Risk signal may be unstable.`
    : null;

  return res.status(200).json({
    sessionId: session.id,
    status: 'completed',
    metrics: {
      totalAttempts: features.totalAttempts,
      correctAnswerRate: features.correctAnswerRate,
      absoluteResponseTimeMs: features.absoluteResponseTimeMs,
      levelReached: features.levelReached,
      maxScore: features.maxScore,
    },
    risk: {
      level: risk.riskLevel,
      score01: risk.riskScore01,
      confidence: risk.confidence,
      method: risk.method,
      methodDetails: risk.methodDetails,
    },
    warning,
    clinicalDisclaimer: 'Screening support only. This is not a medical diagnosis.',
  });
}));

router.get('/result/:sessionId', protect, expressAsyncHandler(async (req, res) => {
  const { sessionId } = req.params;

  const session = await getSessionOwnedByUser(sessionId, req.user.id);
  if (!session) {
    return res.status(404).json({ message: 'Session not found for this user' });
  }

  const { data: features, error: featuresError } = await supabase
    .from('emoanim_session_features')
    .select('*')
    .eq('session_id', session.id)
    .maybeSingle();

  if (featuresError) {
    return res.status(500).json({ message: 'Failed to read features', error: featuresError.message });
  }

  const { data: risk, error: riskError } = await supabase
    .from('emoanim_risk_results')
    .select('*')
    .eq('session_id', session.id)
    .maybeSingle();

  if (riskError) {
    return res.status(500).json({ message: 'Failed to read risk result', error: riskError.message });
  }

  return res.status(200).json({
    session,
    metrics: features,
    risk,
    clinicalDisclaimer: 'Screening support only. This is not a medical diagnosis.',
  });
}));

module.exports = router;
