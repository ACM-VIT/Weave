import express from 'express';
import { supabase } from '../supabase.js';

const router = express.Router();

// GET /api/users/:username - Fetch a user's public profile
router.get('/:username', async (req, res) => {
    const { username } = req.params; 

    try {
        const { data, error } = await supabase
            .from('users') 
            .select('*')
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
    
    // NOTE FOR PR: Right now we grab follower_id from the body. 
    // In the future, this should be extracted from the user's secure JWT session token.
    const { follower_id } = req.body;

    if (!follower_id) {
        return res.status(400).json({ error: "follower_id is required in the request body." });
    }

    try {
        // 1. First, we need to find the UUID of the user they are trying to follow
        const { data: targetUser, error: targetError } = await supabase
            .from('users')
            .select('user_id')
            .eq('username', username)
            .single();

        if (targetError || !targetUser) {
            return res.status(404).json({ message: 'Target user not found' });
        }

        // 2. Insert the relationship into the follows table
        const { error: followError } = await supabase
            .from('follows')
            .insert([{ 
                follower_id: follower_id, 
                following_id: targetUser.user_id 
            }]);

        if (followError) {
            // Check if they are already following to prevent duplicate key errors
            if (followError.code === '23505') {
                return res.status(400).json({ message: "You are already following this user." });
            }
            throw followError;
        }

        res.json({ status: "success", message: `Successfully followed ${username}` });

    } catch (err) {
        console.error("Error following user:", err);
        res.status(500).json({ error: "Internal server error." });
    }
});

// DELETE /api/users/:username/follow - Unfollow a user
router.delete('/:username/follow', async (req, res) => {
    const { username } = req.params;
    const { follower_id } = req.body; // Again, will eventually come from auth token

    if (!follower_id) {
        return res.status(400).json({ error: "follower_id is required in the request body." });
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

        // 2. Delete the specific relationship from the follows table
        const { error: unfollowError } = await supabase
            .from('follows')
            .delete()
            .match({ 
                follower_id: follower_id, 
                following_id: targetUser.user_id 
            });

        if (unfollowError) throw unfollowError;

        res.json({ status: "success", message: `Successfully unfollowed ${username}` });

    } catch (err) {
        console.error("Error unfollowing user:", err);
        res.status(500).json({ error: "Internal server error." });
    }
});

export default router;