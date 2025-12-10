const { Router } = require('express');
const { supabase } = require('../lib/supabase');
const { protect } = require('../middleware/protectMiddleware');
const User = require('../models/userModel');
const { filterContent } = require('../utils/contentFilter');

const router = Router();
router.use(protect); // All routes require logged-in user

const getUserId = (req) => req.user._id.toString();
// When a post/comment receives this many reports it will be auto-deleted
const REPORT_DELETE_THRESHOLD = 5;

// ==================== CREATE POST ====================
router.post('/posts', async (req, res) => {
  const { title, content, category, media_urls = [], is_anonymous = false, post_type, feed_type } = req.body;  // UPDATED: Add feed_type
  const userId = req.auth.userId;
  const currentCity = req.user.current_city?.trim();  // NEW: Get from Mongo user

  // Validate post_type
  const validTypes = ['query', 'insight'];
  if (post_type && !validTypes.includes(post_type)) {
    return res.status(400).json({ error: 'Invalid post_type. Must be "query" or "insight"' });
  }

  // NEW: Validate feed_type
  const validFeeds = ['global', 'city'];
  if (!validFeeds.includes(feed_type)) {
    return res.status(400).json({ error: 'Invalid feed_type. Must be "global" or "city"' });
  }
  if (feed_type === 'city' && !currentCity) {
    return res.status(400).json({ error: 'City required for city feed posts. Set your city in profile.' });
  }

  const tags = Array.isArray(req.body.tags) 
  ? req.body.tags.join(',') 
  : req.body.category || req.body.tags || ''; // send tags as comma-separated string or array → send category

  const titleCheck = filterContent(title);
  const contentCheck = filterContent(content);

  if (titleCheck.blocked || contentCheck.blocked) {
    return res.status(400).json({
      error: 'Post blocked',
      reason: titleCheck.reason || contentCheck.reason
    });
  }

  const { data, error } = await supabase
    .from('posts')
    .insert({ 
      user_id: userId, 
      title, 
      content, 
      category: tags, 
      media_urls, 
      is_anonymous, 
      post_type,
      feed_type,  // NEW
      city: feed_type === 'city' ? currentCity : null  // NEW: Store city for filtering
    })
    .select()
    .single();

  if (error) return res.status(400).json({ error: error.message });
  res.status(201).json(data);
});

async function enrichPosts(posts, userId) {
  const uniqueUserIds = [...new Set(posts.map(p => p.user_id))];
  const { data: profiles } = await supabase
    .from('profiles')
    .select('id, username, current_city')
    .in('id', uniqueUserIds);

  const profileMap = new Map(profiles.map(p => [p.id, p]));

  // Fallback to MongoDB if profile missing (rare)
  const missingUids = uniqueUserIds.filter(uid => !profileMap.has(uid));
  if (missingUids.length) {
    const mongoUsers = await User.find({ supabase_uid: { $in: missingUids } });
    mongoUsers.forEach(u => profileMap.set(u.supabase_uid, { username: u.username, current_city: u.current_city }));
  }

  return await Promise.all(
    posts.map(async (post) => {
      const profile = profileMap.get(post.user_id) || {};

      // Get reactions summary
      const { data: reactionsData } = await supabase
        .from('post_reactions')
        .select('reaction_type')
        .eq('post_id', post.id);

      const reactionCounts = {
        like: 0,
        support: 0,
        celebrate: 0,
        love: 0,
        insightful: 0
      };

      const now = new Date();
const createdAt = new Date(post.created_at);
const diffMs = now - createdAt;
const timeRemaining = Math.max(0, 15 * 60 * 1000 - diffMs); // 15 minutes in ms

      reactionsData.forEach(r => reactionCounts[r.reaction_type]++);

      const totalReactions = reactionsData.length;

      // Get user's reactions
      const { data: myReactionsData } = await supabase
        .from('post_reactions')
        .select('reaction_type')
        .eq('post_id', post.id)
        .eq('user_id', userId);

      const myReactions = myReactionsData.map(r => r.reaction_type);

      // Get comment count
      const { count: commentCount } = await supabase
        .from('comments')
        .select('*', { count: 'exact', head: true })
        .eq('post_id', post.id);

              console.log('post.user_id:', post.user_id, 'userId:', userId, 'isOwnPost:', post.user_id === userId);


      return {
        ...post,
        username: post.is_anonymous ? 'Anonymous' : profile.username || 'Unknown',
        city: post.is_anonymous ? null : post.city || profile.current_city,  // UPDATED: Prefer post.city
        reaction_counts: reactionCounts,
        total_reactions: totalReactions,
        my_reactions: myReactions,
        comment_count: commentCount || 0,
isOwnPost: post.user_id === userId,
timeRemaining: post.user_id === userId ? timeRemaining : 0,
canEditUndoDelete: post.user_id === userId && timeRemaining > 0,
        
      };

    })
  );
}

