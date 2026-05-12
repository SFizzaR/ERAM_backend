const expressAsyncHandler = require("express-async-handler");
const express = require('express');
const router = express.Router();
const supabase = require('../config/supabaseAdmin');

// Middleware to get user/child from JWT
const protectMiddleware = require('../middleware/protectMiddleware');

// Log a new trigger
router.post('/logTrigger', protectMiddleware, expressAsyncHandler(async (req, res) => {
    const { childId, reason, duration, severity = 'moderate', notes } = req.body;
    const userId = req.user?.id;

    if (!childId || !reason || !duration) {
        return res.status(400).json({ message: "Child ID, reason, and duration are required" });
    }

    if (duration < 1) {
        return res.status(400).json({ message: "Duration must be at least 1 minute" });
    }

    if (!['mild', 'moderate', 'severe'].includes(severity)) {
        return res.status(400).json({ message: "Invalid severity level" });
    }

    try {
        // Insert trigger record
        const { data, error } = await supabase
            .from('autism_triggers')
            .insert({
                user_id: userId,
                child_id: childId,
                trigger_reason: reason,
                duration_minutes: duration,
                severity_level: severity,
                notes: notes || null,
                logged_at: new Date().toISOString(),
            })
            .select();

        if (error) {
            return res.status(500).json({ message: "Failed to log trigger", error: error.message });
        }

        // Update stats (optional - can be done via trigger or scheduled job)
        // For now, we'll do a simple update
        const { data: existingStats } = await supabase
            .from('autism_triggers_stats')
            .select('*')
            .eq('child_id', childId)
            .single();

        const newTotal = (existingStats?.total_triggers || 0) + 1;

        if (existingStats) {
            await supabase
                .from('autism_triggers_stats')
                .update({ 
                    total_triggers: newTotal,
                    last_updated: new Date().toISOString()
                })
                .eq('child_id', childId);
        } else {
            await supabase
                .from('autism_triggers_stats')
                .insert({ 
                    child_id: childId,
                    total_triggers: 1,
                    triggers_this_week: 1,
                    triggers_this_month: 1,
                    avg_duration_minutes: duration,
                    most_common_reason: reason
                });
        }

        return res.json({ 
            message: "Trigger logged successfully", 
            data: data[0],
            totalTriggers: newTotal 
        });
    } catch (err) {
        console.error("Error logging trigger:", err);
        return res.status(500).json({ message: "Server error", error: err.message });
    }
}));

// Get triggers for a specific child
router.get('/getTriggers/:childId', protectMiddleware, expressAsyncHandler(async (req, res) => {
    const { childId } = req.params;
    const { limit = 100, offset = 0 } = req.query;

    try {
        const { data, error } = await supabase
            .from('autism_triggers')
            .select('*')
            .eq('child_id', childId)
            .order('logged_at', { ascending: false })
            .range(offset, offset + limit - 1);

        if (error) {
            return res.status(500).json({ message: "Failed to fetch triggers", error: error.message });
        }

        return res.json({ triggers: data || [], count: data?.length || 0 });
    } catch (err) {
        console.error("Error fetching triggers:", err);
        return res.status(500).json({ message: "Server error", error: err.message });
    }
}));

// Get trigger statistics for a child
router.get('/getTriggerStats/:childId', protectMiddleware, expressAsyncHandler(async (req, res) => {
    const { childId } = req.params;

    try {
        // Get all triggers
        const { data: triggers, error } = await supabase
            .from('autism_triggers')
            .select('*')
            .eq('child_id', childId)
            .order('logged_at', { ascending: false });

        if (error) {
            return res.status(500).json({ message: "Failed to fetch triggers", error: error.message });
        }

        if (!triggers || triggers.length === 0) {
            return res.json({
                totalTriggers: 0,
                triggersThisWeek: 0,
                triggersThisMonth: 0,
                avgDuration: 0,
                commonReasons: [],
                severityBreakdown: { mild: 0, moderate: 0, severe: 0 },
                triggers: []
            });
        }

        // Calculate statistics
        const now = new Date();
        const oneWeekAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
        const oneMonthAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);

        const triggersThisWeek = triggers.filter(t => new Date(t.logged_at) > oneWeekAgo).length;
        const triggersThisMonth = triggers.filter(t => new Date(t.logged_at) > oneMonthAgo).length;
        
        const avgDuration = triggers.reduce((sum, t) => sum + t.duration_minutes, 0) / triggers.length;

        // Count reasons
        const reasonCounts = {};
        triggers.forEach(t => {
            reasonCounts[t.trigger_reason] = (reasonCounts[t.trigger_reason] || 0) + 1;
        });

        const commonReasons = Object.entries(reasonCounts)
            .map(([reason, count]) => ({ reason, count }))
            .sort((a, b) => b.count - a.count)
            .slice(0, 5);

        // Severity breakdown
        const severityBreakdown = {
            mild: triggers.filter(t => t.severity_level === 'mild').length,
            moderate: triggers.filter(t => t.severity_level === 'moderate').length,
            severe: triggers.filter(t => t.severity_level === 'severe').length,
        };

        return res.json({
            totalTriggers: triggers.length,
            triggersThisWeek,
            triggersThisMonth,
            avgDuration: parseFloat(avgDuration.toFixed(1)),
            commonReasons,
            severityBreakdown,
            triggers: triggers.slice(0, 50) // Return last 50 for display
        });
    } catch (err) {
        console.error("Error fetching trigger stats:", err);
        return res.status(500).json({ message: "Server error", error: err.message });
    }
}));

// Delete a trigger
router.delete('/deleteTrigger/:triggerId', protectMiddleware, expressAsyncHandler(async (req, res) => {
    const { triggerId } = req.params;
    const userId = req.user?.id;

    try {
        // Verify ownership
        const { data: trigger } = await supabase
            .from('autism_triggers')
            .select('*')
            .eq('id', triggerId)
            .eq('user_id', userId)
            .single();

        if (!trigger) {
            return res.status(404).json({ message: "Trigger not found or unauthorized" });
        }

        const { error } = await supabase
            .from('autism_triggers')
            .delete()
            .eq('id', triggerId);

        if (error) {
            return res.status(500).json({ message: "Failed to delete trigger", error: error.message });
        }

        return res.json({ message: "Trigger deleted successfully" });
    } catch (err) {
        console.error("Error deleting trigger:", err);
        return res.status(500).json({ message: "Server error", error: err.message });
    }
}));

module.exports = router;
