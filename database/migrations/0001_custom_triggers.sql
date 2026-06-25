-- Custom Triggers and Functions

-- 1. Enforce Repo Saved for Board
CREATE OR REPLACE FUNCTION enforce_repo_saved_for_board()
RETURNS TRIGGER AS $$
DECLARE
    owner_uuid UUID;
    v_is_saved BOOLEAN;
BEGIN
    SELECT user_id INTO owner_uuid FROM boards WHERE board_id = COALESCE(NEW.board_id, OLD.board_id);
    IF owner_uuid IS NULL THEN RAISE EXCEPTION 'Board does not exist'; END IF;
    SELECT EXISTS (
        SELECT 1 FROM activity WHERE user_id = owner_uuid AND repo_id = COALESCE(NEW.repo_id, OLD.repo_id) AND activity.is_saved = true
    ) INTO v_is_saved;
    IF NOT v_is_saved THEN RAISE EXCEPTION 'Repo must be saved by the board owner before it can be added to the board'; END IF;
    RETURN COALESCE(NEW, OLD);
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_enforce_repo_saved ON board_repos;
CREATE TRIGGER trg_enforce_repo_saved BEFORE INSERT OR UPDATE ON board_repos FOR EACH ROW EXECUTE FUNCTION enforce_repo_saved_for_board();

-- 2. Boards Repos Count Update
CREATE OR REPLACE FUNCTION boards_repos_count_update()
RETURNS TRIGGER AS $$
BEGIN
    IF TG_OP = 'INSERT' THEN
        UPDATE boards SET repos_count = repos_count + 1 WHERE board_id = NEW.board_id;
        RETURN NEW;
    ELSIF TG_OP = 'DELETE' THEN
        UPDATE boards SET repos_count = GREATEST(0, repos_count - 1) WHERE board_id = OLD.board_id;
        RETURN OLD;
    END IF;
    RETURN NULL;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_boards_repos_count ON board_repos;
CREATE TRIGGER trg_boards_repos_count AFTER INSERT OR DELETE ON board_repos FOR EACH ROW EXECUTE FUNCTION boards_repos_count_update();

-- 3. Update Repo Comments Count
CREATE OR REPLACE FUNCTION update_repo_comments_count() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    UPDATE Repo SET comments_count = (SELECT COUNT(*) FROM comment WHERE repo_id = NEW.repo_id) WHERE repo_id = NEW.repo_id;
    RETURN NEW;
  ELSIF TG_OP = 'DELETE' THEN
    UPDATE Repo SET comments_count = (SELECT COUNT(*) FROM comment WHERE repo_id = OLD.repo_id) WHERE repo_id = OLD.repo_id;
    RETURN OLD;
  END IF;
  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS trg_repo_comments_count ON comment;
CREATE TRIGGER trg_repo_comments_count AFTER INSERT OR DELETE ON comment FOR EACH ROW EXECUTE FUNCTION update_repo_comments_count();

-- 4. Update Repo Likes Count
CREATE OR REPLACE FUNCTION update_repo_likes_count() RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE target_repo_id UUID;
BEGIN
  IF TG_OP = 'INSERT' THEN target_repo_id := NEW.repo_id;
  ELSIF TG_OP = 'UPDATE' THEN target_repo_id := NEW.repo_id;
  ELSIF TG_OP = 'DELETE' THEN target_repo_id := OLD.repo_id;
  END IF;
  UPDATE Repo SET likes_count = (SELECT COUNT(*) FROM activity WHERE repo_id = target_repo_id AND likelihood_count = 1) WHERE repo_id = target_repo_id;
  RETURN COALESCE(NEW, OLD);
END;
$$;

DROP TRIGGER IF EXISTS trg_repo_likes_count ON activity;
CREATE TRIGGER trg_repo_likes_count AFTER INSERT OR UPDATE OR DELETE ON activity FOR EACH ROW EXECUTE FUNCTION update_repo_likes_count();