// GLOBAL FEED – FIXED
router.get('/feed/global', async (req, res) => {
  const { category, page = 1 } = req.query;
  const limit = 20;
  const from = (page - 1) * limit;
  const userId = req.auth.userId;

  try {
    const { data: userReported } = await supabase
      .from('reports')
      .select('post_id')
      .eq('reporter_id', userId)
      .eq('target_type', 'post');

    const reportedIds = (userReported || []).map(r => r.post_id).filter(Boolean);

    let query = supabase
      .from('posts')
      .select('id, title, content, category, media_urls, created_at, updated_at, user_id, is_anonymous, post_type, city, feed_type')
      .eq('feed_type', 'global')
      .eq('is_deleted', false)
      .order('created_at', { ascending: false })
      .range(from, from + limit - 1);

    if (reportedIds.length > 0) {
      query = query.not('id', 'in', `(${reportedIds.join(',')})`);
    }
    if (category && category !== 'all') {
      query = query.eq('category', category);
    }

    const { data: posts, error, count } = await query;
    if (error) throw error;

    const enrichedPosts = await enrichPosts(posts, userId);

    res.json({
      posts: enrichedPosts,
      hasMore: posts.length === limit,
      total: count || posts.length
    });
  } catch (err) {
    console.error('Global feed error:', err);
    res.status(500).json({ error: err.message });
  }
});

