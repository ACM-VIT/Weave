
CREATE INDEX "activity_repo_id_idx" ON "activity" USING btree ("repo_id");--> statement-breakpoint
CREATE INDEX "board_repos_repo_id_idx" ON "board_repos" USING btree ("repo_id");--> statement-breakpoint
CREATE INDEX "boards_user_id_idx" ON "boards" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "boards_containers_user_id_idx" ON "boards_containers" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "comment_repo_id_idx" ON "comment" USING btree ("repo_id");--> statement-breakpoint
CREATE INDEX "comment_user_id_idx" ON "comment" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "comment_parent_comment_id_idx" ON "comment" USING btree ("parent_comment_id");--> statement-breakpoint
CREATE INDEX "container_boards_board_id_idx" ON "container_boards" USING btree ("board_id");--> statement-breakpoint
CREATE INDEX "follows_follower_id_idx" ON "follows" USING btree ("follower_id");--> statement-breakpoint
CREATE INDEX "follows_following_id_idx" ON "follows" USING btree ("following_id");--> statement-breakpoint
CREATE INDEX "repos_owner_id_idx" ON "repo" USING btree ("owner_id");--> statement-breakpoint