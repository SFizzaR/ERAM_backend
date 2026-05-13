/**
 * calculateAutismLevel.js
 * ───────────────────────
 * Calculates a child's overall autism level based on:
 * - Bubble Game Score (ATI: Autism Trait Index, 0-100)
 * - EmoAnim Risk Score (0-1)
 *
 * Formula: 0.5 * (bubbleScore/100) + 0.5 * emoanimScore
 * Result (0-1) is converted to percentage (0-100) for level determination:
 * - Low:  0-33   (level: 1)
 * - Mild: 34-66  (level: 2)
 * - High: 67-100 (level: 3)
 */

const supabase = require('../config/supabaseAdmin');

/**
 * Get the most recent bubble game score for a child
 * Prefers tap/touch mode over camera mode if both exist
 * @param {string} childId - The child's UUID
 * @returns {Promise<number|null>} - ATI score (0-100) or null if not found
 */
async function getLatestBubbleScore(childId) {
  try {
    // Get the most recent bubble/followdot session
    // Prefer assessment_mode = 'touch' over 'camera'
    const { data, error } = await supabase
      .from('followdot_sessions')
      .select('scores, assessment_mode, created_at')
      .eq('child_id', childId)
      .order('created_at', { ascending: false })
      .limit(10); // Get last 10 to check for tap vs camera

    if (error) {
      console.error('[calculateAutismLevel] Error fetching bubble scores:', error);
      return null;
    }

    if (!data || data.length === 0) {
      console.log('[calculateAutismLevel] No bubble game scores found for child:', childId);
      return null;
    }

    // Prefer 'touch' mode over 'camera'
    let selectedSession = null;
    for (const session of data) {
      if (session.assessment_mode === 'touch') {
        selectedSession = session;
        break;
      }
      if (!selectedSession) {
        selectedSession = session;
      }
    }

    if (!selectedSession || !selectedSession.scores) {
      return null;
    }

    // Extract the Autism Trait Index from the scores jsonb
    const scores = selectedSession.scores;
    const ati = scores?.autismTraitIndex ?? scores?.ati ?? null;

    if (typeof ati === 'number') {
      console.log('[calculateAutismLevel] Latest bubble ATI:', ati, 'Mode:', selectedSession.assessment_mode);
      return ati;
    }

    return null;
  } catch (error) {
    console.error('[calculateAutismLevel] Exception fetching bubble score:', error);
    return null;
  }
}

/**
 * Get the most recent EmoAnim risk score for a child
 * @param {string} childId - The child's UUID
 * @returns {Promise<number|null>} - Risk score (0-1) or null if not found
 */
async function getLatestEmoanimScore(childId) {
  try {
    // Get the most recent emoanim session and its risk result
    const { data: sessions, error: sessionError } = await supabase
      .from('emoanim_sessions')
      .select('id, created_at')
      .eq('child_id', childId)
      .eq('status', 'completed')
      .order('created_at', { ascending: false })
      .limit(1);

    if (sessionError) {
      console.error('[calculateAutismLevel] Error fetching emoanim sessions:', sessionError);
      return null;
    }

    if (!sessions || sessions.length === 0) {
      console.log('[calculateAutismLevel] No completed emoanim sessions found for child:', childId);
      return null;
    }

    const sessionId = sessions[0].id;

    // Get the risk result for this session
    const { data: riskResult, error: riskError } = await supabase
      .from('emoanim_risk_results')
      .select('risk_score_01')
      .eq('session_id', sessionId)
      .maybeSingle();

    if (riskError) {
      console.error('[calculateAutismLevel] Error fetching emoanim risk:', riskError);
      return null;
    }

    if (!riskResult) {
      return null;
    }

    const score = parseFloat(riskResult.risk_score_01);
    console.log('[calculateAutismLevel] Latest emoanim risk score:', score);
    return score;
  } catch (error) {
    console.error('[calculateAutismLevel] Exception fetching emoanim score:', error);
    return null;
  }
}

