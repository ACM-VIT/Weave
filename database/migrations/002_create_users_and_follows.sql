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
    created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE public.follows (
    follower_id UUID REFERENCES public.users(user_id) ON DELETE CASCADE,
    following_id UUID REFERENCES public.users(user_id) ON DELETE CASCADE,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    PRIMARY KEY (follower_id, following_id),
    CONSTRAINT no_self_follow CHECK (follower_id <> following_id)
);

CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
    INSERT INTO public.users (
        user_id,
        username,
        github_id,
        github_handle,
        avatar_url
    )
    VALUES (
        NEW.id,
        COALESCE(
            NEW.raw_user_meta_data->>'user_name',
            'user_' || SUBSTRING(NEW.id::text, 1, 8)
        ),
        NEW.raw_user_meta_data->>'provider_id',
        NEW.raw_user_meta_data->>'preferred_username',
        NEW.raw_user_meta_data->>'avatar_url'
    );
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users;

CREATE TRIGGER on_auth_user_created
AFTER INSERT ON auth.users
FOR EACH ROW
EXECUTE FUNCTION public.handle_new_user();

CREATE OR REPLACE FUNCTION public.update_follow_counts()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
    IF TG_OP = 'INSERT' THEN
        UPDATE public.users
        SET following_count = following_count + 1
        WHERE user_id = NEW.follower_id;

        UPDATE public.users
        SET followers_count = followers_count + 1
        WHERE user_id = NEW.following_id;

        RETURN NEW;
    ELSIF TG_OP = 'DELETE' THEN
        UPDATE public.users
        SET following_count = GREATEST(0, following_count - 1)
        WHERE user_id = OLD.follower_id;

        UPDATE public.users
        SET followers_count = GREATEST(0, followers_count - 1)
        WHERE user_id = OLD.following_id;

        RETURN OLD;
    END IF;
    RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS on_follow_change ON public.follows;

CREATE TRIGGER on_follow_change
AFTER INSERT OR DELETE
ON public.follows
FOR EACH ROW
EXECUTE FUNCTION public.update_follow_counts();

ALTER TABLE public.users ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.follows ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Public profiles are viewable"
ON public.users
FOR SELECT
USING (true);

CREATE POLICY "Users can update own profile"
ON public.users
FOR UPDATE
USING (auth.uid() = user_id);

CREATE POLICY "Users can insert own profile"
ON public.users
FOR INSERT
WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can delete own profile"
ON public.users
FOR DELETE
USING (auth.uid() = user_id);

CREATE POLICY "Anyone can view follows"
ON public.follows
FOR SELECT
USING (true);

CREATE POLICY "Users can follow"
ON public.follows
FOR INSERT
WITH CHECK (auth.uid() = follower_id);

CREATE POLICY "Users can unfollow"
ON public.follows
FOR DELETE
USING (auth.uid() = follower_id);

CREATE INDEX idx_users_username
ON public.users(username);

CREATE INDEX idx_follows_follower
ON public.follows(follower_id);

CREATE INDEX idx_follows_following
ON public.follows(following_id);