// CITY FEED – FIXED
router.get('/feed/city', async (req, res) => {
  const currentCity = req.user.current_city?.trim();
  if (!currentCity) return res.status(400).json({ error: 'Please set your city in profile first' });

  const { category, page = 1 } = req.query;
  const limit = 20;
  const from = (page - 1) * limit;
  const userId = req.auth.userId;

  try {
    const { data: userReported } = await supabase
      .from('reports')
      .select('post_id')
      .eq('reporter_id', userId)
      .eq('target_type', 'post');

    const reportedIds = (userReported || []).map(r => r.post_id).filter(Boolean);

    let query = supabase
      .from('posts')
      .select('id, title, content, category, media_urls, created_at, updated_at, user_id, is_anonymous, post_type, city, feed_type')
      .eq('feed_type', 'city')
      .eq('is_deleted', false)
      .eq('city', currentCity)
      .order('created_at', { ascending: false })
      .range(from, from + limit - 1);

    if (reportedIds.length > 0) {
      query = query.not('id', 'in', `(${reportedIds.join(',')})`);
    }
    if (category && category !== 'all') {
      query = query.eq('category', category);
    }

    const { data: posts, error, count } = await query;
    if (error) throw error;

    const enrichedPosts = await enrichPosts(posts, userId);

    res.json({
      posts: enrichedPosts,
      hasMore: posts.length === limit,
      total: count || posts.length
    });
  } catch (err) {
    console.error('City feed error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ==================== React POST ====================
router.post('/posts/:id/react', async (req, res) => {
  const postId = req.params.id;
  const userId = req.auth.userId;
  const { reaction } = req.body; // "like" | "support" | "celebrate" | "love" | "insightful"
  // Normalize reaction values to canonical set (accept legacy values)
  const normalize = (r) => {
    if (!r) return null;
    if (r === 'heart' || r === 'care') return 'love';
    return r;
  };

  const canonical = normalize(reaction);
  const validReactions = ['like', 'support', 'celebrate', 'love', 'insightful'];
  if (canonical && !validReactions.includes(canonical)) {
    return res.status(400).json({ error: 'Invalid reaction' });
  }

  try {
    // Check existing reaction by this user for the post
    const { data: existingList, error: existingErr } = await supabase
      .from('post_reactions')
      .select('id, reaction_type')
      .eq('post_id', postId)
      .eq('user_id', userId)
      .limit(1);

    if (existingErr) throw existingErr;

    const existing = existingList && existingList.length ? existingList[0] : null;

    let reacted = false;

    if (!canonical) {
      // Explicit remove request: delete any existing reaction
      if (existing) {
        await supabase.from('post_reactions').delete().eq('id', existing.id);
      }
      reacted = false;
    } else {
      if (existing) {
        if (existing.reaction_type === canonical) {
          // same reaction -> toggle off
          await supabase.from('post_reactions').delete().eq('id', existing.id);
          reacted = false;
        } else {
          // different reaction -> update the existing row to the new type
          await supabase.from('post_reactions').update({ reaction_type: canonical }).eq('id', existing.id);
          reacted = true;
        }
      } else {
        // insert new reaction
        await supabase.from('post_reactions').insert({ post_id: postId, user_id: userId, reaction_type: canonical });
        reacted = true;
      }
    }

    // Compute authoritative counts and user's current reaction
    const { data: allReactions } = await supabase
      .from('post_reactions')
      .select('reaction_type, user_id')
      .eq('post_id', postId);

    const summary = { like: 0, support: 0, celebrate: 0, love: 0, insightful: 0 };
    let myReaction = null;
    (allReactions || []).forEach(r => {
      if (summary[r.reaction_type] !== undefined) summary[r.reaction_type]++;
      if (r.user_id === userId) myReaction = r.reaction_type;
    });

    // Notify post owner if a reaction was added (not on unreact or change)
    if (reacted && canonical) {
      try {
        const { data: post } = await supabase.from('posts').select('user_id').eq('id', postId).single();
        if (post && post.user_id && post.user_id !== userId) {
          const { error: notifError } = await supabase
  .from('notifications')
  .insert({
    user_id: post.user_id,
    type: 'reaction',
    post_id: postId,
    trigger_user_id: userId,
    read: false
  });

if (notifError) {
  console.error('Failed to insert reaction notification:', notifError);
} else {
  console.log('Reaction notification successfully inserted for user:', post.user_id);
}
        }
      } catch (notifErr) {
        console.error('Failed to insert reaction notification:', notifErr);
      }
    }

    return res.json({ reacted, reaction: canonical, counts: summary, total: (allReactions || []).length, my_reaction: myReaction });
  } catch (err) {
    console.error('React error:', err);
    return res.status(500).json({ error: err.message || 'Server error' });
  }
});

router.get('/posts/:id/reactions', async (req, res) => {
  const postId = req.params.id;
  const userId = req.auth.userId;

  const { data } = await supabase
    .from('post_reactions')
    .select('reaction_type, user_id')
    .eq('post_id', postId);

  const summary = {
    like: 0,
    support: 0,
    celebrate: 0,
    love: 0,
    insightful: 0
  };

  const userReactions = [];

  data?.forEach(r => {
    summary[r.reaction_type]++;
    if (r.user_id === userId) userReactions.push(r.reaction_type);
  });

  res.json({
    counts: summary,
    total: data?.length || 0,
    my_reactions: userReactions
  });
});

// ==================== ADD COMMENT ====================
router.post('/posts/:id/comments', async (req, res) => {
  const { content, parent_id } = req.body;
  const postId = req.params.id;
  const userId = req.auth.userId;

  const check = filterContent(content);
  if (check.blocked) {
    return res.status(400).json({
      error: 'Comment blocked',
      reason: check.reason
    });
  }

  console.log('POST /posts/' + postId + '/comments payload:', { content, parent_id, userId });

  const { data, error } = await supabase
    .from('comments')
    .insert({
      post_id: postId,
      user_id: userId,
      parent_id: parent_id || null,
      content
    })
    .select()
    .single();

  console.log('Inserted comment row:', data, 'error:', error);

  if (error) return res.status(400).json({ error: error.message });
  const { data: post } = await supabase.from('posts').select('user_id').eq('id', postId).single();
  
  console.log('Post data:', post, 'Commenter userId:', userId, 'parent_id:', parent_id);

  

  // Notify parent comment owner if this comment is a reply to another comment
  if (parent_id) {
    const { data: parentComment, error: parentError } = await supabase
      .from('comments')
      .select('user_id')
      .eq('id', parent_id)
      .single();

    if (parentError) {
      console.error('Failed to fetch parent comment:', parentError);
    } else if (parentComment && parentComment.user_id !== userId) {
      const { error: notifyError } = await supabase
        .from('notifications')
        .insert({
          user_id: parentComment.user_id,
          type: 'comment_reply',
          post_id: postId,
          comment_id: data.id,  // ← fixed: was newComment.id
          trigger_user_id: userId,
          message: 'replied to your comment',
          read: false
        });

      if (notifyError) {
        console.error('Failed to notify parent comment owner:', notifyError);
      } else {
        console.log('Reply notification sent to parent comment owner:', parentComment.user_id);
      }
    }
  }

  // Also notify the post owner (if different from commenter and parent comment owner)
    try {
    const postOwnerId = post?.user_id;
    let parentOwnerId = null;
    if (parent_id) {
      const { data: parentData } = await supabase
        .from('comments')
        .select('user_id')
        .eq('id', parent_id)
        .single();
      parentOwnerId = parentData?.user_id || null;
    }

    if (postOwnerId && postOwnerId !== userId && postOwnerId !== parentOwnerId) {
      console.log('Creating notification for post owner:', postOwnerId);
      const { error: postNotifErr } = await supabase
        .from('notifications')
        .insert({
          user_id: postOwnerId,
          type: 'reply',
          post_id: postId,
          comment_id: data.id,  // ← fixed
          trigger_user_id: userId,
          read: false
        });

      if (postNotifErr) {
        console.error('Failed to notify post owner:', postNotifErr);
      } else {
        console.log('Post owner notification created successfully');
      }
    }
  } catch (e) {
    console.error('Unexpected error notifying post owner:', e);
  }


  res.status(201).json(data);
});

// ==================== GET NOTIFICATIONS ====================
router.get('/notifications', async (req, res) => {
  const userId = req.auth.userId;

  try {
    console.log('GET /notifications for userId:', userId);
    
    const { data, error } = await supabase
      .from('notifications')
      .select(`
        id,
        type,
        post_id,
        comment_id,
        trigger_user_id,
        read,
        created_at,
        posts (
          title,
          category
        )
      `)
      .eq('user_id', userId)
      .order('created_at', { ascending: false });

    if (error) throw error;

    // Fetch trigger user profiles for all notifications
    const triggerUserIds = [...new Set(data.map(n => n.trigger_user_id))];
    let userProfiles = {};
    
    if (triggerUserIds.length > 0) {
      const { data: profiles } = await supabase
        .from('profiles')
        .select('id, username')
        .in('id', triggerUserIds);
      
      userProfiles = Object.fromEntries((profiles || []).map(p => [p.id, p.username]));
    }

    // Enrich notifications with usernames
      let enrichedData = data.map(n => ({
        ...n,
        trigger_username: userProfiles[n.trigger_user_id] || 'Unknown'
      }));

      // For reaction notifications, try to derive the reaction string from post_reactions
      try {
        const reactionNotifs = enrichedData.filter(n => n.type === 'reaction' && n.post_id && n.trigger_user_id);
        if (reactionNotifs.length) {
          const postIds = [...new Set(reactionNotifs.map(n => n.post_id))];
          const triggerIds = [...new Set(reactionNotifs.map(n => n.trigger_user_id))];

          const { data: reactionsData } = await supabase
            .from('post_reactions')
            .select('post_id, user_id, reaction_type')
            .in('post_id', postIds)
            .in('user_id', triggerIds);

          const reactionMap = {};
          (reactionsData || []).forEach(r => {
            reactionMap[`${r.post_id}_${r.user_id}`] = r.reaction_type;
          });

          enrichedData = enrichedData.map(n => {
            if (n.type === 'reaction') {
              const key = `${n.post_id}_${n.trigger_user_id}`;
              const reaction = reactionMap[key];
              return { ...n, message: reaction || null };
            }
            return n;
          });
        }
      } catch (e) {
        console.error('Failed to enrich reaction notifications with reaction_type:', e);
      }

    console.log('Notifications retrieved:', enrichedData);
    res.json({ notifications: enrichedData });

  } catch (err) {
    console.error("Notifications error:", err);
    res.status(500).json({ error: err.message });
  }
});

// ==================== MARK NOTIFICATIONS READ ====================
router.patch('/notifications/read', async (req, res) => {
  const userId = req.auth.userId;
  await supabase.from('notifications').update({ read: true }).eq('user_id', userId);
  res.json({ success: true });
});

// ==================== SAVE / BOOKMARK POST (TOGGLE) ====================
router.post('/posts/:id/saveBookmark', async (req, res) => {
  const postId = req.params.id;
  const userId = req.auth.userId;

  const { data: existing } = await supabase
    .from('saved_posts')
    .select()
    .eq('post_id', postId)
    .eq('user_id', userId)
    .single();

  if (existing) {
    
    await supabase.from('saved_posts').delete().match({ post_id: postId, user_id: userId });
    res.json({ saved: false });
  } else {
    await supabase.from('saved_posts').insert({ post_id: postId, user_id: userId });
    res.json({ saved: true });
  }
});

// ==================== DELETE OWN POST ====================
router.delete('/posts/:id', async (req, res) => {
  const postId = req.params.id;
  const userId = req.auth.userId;

  try {
    // Soft delete: only allow if user owns the post
    const { data: post, error } = await supabase
      .from('posts')
      .update({
        is_deleted: true,
        deleted_at: new Date().toISOString(),
        title: '[This post was deleted]',
        content: '[This post was removed by the author]',
        media_urls: [], // optional: clear media
      })
      .eq('id', postId)
      .eq('user_id', userId)
      .select()
      .single();

    if (error || !post) {
      return res.status(404).json({ error: 'Post not found or not owned by you' });
    }

    res.json({ success: true, message: 'Post deleted' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to delete post' });
  }
});

// ==================== DELETE OWN COMMENT ====================
router.delete('/comments/:id', async (req, res) => {
  const commentId = req.params.id;
  const userId = req.auth.userId;

  const { data: comment } = await supabase
    .from('comments')
    .select('user_id')
    .eq('id', commentId)
    .single();

  if (!comment || comment.user_id !== userId) {
    return res.status(403).json({ error: 'You can only delete your own comment' });
  }

  const { error } = await supabase.from('comments').delete().eq('id', commentId);

  if (error) return res.status(400).json({ error: error.message });
  res.json({ success: true });
});

// ==================== REPORT POST OR COMMENT ====================
router.post('/reports', async (req, res) => {
  const { target_type, target_id, reason } = req.body;
  const userId = req.auth.userId;

  if (!['post', 'comment'].includes(target_type) || !target_id || !reason) {
    return res.status(400).json({ error: 'Invalid report: need target_type (post/comment), target_id, reason' });
  }

  const { data, error } = await supabase
    .from('reports')
    .insert({
      [target_type + '_id']: target_id,  // e.g. post_id or comment_id
      reporter_id: userId,
      reason
    })
    .select()
    .single();

  if (error) return res.status(400).json({ error: error.message });

  // After inserting the report, count total reports for this target
  const reportColumn = target_type === 'post' ? 'post_id' : 'comment_id';
  const { count: totalReports } = await supabase
    .from('reports')
    .select('*', { count: 'exact', head: true })
    .eq(reportColumn, target_id);

  let deleted = false;
  try {
    if ((totalReports || 0) >= REPORT_DELETE_THRESHOLD) {
      // Auto-delete target when threshold is reached
      if (target_type === 'post') {
        await supabase.from('posts').delete().eq('id', target_id);
        deleted = true;
      } else {
        await supabase.from('comments').delete().eq('id', target_id);
        deleted = true;
      }
    }
  } catch (delErr) {
    console.error('Auto-delete error for reported target:', delErr);
  }

  res.status(201).json({ ...data, total_reports: totalReports || 0, deleted });
});

// ==================== GET ALL SAVED POSTS ====================
router.get('/saved', async (req, res) => {
  const userId = req.auth.userId;
  const page = parseInt(req.query.page) || 1;
  const limit = 20;
  const from = (page - 1) * limit;
  const to = from + limit - 1;

  try {
    const { data: savedItems, error: savedError, count } = await supabase
      .from('saved_posts')
      .select('post_id, created_at', { count: 'exact' })  // count works now
      .eq('user_id', userId)
      .order('created_at', { ascending: false })
      .range(from, to);

    if (savedError) throw savedError;
    if (!savedItems?.length) {
      return res.json({ savedPosts: [], total: 0 });
    }

    const postIds = savedItems.map(s => s.post_id);

    const { data: posts } = await supabase
      .from('posts')
      .select('id, title, content, category, media_urls, created_at, updated_at, user_id')
      .eq('is_deleted', false)
      .in('id', postIds);
      

    const enriched = await Promise.all(
      posts.map(async (post) => {
        // Get reactions summary
        const { data: reactionsData } = await supabase
          .from('post_reactions')
          .select('reaction_type')
          .eq('post_id', post.id);

        const reactionCounts = {
          like: 0,
          support: 0,
          celebrate: 0,
          love: 0,
          insightful: 0
        };

        reactionsData.forEach(r => reactionCounts[r.reaction_type]++);

        const totalReactions = reactionsData.length;

        // Get user's reactions
        const { data: myReactionsData } = await supabase
          .from('post_reactions')
          .select('reaction_type')
          .eq('post_id', post.id)
          .eq('user_id', userId);

        const myReactions = myReactionsData.map(r => r.reaction_type);

        // Get comment count
        const { count: commentCount } = await supabase
          .from('comments')
          .select('*', { count: 'exact', head: true })
          .eq('post_id', post.id);

        return {
          ...post,
          reaction_counts: reactionCounts,
          total_reactions: totalReactions,
          my_reactions: myReactions,
          comment_count: commentCount || 0,
          saved_at: savedItems.find(s => s.post_id === post.id)?.created_at
        };
      })
    );

    const ordered = savedItems
      .map(s => enriched.find(p => p.id === s.post_id))
      .filter(Boolean);

    res.json({
      savedPosts: ordered,
      total: count || savedItems.length
    });

  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// ==================== LIKE / UNLIKE COMMENT ====================
router.post('/comments/:id/like', async (req, res) => {
  const commentId = req.params.id;
  const userId = req.auth.userId;

  // Check if already liked
  const { data: existingList, error: existingErr } = await supabase
    .from('comment_likes')
    .select('comment_id, user_id')
    .eq('comment_id', commentId)
    .eq('user_id', userId)
    .limit(1);

  if (existingErr) {
    console.error('Like check error:', existingErr);
    return res.status(500).json({ error: existingErr.message || 'DB error' });
  }

  const existing = existingList && existingList.length ? existingList[0] : null;

  if (existing) {
    // Unlike (delete any matching rows to be safe)
    await supabase.from('comment_likes').delete().match({ comment_id: commentId, user_id: userId });
    // Return authoritative counts for the comment after unlike
    const { count } = await supabase
      .from('comment_likes')
      .select('*', { count: 'exact', head: true })
      .eq('comment_id', commentId);

    return res.json({ liked: false, total_likes: count || 0, is_liked_by_me: false });
  } else {
    // Like
    await supabase.from('comment_likes').insert({
      comment_id: commentId,
      user_id: userId
    });

    // Return authoritative counts for the comment after like
    const { count } = await supabase
      .from('comment_likes')
      .select('*', { count: 'exact', head: true })
      .eq('comment_id', commentId);

    // Notify comment owner (if not self-like)
    try {
      const { data: comment } = await supabase
        .from('comments')
        .select('user_id')
        .eq('id', commentId)
        .single();

      if (comment && comment.user_id !== userId) {
        await supabase.from('notifications').insert({
          user_id: comment.user_id,
          type: 'comment_like',
          comment_id: commentId,
          trigger_user_id: userId
        });
      }
    } catch (notifErr) {
      console.error('Failed to insert comment-like notification:', notifErr);
    }

    return res.json({ liked: true, total_likes: count || 0, is_liked_by_me: true });
  }
});

router.get('/comments/:id/likes', async (req, res) => {
  const commentId = req.params.id;
  const userId = req.auth.userId;

  const { count } = await supabase
    .from('comment_likes')
    .select('*', { count: 'exact', head: true })
    .eq('comment_id', commentId);

  const { data: myLike } = await supabase
    .from('comment_likes')
    .select('user_id')
    .eq('comment_id', commentId)
    .eq('user_id', userId)
    .limit(1);

  res.json({
    total_likes: count || 0,
    is_liked_by_me: !!myLike?.length
  });
});

router.get('/posts/:id/comments', async (req, res) => {
  const postId = req.params.id;
  const userId = req.auth.userId;

  try {
    const { data: comments, error } = await supabase
      .from('comments')
      .select(`
        id,
        content,
        created_at,
        user_id,
        parent_id,
        post_id
      `)
      .eq('post_id', postId)
      .order('created_at', { ascending: true });

    if (error) throw error;

    // Get usernames
    const userIds = [...new Set(comments.map(c => c.user_id))];
    const { data: profiles } = await supabase
      .from('profiles')
      .select('id, username')
      .in('id', userIds);

    const profileMap = Object.fromEntries(profiles.map(p => [p.id, p.username]));

    // Fetch likes for all comments in this post so we can return counts and whether the
    // current user has liked each comment. This keeps the frontend in sync without
    // extra round-trips.
    const commentIds = comments.map(c => c.id);
    let likesData = [];
    if (commentIds.length) {
      const { data: ld } = await supabase
        .from('comment_likes')
        .select('comment_id, user_id')
        .in('comment_id', commentIds);
      likesData = ld || [];
    }

    const likesCountMap = {};
    const userLikedSet = new Set();
    likesData.forEach(l => {
      likesCountMap[l.comment_id] = (likesCountMap[l.comment_id] || 0) + 1;
      if (l.user_id === userId) userLikedSet.add(l.comment_id);
    });
    // Build threaded structure
    const commentMap = new Map();
    const rootComments = [];

    comments.forEach(comment => {
      const enriched = {
        id: comment.id,
        content: comment.content,
        author: profileMap[comment.user_id] || 'Anonymous',
        timestamp: comment.created_at,
        // Return authoritative like counts and whether current user liked
        total_likes: likesCountMap[comment.id] || 0,
        is_liked_by_me: !!userLikedSet.has(comment.id),
        replies: [],
        isOwnComment: comment.user_id === userId,
      };

      commentMap.set(comment.id, enriched);

      if (!comment.parent_id) {
        rootComments.push(enriched);
      } else {
        const parent = commentMap.get(comment.parent_id);
        if (parent) parent.replies.push(enriched);
      }
    });

    res.json({ comments: rootComments });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;