/**
 * Determine autism level based on combined score
 * @param {number} combinedScore - Value between 0 and 100
 * @returns {object} - { level: number (1|2|3), label: string }
 */
function determineLevel(combinedScore) {
  if (combinedScore <= 33) {
    return { level: 1, label: 'low' };
  } else if (combinedScore <= 66) {
    return { level: 2, label: 'mild' };
  } else {
    return { level: 3, label: 'high' };
  }
}

/**
 * Calculate child's autism level and update in database
 * @param {string} childId - The child's UUID
 * @param {string} userId - The user's UUID (parent/doctor)
 * @returns {Promise<object>} - { success: boolean, level: number, details: object }
 */
async function calculateAndUpdateAutismLevel(childId, userId) {
  try {
    console.log('[calculateAutismLevel] Starting calculation for child:', childId);

    // Verify child belongs to user
    const { data: child, error: childError } = await supabase
      .from('children')
      .select('id, user_id, name')
      .eq('id', childId)
      .eq('user_id', userId)
      .single();

    if (childError || !child) {
      console.error('[calculateAutismLevel] Child not found or not owned by user');
      return { success: false, error: 'Child not found' };
    }

    // Get latest scores
    const bubbleScore = await getLatestBubbleScore(childId);
    const emoanimScore = await getLatestEmoanimScore(childId);

    console.log('[calculateAutismLevel] Scores retrieved:', {
      bubbleScore,
      emoanimScore,
    });

    // Calculate combined score only if both scores exist
    let combinedScore = null;
    let levelInfo = null;

    if (bubbleScore !== null && emoanimScore !== null) {
      // Normalize bubble score to 0-1 range, then apply formula
      const bubbleScoreNormalized = bubbleScore / 100;
      combinedScore = (0.5 * bubbleScoreNormalized + 0.5 * emoanimScore) * 100;

      levelInfo = determineLevel(combinedScore);

      console.log('[calculateAutismLevel] Combined score calculation:', {
        bubbleScoreNormalized,
        emoanimScore,
        combinedScore: Math.round(combinedScore),
        level: levelInfo.level,
      });

      // Update child's level in database
      const { error: updateError } = await supabase
        .from('children')
        .update({ level: levelInfo.level })
        .eq('id', childId)
        .eq('user_id', userId);

      if (updateError) {
        console.error('[calculateAutismLevel] Failed to update child level:', updateError);
        return {
          success: false,
          error: 'Failed to update child level',
          details: {
            bubbleScore,
            emoanimScore,
            combinedScore: Math.round(combinedScore),
            level: levelInfo.level,
          },
        };
      }

      console.log(`[calculateAutismLevel] ✅ Successfully updated child ${child.name} to level ${levelInfo.level} (${levelInfo.label})`);

      return {
        success: true,
        level: levelInfo.level,
        details: {
          childId,
          childName: child.name,
          bubbleScore: Math.round(bubbleScore),
          emoanimScore: Math.round(emoanimScore * 100),
          combinedScore: Math.round(combinedScore),
          levelLabel: levelInfo.label,
        },
      };
    } else {
      console.log('[calculateAutismLevel] Cannot calculate level - missing scores', {
        hasBubbleScore: bubbleScore !== null,
        hasEmoanimScore: emoanimScore !== null,
      });

      return {
        success: false,
        error: 'Not enough data to calculate level',
        details: {
          hasBubbleScore: bubbleScore !== null,
          hasEmoanimScore: emoanimScore !== null,
        },
      };
    }
  } catch (error) {
    console.error('[calculateAutismLevel] Exception in calculateAndUpdateAutismLevel:', error);
    return { success: false, error: error.message };
  }
}

module.exports = {
  calculateAndUpdateAutismLevel,
  getLatestBubbleScore,
  getLatestEmoanimScore,
  determineLevel,
};
