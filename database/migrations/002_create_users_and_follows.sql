CREATE TABLE public.users (
    user_id UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
    username VARCHAR(50) UNIQUE NOT NULL,
    github_id VARCHAR(100) UNIQUE,
    github_handle VARCHAR(100),
    avatar_url TEXT,
    followers_count INT DEFAULT 0,
    following_count INT DEFAULT 0,
    saved_repos_count INT DEFAULT 0,
    interests JSONB DEFAULT '[]'::jsonb,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE TABLE public.follows (
    follower_id UUID REFERENCES public.users(user_id) ON DELETE CASCADE,
    following_id UUID REFERENCES public.users(user_id) ON DELETE CASCADE,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    PRIMARY KEY (follower_id, following_id)
);

CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS TRIGGER AS $$
BEGIN
  INSERT INTO public.users (user_id, username, github_id, github_handle, avatar_url)
  VALUES (
    NEW.id,
    NEW.raw_user_meta_data->>'user_name', 
    NEW.raw_user_meta_data->>'provider_id',
    NEW.raw_user_meta_data->>'preferred_username',
    NEW.raw_user_meta_data->>'avatar_url'
  );
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

CREATE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE PROCEDURE public.handle_new_user();

CREATE OR REPLACE FUNCTION update_follow_counts()
RETURNS TRIGGER AS $$
BEGIN
    IF TG_OP = 'INSERT' THEN
        -- Someone followed someone: Add 1
        UPDATE users SET following_count = following_count + 1 WHERE user_id = NEW.follower_id;
        UPDATE users SET followers_count = followers_count + 1 WHERE user_id = NEW.following_id;
        RETURN NEW;
    ELSIF TG_OP = 'DELETE' THEN
        -- Someone unfollowed someone: Subtract 1
        UPDATE users SET following_count = following_count - 1 WHERE user_id = OLD.follower_id;
        UPDATE users SET followers_count = followers_count - 1 WHERE user_id = OLD.following_id;
        RETURN OLD;
    END IF;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER on_follow_change
AFTER INSERT OR DELETE ON follows
FOR EACH ROW
EXECUTE FUNCTION update_follow_counts();

-- 1. Enable RLS on both tables (Locks them down)
ALTER TABLE public.users ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.follows ENABLE ROW LEVEL SECURITY;

-- 2. Allow anyone to READ user profiles (Needed for the frontend)
CREATE POLICY "Allow public read access to users" 
ON public.users FOR SELECT USING (true);

-- 3. Allow anyone to READ follow relationships
CREATE POLICY "Allow public read access to follows" 
ON public.follows FOR SELECT USING (true);