CREATE TABLE "activity" (
	"activity_id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"repo_id" uuid NOT NULL,
	"time_spent" interval,
	"likelihood_count" integer DEFAULT 0,
	"is_saved" boolean DEFAULT false,
	CONSTRAINT "activity_user_repo_unique" UNIQUE("user_id","repo_id")
);
--> statement-breakpoint
CREATE TABLE "board_repos" (
	"board_id" uuid NOT NULL,
	"repo_id" uuid NOT NULL,
	"added_at" timestamp DEFAULT now(),
	CONSTRAINT "board_repos_board_id_repo_id_pk" PRIMARY KEY("board_id","repo_id")
);
--> statement-breakpoint
CREATE TABLE "boards" (
	"board_id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"board_name" varchar(100) NOT NULL,
	"visibility" varchar(20) DEFAULT 'public' NOT NULL,
	"description" text,
	"repos_count" integer DEFAULT 0,
	"created_at" timestamp DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "boards_containers" (
	"container_id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"container_name" varchar(100) DEFAULT 'boards_container' NOT NULL,
	"description" text,
	"created_at" timestamp DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "comment" (
	"comment_id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"repo_id" uuid NOT NULL,
	"parent_comment_id" uuid,
	"comment" text NOT NULL,
	"created_at" timestamp DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "container_boards" (
	"container_id" uuid NOT NULL,
	"board_id" uuid NOT NULL,
	"added_at" timestamp DEFAULT now(),
	CONSTRAINT "container_boards_container_id_board_id_pk" PRIMARY KEY("container_id","board_id")
);
--> statement-breakpoint
CREATE TABLE "follows" (
	"follower_id" uuid NOT NULL,
	"following_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now(),
	CONSTRAINT "follows_follower_id_following_id_pk" PRIMARY KEY("follower_id","following_id")
);
--> statement-breakpoint
CREATE TABLE "oauth_codes" (
	"code" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"expires_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "refresh_tokens" (
	"token_id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"refresh_token_hash" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"is_revoked" boolean DEFAULT false,
	"last_used_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now(),
	CONSTRAINT "refresh_tokens_refresh_token_hash_unique" UNIQUE("refresh_token_hash")
);
--> statement-breakpoint
CREATE TABLE "repo" (
	"repo_id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"github_repo_url" varchar(200) NOT NULL,
	"owner_id" varchar(100) NOT NULL,
	"repo_name" varchar(200) NOT NULL,
	"full_name" varchar(255) NOT NULL,
	"description" text,
	"language_used" jsonb DEFAULT '[]',
	"topics" jsonb DEFAULT '[]',
	"readme_summary" text,
	"likes_count" integer DEFAULT 0,
	"comments_count" integer DEFAULT 0,
	"saves_count" integer DEFAULT 0,
	"views_count" integer DEFAULT 0,
	"forks_count" integer DEFAULT 0,
	"pr_count" integer DEFAULT 0,
	"created_at" timestamp DEFAULT now(),
	"updated_at" timestamp DEFAULT now(),
	CONSTRAINT "repo_github_repo_url_unique" UNIQUE("github_repo_url")
);
--> statement-breakpoint
CREATE TABLE "users" (
	"user_id" uuid PRIMARY KEY NOT NULL,
	"username" varchar(50) NOT NULL,
	"full_name" varchar(100),
	"date_of_birth" date,
	"bio" text,
	"github_url" varchar(512),
	"github_id" varchar(100),
	"github_handle" varchar(100),
	"avatar_url" varchar(512),
	"followers_count" integer DEFAULT 0,
	"following_count" integer DEFAULT 0,
	"saved_repos_count" integer DEFAULT 0,
	"interests" jsonb DEFAULT '[]' NOT NULL,
	"skills" jsonb DEFAULT '[]' NOT NULL,
	"tech_stack" jsonb DEFAULT '[]' NOT NULL,
	"onboarding_completed" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now(),
	CONSTRAINT "users_username_unique" UNIQUE("username"),
	CONSTRAINT "users_github_id_unique" UNIQUE("github_id")
);
--> statement-breakpoint
ALTER TABLE "activity" ADD CONSTRAINT "activity_user_id_users_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("user_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "activity" ADD CONSTRAINT "activity_repo_id_repo_repo_id_fk" FOREIGN KEY ("repo_id") REFERENCES "public"."repo"("repo_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "board_repos" ADD CONSTRAINT "board_repos_board_id_boards_board_id_fk" FOREIGN KEY ("board_id") REFERENCES "public"."boards"("board_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "board_repos" ADD CONSTRAINT "board_repos_repo_id_repo_repo_id_fk" FOREIGN KEY ("repo_id") REFERENCES "public"."repo"("repo_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "boards" ADD CONSTRAINT "boards_user_id_users_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("user_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "boards_containers" ADD CONSTRAINT "boards_containers_user_id_users_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("user_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "comment" ADD CONSTRAINT "comment_user_id_users_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("user_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "comment" ADD CONSTRAINT "comment_repo_id_repo_repo_id_fk" FOREIGN KEY ("repo_id") REFERENCES "public"."repo"("repo_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "container_boards" ADD CONSTRAINT "container_boards_container_id_boards_containers_container_id_fk" FOREIGN KEY ("container_id") REFERENCES "public"."boards_containers"("container_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "container_boards" ADD CONSTRAINT "container_boards_board_id_boards_board_id_fk" FOREIGN KEY ("board_id") REFERENCES "public"."boards"("board_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "follows" ADD CONSTRAINT "follows_follower_id_users_user_id_fk" FOREIGN KEY ("follower_id") REFERENCES "public"."users"("user_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "follows" ADD CONSTRAINT "follows_following_id_users_user_id_fk" FOREIGN KEY ("following_id") REFERENCES "public"."users"("user_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "oauth_codes" ADD CONSTRAINT "oauth_codes_user_id_users_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("user_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "refresh_tokens" ADD CONSTRAINT "refresh_tokens_user_id_users_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("user_id") ON DELETE cascade ON UPDATE no action;