import express from 'express';
import { supabase } from '../supabase.js';

const router = express.Router();

// GET /api/users/:username - Fetch a user's public profile
router.get('/:username', async (req, res) => {
    const { username } = req.params; 

    try {
        const { data, error } = await supabase
            .from('users')
            .select('username, github_handle, avatar_url, followers_count, following_count, saved_repos_count, interests, created_at')
            .eq('username', username)
            .single(); 

        if (error) {
            if (error.code === 'PGRST116') {
                return res.status(404).json({ message: 'User not found' });
            }
            throw error;
        }

        res.json({ status: "success", data });

    } catch (err) {
        console.error("Error fetching user profile:", err);
        res.status(500).json({ error: "Internal server error." });
    }
});

// POST /api/users/:username/follow - Follow a user
router.post('/:username/follow', async (req, res) => {
    const { username } = req.params;
    const { follower_id } = req.body;

    if (!follower_id) {
        return res.status(400).json({ error: "follower_id is required in the request body." });
    }

    const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    if (!uuidRegex.test(follower_id)) {
        return res.status(400).json({ error: "follower_id must be a valid UUID." });
    }

    try {
        // 1. Find the UUID of the user they are trying to follow
        const { data: targetUser, error: targetError } = await supabase
            .from('users')
            .select('user_id')
            .eq('username', username)
            .single();

        if (targetError) {
            if (targetError.code === 'PGRST116') {
            return res.status(404).json({ message: 'Target user not found' });
            }
            throw targetError;
        }

if (!targetUser) {
    return res.status(404).json({ message: 'Target user not found' });
}

        // Prevent self-following
        if (follower_id === targetUser.user_id) {
            return res.status(400).json({ message: "You cannot follow yourself." });
        }

        // 2. Insert the relationship into the follows table
        const { error: followError } = await supabase
            .from('follows')
            .insert([{ 
                follower_id: follower_id, 
                following_id: targetUser.user_id 
            }]);

        if (followError) {
            if (followError.code === '23505') {
                return res.status(400).json({ message: "You are already following this user." });
            }
            // Check if the follower_id actually exists (Foreign Key Violation)
            if (followError.code === '23503') {
                return res.status(400).json({ message: "Invalid follower_id: User does not exist." });
            }
            throw followError;
        }

        res.json({ status: "success", message: `Successfully followed ${username}` });

    } catch (err) {
        console.error("Error following user:", err);
        res.status(500).json({ error: "Internal server error." });
    }
});

// Unfollow a user
router.delete('/:username/follow', async (req, res) => {
    const { username } = req.params;
    const { follower_id } = req.query; 

    if (!follower_id) {

        return res.status(400).json({ error: "follower_id is required as a query parameter." });
    }

    // Add UUID check to DELETE route as well
    const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    if (!uuidRegex.test(follower_id)) {
        return res.status(400).json({ error: "follower_id must be a valid UUID." });
    }

    try {
        // 1. Find the target user's UUID
        const { data: targetUser, error: targetError } = await supabase
            .from('users')
            .select('user_id')
            .eq('username', username)
            .single();

        if (targetError || !targetUser) {
            return res.status(404).json({ message: 'Target user not found' });
        }

        // 2. Delete the relationship, asking Supabase to count how many rows it actually deleted
        const { error: unfollowError, count } = await supabase
            .from('follows')
            .delete({ count: 'exact' })
            .match({ 
                follower_id: follower_id, 
                following_id: targetUser.user_id 
            });

        if (unfollowError) throw unfollowError;

        // 3. If no rows were deleted, they weren't following the user
        if (count === 0) {
            return res.status(400).json({ message: "You are not following this user." });
        }

        res.json({ status: "success", message: `Successfully unfollowed ${username}` });

    } catch (err) {
        console.error("Error unfollowing user:", err);
        res.status(500).json({ error: "Internal server error." });
    }
});
export default router;