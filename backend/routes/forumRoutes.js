// routes/forumRoutes.js
const { Router } = require('express');
const { supabase } = require('../lib/supabase');
const { protect } = require('../middleware/protectMiddleware');

const router = Router();
router.use(protect); // All routes require logged-in user

// Helper: Get MongoDB user + Supabase user sync (optional)
const getUserId = (req) => req.user._id.toString();

// ==================== CREATE POST ====================
router.post('/posts', async (req, res) => {
  const { title, content, category, media_urls = [] } = req.body;
  const userId = req.auth.userId; // from protect middleware (Supabase UID)

  const { data, error } = await supabase
    .from('posts')
    .insert({ user_id: userId, title, content, category, media_urls })
    .select()
    .single();

  if (error) return res.status(400).json({ error: error.message });
  res.status(201).json(data);
});

// ==================== GET FEED (with filters) ====================
// GET /api/forum/feed
router.get('/feed', async (req, res) => {
  const { category, sort = 'recent', page = 1 } = req.query;
  const limit = 20;
  const rangeFrom = (page - 1) * limit;
  const rangeTo = rangeFrom + limit - 1;
  const userId = req.auth.userId; // current logged-in user

  try {
    // Base query — get posts with basic fields
    let query = supabase
      .from('posts')
      .select(`
        id,
        title,
        content,
        category,
        media_urls,
        created_at,
        updated_at,
        user_id
      `)
      .range(rangeFrom, rangeTo);

    // Filter by category
    if (category && category !== 'all') {
      query = query.eq('category', category);
    }

    // Sorting
    if (sort === 'top') {
      query = query.order('created_at', { ascending: false }); // we'll sort by likes on frontend or use RPC later
    } else {
      query = query.order('created_at', { ascending: false });
    }

    const { data: posts, error, count } = await query;

    if (error) throw error;

    // Now enrich each post with likes, comments, and is_liked in parallel
    const enrichedPosts = await Promise.all(
      posts.map(async (post) => {
        const [
          { count: likeCount },
          { count: commentCount },
          { data: likedData }
        ] = await Promise.all([
          supabase.from('post_likes').select('*', { count: 'exact', head: true }).eq('post_id', post.id),
          supabase.from('comments').select('*', { count: 'exact', head: true }).eq('post_id', post.id),
          supabase.from('post_likes').select('user_id').eq('post_id', post.id).eq('user_id', userId).limit(1)
        ]);

        return {
          ...post,
          like_count: likeCount || 0,
          comment_count: commentCount || 0,
          is_liked: !!likedData?.length
        };
      })
    );

    res.json({
      posts: enrichedPosts,
      total: count || posts.length
    });
  } catch (err) {
    console.error("Feed error:", err);
    res.status(500).json({ error: err.message });
  }
});

// ==================== React POST ====================
// POST /api/forum/posts/:id/react
router.post('/posts/:id/react', async (req, res) => {
  const postId = req.params.id;
  const userId = req.auth.userId;
  const { reaction } = req.body; // "celebrate" | "heart" | "care" | "insightful" | "support"

  const validReactions = ['celebrate', 'heart', 'care', 'insightful', 'support'];
  if (!validReactions.includes(reaction)) {
    return res.status(400).json({ error: 'Invalid reaction' });
  }

  // Check if user already reacted with this type → toggle
  const { data: existing } = await supabase
    .from('post_reactions')
    .select('id')
    .eq('post_id', postId)
    .eq('user_id', userId)
    .eq('reaction_type', reaction)
    .single();

  if (existing) {
    // Remove reaction
    await supabase.from('post_reactions').delete().eq('id', existing.id);
    return res.json({ reacted: false, reaction });
  } else {
    // Add reaction
    await supabase.from('post_reactions').insert({
      post_id: postId,
      user_id: userId,
      reaction_type: reaction
    });

    // Notify post owner (except self-reaction)
    const { data: post } = await supabase.from('posts').select('user_id').eq('id', postId).single();
    if (post.user_id !== userId) {
      await supabase.from('notifications').insert({
        user_id: post.user_id,
        type: 'reaction',
        post_id: postId,
        trigger_user_id: userId,
        message: `${reaction}` // you can customize later
      });
    }

    return res.json({ reacted: true, reaction });
  }
});