-- 5. Update Repo Saves Count
CREATE OR REPLACE FUNCTION update_repo_saves_count() RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE target_repo_id UUID;
BEGIN
  IF TG_OP = 'INSERT' THEN target_repo_id := NEW.repo_id;
  ELSIF TG_OP = 'UPDATE' THEN target_repo_id := NEW.repo_id;
  ELSIF TG_OP = 'DELETE' THEN target_repo_id := OLD.repo_id;
  END IF;
  UPDATE Repo SET saves_count = (SELECT COUNT(*) FROM activity WHERE repo_id = target_repo_id AND is_saved = true) WHERE repo_id = target_repo_id;
  RETURN COALESCE(NEW, OLD);
END;
$$;

DROP TRIGGER IF EXISTS trg_repo_saves_count ON activity;
CREATE TRIGGER trg_repo_saves_count AFTER INSERT OR UPDATE OR DELETE ON activity FOR EACH ROW EXECUTE FUNCTION update_repo_saves_count();

-- 6. Toggle Repo Like
CREATE OR REPLACE FUNCTION toggle_repo_like(uid UUID, rid UUID) RETURNS SETOF activity LANGUAGE plpgsql AS $$
BEGIN
  RETURN QUERY INSERT INTO activity (user_id, repo_id, likelihood_count) VALUES (uid, rid, 1) ON CONFLICT (user_id, repo_id) DO UPDATE SET likelihood_count = CASE WHEN activity.likelihood_count = 1 THEN 0 ELSE 1 END RETURNING *;
END;
$$;

-- 7. Toggle Repo Save
CREATE OR REPLACE FUNCTION toggle_repo_save(uid UUID, rid UUID) RETURNS SETOF activity LANGUAGE plpgsql AS $$
BEGIN
  RETURN QUERY INSERT INTO activity (user_id, repo_id, is_saved) VALUES (uid, rid, true) ON CONFLICT (user_id, repo_id) DO UPDATE SET is_saved = NOT activity.is_saved RETURNING *;
END;
$$;

-- 8. Increment Repo Views
CREATE OR REPLACE FUNCTION increment_repo_views(rid UUID) RETURNS boolean LANGUAGE plpgsql AS $$
BEGIN
  UPDATE Repo SET views_count = views_count + 1 WHERE repo_id = rid;
  RETURN FOUND;
END;
$$;

-- 9. Create Container With Defaults
CREATE OR REPLACE FUNCTION create_container_with_defaults(uid UUID, container_name TEXT DEFAULT 'Default Boards Container') RETURNS JSONB LANGUAGE plpgsql AS $$
DECLARE
  v_container JSONB; v_board1 JSONB; v_board2 JSONB;
BEGIN
  INSERT INTO boards_containers (user_id, container_name, description) VALUES (uid, container_name, NULL) RETURNING row_to_json(boards_containers.*)::JSONB INTO v_container;
  INSERT INTO boards (user_id, board_name, visibility, description) VALUES (uid, 'Saved Repos', 'public', NULL) RETURNING row_to_json(boards.*)::JSONB INTO v_board1;
  INSERT INTO boards (user_id, board_name, visibility, description) VALUES (uid, 'GitHub Repos', 'public', NULL) RETURNING row_to_json(boards.*)::JSONB INTO v_board2;
  INSERT INTO container_boards (container_id, board_id) VALUES ((v_container->>'container_id')::UUID, (v_board1->>'board_id')::UUID), ((v_container->>'container_id')::UUID, (v_board2->>'board_id')::UUID);
  RETURN jsonb_build_object('container', v_container, 'boards', jsonb_build_array(v_board1, v_board2));
END;
$$;

-- 10. Handle New User
CREATE OR REPLACE FUNCTION public.handle_new_user() RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER AS $$
BEGIN
    INSERT INTO public.users (user_id, username, full_name, date_of_birth, bio, github_url, github_id, github_handle, avatar_url)
    VALUES (NEW.id, COALESCE(NEW.raw_user_meta_data->>'user_name', 'user_' || SUBSTRING(NEW.id::text, 1, 8)), NEW.raw_user_meta_data->>'full_name', NULLIF(NEW.raw_user_meta_data->>'date_of_birth', '')::DATE, NEW.raw_user_meta_data->>'bio', NEW.raw_user_meta_data->>'github_url', NEW.raw_user_meta_data->>'provider_id', NEW.raw_user_meta_data->>'preferred_username', NEW.raw_user_meta_data->>'avatar_url');
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users;
CREATE TRIGGER on_auth_user_created AFTER INSERT ON auth.users FOR EACH ROW EXECUTE FUNCTION public.handle_new_user();

