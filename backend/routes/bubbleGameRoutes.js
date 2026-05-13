/**
 * bubbleGameRoutes.js
 * -------------------
 * Routes for the Bubble-Game gaze-attention screening.
 *
 * POST /bubble-game/analyze-frame
 *   Forwards a base64 camera frame + trial metadata to the Python CV service
 *   (bubble-cv, running on port 8001).  Returns gaze analysis result.
 *   Fails gracefully if the CV service is offline.
 *
 * POST /bubble-game/score
 *   Scores a completed session from roundEvents + gazeSamples.
 *   Re-uses the existing followDotScoring utility.
 */

const express = require('express');
const expressAsyncHandler = require('express-async-handler');
const axios = require('axios');

const { protect } = require('../middleware/protectMiddleware');
const { scoreFollowDotSession } = require('../utils/followDotScoring');
const { saveFollowDotSession } = require('../utils/followDotPersistence');

const { calculateAndUpdateAutismLevel } = require('../utils/calculateAutismLevel');

const router = express.Router();

// Python CV service base URL — override with CV_SERVICE_URL env var when deployed
const CV_SERVICE_URL = process.env.CV_SERVICE_URL || 'http://localhost:8001';

// ── POST /bubble-game/analyze-frame ──────────────────────────────────────────
router.post(
  '/analyze-frame',
  protect,
  expressAsyncHandler(async (req, res) => {
    const {
      frameBase64,
      timestampMs,
      trialType,
      phaseId,
      trialNumber,
      screenWidth,
      screenHeight,
      bubblePositions,
    } = req.body;

    if (!frameBase64) {
      return res.status(400).json({ message: 'frameBase64 is required.' });
    }

    try {
      const cvRes = await axios.post(
        `${CV_SERVICE_URL}/analyze-frame`,
        {
          frameBase64,
          timestampMs: timestampMs ?? 0,
          trialType: trialType ?? 'pattern',
          phaseId: phaseId ?? 'phase-1',
          trialNumber: trialNumber ?? 1,
          screenWidth: screenWidth ?? 390,
          screenHeight: screenHeight ?? 844,
          bubblePositions: bubblePositions ?? [],
        },
        { timeout: 8000 },
      );

      return res.status(200).json(cvRes.data);
    } catch (err) {
      // CV service is optional — if it's down, return a graceful no-face result
      // so the frontend can continue without crashing.
      const isUnavailable =
        err.code === 'ECONNREFUSED' ||
        err.code === 'ECONNRESET' ||
        err.code === 'ERR_NETWORK' ||
        (err.response?.status >= 500);

      if (isUnavailable) {
        return res.status(200).json({
          faceDetected: false,
          confidence: 0,
          gazeX: null,
          gazeY: null,
          gazeDirection: null,
          attentionTarget: null,
          headPoseYaw: null,
          headPosePitch: null,
          _cvServiceOffline: true,
        });
      }

      // Unexpected error — surface it
      const msg = err.response?.data?.detail || err.message || 'CV service error';
      return res.status(502).json({ message: msg });
    }
  }),
);

// ── POST /bubble-game/score ──────────────────────────────────────────────────
router.post(
  '/score',
  protect,
  expressAsyncHandler(async (req, res) => {
    const { childId, childAge, roundEvents, gazeSamples, metadata } = req.body;

    if (!Array.isArray(roundEvents) && !Array.isArray(gazeSamples)) {
      return res.status(400).json({
        message: 'Provide roundEvents or gazeSamples for scoring.',
      });
    }

    const scoring = scoreFollowDotSession({ roundEvents, gazeSamples });

    const warnings = [];
    if (scoring.measurementMode === 'interaction_proxy') {
      warnings.push(
        'Interaction-proxy mode used (touch data only). Run with CV service for gaze-based scoring.',
      );
    }
    if (scoring.sampleSize < 6) {
      warnings.push('Low sample size — more rounds improve estimate stability.');
    }

    const responseBody = {
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
        source: metadata?.source || 'bubble-game',
        appVersion: metadata?.appVersion || null,
      },
      clinicalDisclaimer: scoring.disclaimer,
    };

    try {
      await saveFollowDotSession({
        userId: req.user?.id,
        childId: childId || null,
        assessmentMode: metadata?.assessmentMode || null,
        measurementMode: scoring.measurementMode,
        roundEvents,
        gazeSamples,
        scores: scoring.scores,
        ratios: scoring.ratios,
        timing: scoring.timing,
        totals: scoring.totals,
        interpretation: scoring.interpretation,
        warnings,
        metadata: responseBody.metadata,
        sourceRoute: '/bubble-game/score',
      });
    } catch (saveError) {
      console.error('Failed to save bubble-game session:', saveError);
    }

    // Calculate and update child's autism level (if user is available)
    if (childId && req.user?.id) {
      try {
        const levelResult = await calculateAndUpdateAutismLevel(childId, req.user.id);
        console.log('[bubbleGameRoutes] Level calculation result:', levelResult);
        // Add the result to response but don't let errors interrupt the score response
        responseBody.levelCalculation = levelResult;
      } catch (levelError) {
        console.error('[bubbleGameRoutes] Error calculating autism level:', levelError);
        // Don't let level calculation errors break the main response
      }
    }

    return res.status(200).json(responseBody);
  }),
);

// ── POST /bubble-game/calculate-level ────────────────────────────────────────
// Endpoint to manually recalculate and update a child's autism level
router.post(
  '/calculate-level',
  protect,
  expressAsyncHandler(async (req, res) => {
    const { childId } = req.body;

    if (!childId) {
      return res.status(400).json({ message: 'childId is required' });
    }

    try {
      const result = await calculateAndUpdateAutismLevel(childId, req.user.id);

      if (result.success) {
        return res.status(200).json({
          message: 'Autism level calculated and updated successfully',
          ...result,
        });
      } else {
        return res.status(400).json({
          message: result.error || 'Failed to calculate autism level',
          ...result,
        });
      }
    } catch (error) {
      return res.status(500).json({
        message: 'Error calculating autism level',
        error: error.message,
      });
    }
  }),
);

module.exports = router;