// GET reactions count for a post (for feed & detail)
router.get('/posts/:id/reactions', async (req, res) => {
  const postId = req.params.id;
  const userId = req.auth.userId;

  const { data } = await supabase
    .from('post_reactions')
    .select('reaction_type, user_id')
    .eq('post_id', postId);

  const summary = {
    celebrate: 0,
    heart: 0,
    care: 0,
    insightful: 0,
    support: 0
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

  if (error) return res.status(400).json({ error: error.message });

  // Notify post owner (if not self-reply)
  const { data: post } = await supabase.from('posts').select('user_id').eq('id', postId).single();
  if (post.user_id !== userId) {
    await supabase.from('notifications').insert({
      user_id: post.user_id,
      type: 'reply',
      post_id: postId,
      comment_id: data.id,
      trigger_user_id: userId
    });
  }

  res.status(201).json(data);
});

// ==================== GET NOTIFICATIONS ====================
// GET /api/forum/notifications  ← FINAL WORKING VERSION
router.get('/notifications', async (req, res) => {
  const userId = req.auth.userId;

  try {
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
        posts!post_id (
          title,
          category
        )
      `)
      .eq('user_id', userId)
      .order('created_at', { ascending: false });

    if (error) throw error;

    // Optional: enrich with trigger user's username from MongoDB (if you want)
    // For now, just send the trigger_user_id — frontend can show "Someone liked your post"
    res.json({ notifications: data });

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

// routes/forumRoutes.js (add these at the end)

// ==================== SAVE / BOOKMARK POST (TOGGLE) ====================
router.post('/posts/:id/saveBookmark', async (req, res) => {
  const postId = req.params.id;
  const userId = req.auth.userId;

  // Check if already saved
  const { data: existing } = await supabase
    .from('saved_posts')
    .select()
    .eq('post_id', postId)
    .eq('user_id', userId)
    .single();

  if (existing) {
    // Unsave
    await supabase.from('saved_posts').delete().match({ post_id: postId, user_id: userId });
    res.json({ saved: false });
  } else {
    // Save
    await supabase.from('saved_posts').insert({ post_id: postId, user_id: userId });
    res.json({ saved: true });
  }
});

// ==================== DELETE OWN POST ====================
router.delete('/posts/:id', async (req, res) => {
  const postId = req.params.id;
  const userId = req.auth.userId;

  // Check ownership first
  const { data: post } = await supabase
    .from('posts')
    .select('user_id')
    .eq('id', postId)
    .single();

  if (!post || post.user_id !== userId) {
    return res.status(403).json({ error: 'You can only delete your own post' });
  }

  // Cascade delete (comments, likes, etc. via foreign keys)
  const { error } = await supabase.from('posts').delete().eq('id', postId);

  if (error) return res.status(400).json({ error: error.message });
  res.json({ success: true });
});

// ==================== DELETE OWN COMMENT ====================
router.delete('/comments/:id', async (req, res) => {
  const commentId = req.params.id;
  const userId = req.auth.userId;

  // Check ownership
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

  // Optional: Notify admins (if you have an admins table or email)
  // await sendAdminEmail(`New report on ${target_type} #${target_id}: ${reason}`);

  res.status(201).json(data);
});

// ==================== GET ALL SAVED POSTS ====================
// GET /api/forum/saved  ← FINAL FINAL VERSION
router.get('/saved', async (req, res) => {
  const userId = req.auth.userId;
  const page = parseInt(req.query.page) || 1;
  const limit = 20;
  const from = (page - 1) * limit;
  const to = from + limit - 1;

  try {
    // This now returns correct count because we have a proper PK
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
      .in('id', postIds);

    const enriched = await Promise.all(
      posts.map(async (post) => {
        const [{ count: likes = 0 }, { count: comments = 0 }, { data: liked }] = await Promise.all([
          supabase.from('post_likes').select('*', { count: 'exact', head: true }).eq('post_id', post.id),
          supabase.from('comments').select('*', { count: 'exact', head: true }).eq('post_id', post.id),
          supabase.from('post_likes').select('user_id').eq('post_id', post.id).eq('user_id', userId).limit(1)
        ]);

        return {
          ...post,
          like_count: likes,
          comment_count: comments,
          is_liked: !!liked?.length,
          saved_at: savedItems.find(s => s.post_id === post.id)?.created_at
        };
      })
    );

    // Preserve saved order
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

module.exports = router;