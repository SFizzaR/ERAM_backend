// routes/forumRoutes.js
const { Router } = require('express');
const { supabase } = require('../lib/supabase');
const { protect } = require('../middleware/protectMiddleware');
const User = require('../models/userModel');
const { filterContent } = require('../utils/contentFilter');

const router = Router();
router.use(protect); // All routes require logged-in user

const getUserId = (req) => req.user._id.toString();

// ==================== CREATE POST ====================
router.post('/posts', async (req, res) => {
  const { title, content, category, media_urls = [], is_anonymous = false } = req.body;
  const userId = req.auth.userId;

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
    .insert({ user_id: userId, title, content, category, media_urls, is_anonymous })
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
        celebrate: 0,
        heart: 0,
        care: 0,
        insightful: 0,
        like: 0
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
        username: post.is_anonymous ? 'Anonymous' : profile.username || 'Unknown',
        city: post.is_anonymous ? null : profile.current_city,
        reaction_counts: reactionCounts,
        total_reactions: totalReactions,
        my_reactions: myReactions,
        comment_count: commentCount || 0
      };
    })
  );
}

// GLOBAL FEED – UPDATED FOR REACTIONS
router.get('/feed/global', async (req, res) => {
  const { category, page = 1 } = req.query;
  const limit = 20;
  const from = (page - 1) * limit;
  const userId = req.auth.userId;

  try {
    let query = supabase
      .from('posts')
      .select(`
        id, title, content, category, media_urls,
        created_at, updated_at, user_id, is_anonymous
      `)
      .range(from, from + limit - 1)
      .order('created_at', { ascending: false });

    if (category && category !== 'all') query = query.eq('category', category);

    const { data: posts, error, count } = await query;
    if (error) throw error;

    const enrichedPosts = await enrichPosts(posts, userId);

    res.json({
      posts: enrichedPosts,
      total: count || posts.length
    });
  } catch (err) {
    console.error("Global feed error:", err);
    res.status(500).json({ error: err.message });
  }
});

// CITY FEED – UPDATED FOR REACTIONS
router.get('/feed/city', async (req, res) => {
  const currentCity = req.user.current_city?.trim();
  if (!currentCity) return res.status(400).json({ error: 'Please set your city in profile first' });

  const { category, page = 1 } = req.query;
  const limit = 20;
  const from = (page - 1) * limit;
  const userId = req.auth.userId;

  try {
    let query = supabase
      .from('posts')
      .select(`
        id, title, content, category, media_urls,
        created_at, updated_at, user_id, is_anonymous
      `)
      .order('created_at', { ascending: false })
      .limit(300); // Safe limit

    if (category && category !== 'all') query = query.eq('category', category);

    const { data: posts, error } = await query;
    if (error) throw error;

    const enriched = await enrichPosts(posts, userId);

    const cityPosts = enriched.filter(post => {
      if (post.is_anonymous || !post.city) return false;
      return post.city.trim().toLowerCase() === currentCity.toLowerCase();
    });

    const paginated = cityPosts.slice(from, from + limit);

    res.json({
      posts: paginated,
      total: cityPosts.length,
      city: currentCity
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ==================== React POST ====================
router.post('/posts/:id/react', async (req, res) => {
  const postId = req.params.id;
  const userId = req.auth.userId;
  const { reaction } = req.body; // "celebrate" | "heart" | "care" | "insightful" | "support"

  const validReactions = ['celebrate', 'heart', 'care', 'insightful', 'like'];
  if (!validReactions.includes(reaction)) {
    return res.status(400).json({ error: 'Invalid reaction' });
  }

  // if user already reacted with this type → toggle
  const { data: existing } = await supabase
    .from('post_reactions')
    .select('id')
    .eq('post_id', postId)
    .eq('user_id', userId)
    .eq('reaction_type', reaction)
    .single();

  if (existing) {
    await supabase.from('post_reactions').delete().eq('id', existing.id);
    return res.json({ reacted: false, reaction });
  } else {
    await supabase.from('post_reactions').insert({
      post_id: postId,
      user_id: userId,
      reaction_type: reaction
    });

    // Notify post owner 
    const { data: post } = await supabase.from('posts').select('user_id').eq('id', postId).single();
    if (post.user_id !== userId) {
      await supabase.from('notifications').insert({
        user_id: post.user_id,
        type: 'reaction',
        post_id: postId,
        trigger_user_id: userId,
        message: `${reaction}` 
      });
    }

    return res.json({ reacted: true, reaction });
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

  const check = filterContent(content);
  if (check.blocked) {
    return res.status(400).json({
      error: 'Comment blocked',
      reason: check.reason
    });
  }

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


  res.status(201).json(data);
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
      .in('id', postIds);

    const enriched = await Promise.all(
  posts.map(async (post) => {
    // Get reactions summary
    const { data: reactionsData } = await supabase
      .from('post_reactions')
      .select('reaction_type')
      .eq('post_id', post.id);

    const reactionCounts = {
      celebrate: 0,
      heart: 0,
      care: 0,
      insightful: 0,
      like: 0
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
  const { data: existing } = await supabase
    .from('comment_likes')
    .select('id')
    .eq('comment_id', commentId)
    .eq('user_id', userId)
    .single();

  if (existing) {
    // Unlike
    await supabase.from('comment_likes').delete().eq('id', existing.id);
    return res.json({ liked: false });
  } else {
    // Like
    await supabase.from('comment_likes').insert({
      comment_id: commentId,
      user_id: userId
    });

    // Notify comment owner (if not self-like)
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

    return res.json({ liked: true });
  }
});

module.exports = router;