-- 11. Update Follow Counts
CREATE OR REPLACE FUNCTION public.update_follow_counts() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
    IF TG_OP = 'INSERT' THEN
        UPDATE public.users SET following_count = following_count + 1 WHERE user_id = NEW.follower_id;
        UPDATE public.users SET followers_count = followers_count + 1 WHERE user_id = NEW.following_id;
        RETURN NEW;
    ELSIF TG_OP = 'DELETE' THEN
        UPDATE public.users SET following_count = GREATEST(0, following_count - 1) WHERE user_id = OLD.follower_id;
        UPDATE public.users SET followers_count = GREATEST(0, followers_count - 1) WHERE user_id = OLD.following_id;
        RETURN OLD;
    END IF;
    RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS on_follow_change ON public.follows;
CREATE TRIGGER on_follow_change AFTER INSERT OR DELETE ON public.follows FOR EACH ROW EXECUTE FUNCTION public.update_follow_counts();

-- 12. Evaluate Onboarding Status
CREATE OR REPLACE FUNCTION public.evaluate_onboarding_status() RETURNS TRIGGER AS $$
BEGIN
    NEW.onboarding_completed := (
        (NEW.username IS NOT NULL AND TRIM(NEW.username) <> '' AND NEW.username !~ '^user_[0-9a-f]{8}$') AND
        (NEW.full_name IS NOT NULL AND TRIM(NEW.full_name) <> '') AND
        (NEW.github_handle IS NOT NULL AND TRIM(NEW.github_handle) <> '') AND
        (NEW.interests IS NOT NULL AND jsonb_typeof(NEW.interests) = 'array' AND jsonb_array_length(NEW.interests) > 0) AND
        (NEW.skills IS NOT NULL AND jsonb_typeof(NEW.skills) = 'array' AND jsonb_array_length(NEW.skills) > 0) AND
        (NEW.tech_stack IS NOT NULL AND jsonb_typeof(NEW.tech_stack) = 'array' AND jsonb_array_length(NEW.tech_stack) > 0)
    );
    RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

DROP TRIGGER IF EXISTS tr_evaluate_onboarding ON public.users;
CREATE TRIGGER tr_evaluate_onboarding BEFORE INSERT OR UPDATE OF username, full_name, github_handle, interests, skills, tech_stack ON public.users FOR EACH ROW EXECUTE FUNCTION public.evaluate_onboarding_status();

-- 13. Enable RLS on ALL tables to force traffic through the secure backend API
ALTER TABLE public.users ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.follows ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.refresh_tokens ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.oauth_codes ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.repo ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.activity ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.comment ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.boards ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.board_repos ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.boards_containers ENABLE ROW LEVEL SECURITY;

-- 14. Link public.users to auth.users
ALTER TABLE public.users 
  ADD CONSTRAINT users_user_id_fkey 
  FOREIGN KEY (user_id) 
  REFERENCES auth.users(id) 
  ON DELETE CASCADE;

-- 15. Prevent self-following
ALTER TABLE public.follows
  ADD CONSTRAINT no_self_follow 
  CHECK (follower_id <> following_id);

-- 16. Self-referential FK for comments
ALTER TABLE public.comment 
  ADD CONSTRAINT comment_parent_comment_id_fkey 
  FOREIGN KEY (parent_comment_id) 
  REFERENCES public.comment(comment_id) 
  ON DELETE CASCADE;

-- 17. Visibility constraint for boards
ALTER TABLE public.boards
  ADD CONSTRAINT visibility_check
  CHECK (visibility IN ('public', 'private'));
