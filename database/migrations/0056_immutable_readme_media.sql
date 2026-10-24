-- Preserve branch media bases while accepting full immutable Git commit identities.
ALTER TABLE app.repo_content
  DROP CONSTRAINT IF EXISTS repo_content_readme_metadata_check;
--> statement-breakpoint
ALTER TABLE app.repo_content
  ADD CONSTRAINT repo_content_readme_metadata_check CHECK (
    (readme_source_path IS NULL OR (
      btrim(readme_source_path)=readme_source_path
      AND btrim(readme_source_path)<>''
      AND char_length(readme_source_path)<=1024
      AND readme_source_path !~ '^/'
      AND right(readme_source_path,1)<>'/'
      AND position('//' in readme_source_path)=0
      AND position(chr(92) in readme_source_path)=0
      AND readme_source_path !~ '(^|/)[.]{1,2}(/|$)'
    ))
    AND (readme_default_branch IS NULL OR (
      btrim(readme_default_branch)=readme_default_branch
      AND btrim(readme_default_branch)<>''
      AND char_length(readme_default_branch)<=256
      AND readme_default_branch !~ '^/'
      AND right(readme_default_branch,1)<>'/'
      AND position('//' in readme_default_branch)=0
      AND position(chr(92) in readme_default_branch)=0
      AND readme_default_branch !~ '(^|/)[.]{1,2}(/|$)'
    ))
    AND (
      readme_base_url IS NULL
      OR (
        char_length(readme_base_url)<=2048
        AND readme_base_url ~ '^https://raw[.]githubusercontent[.]com/[^/[:space:]?#]+/[^/[:space:]?#]+/(refs/heads/[^[:space:]?#]+|[a-f0-9]{40}(/[^/[:space:]?#]+)*)/$'
      )
    )
  ) NOT VALID;
--> statement-breakpoint
ALTER TABLE app.repo_content
  VALIDATE CONSTRAINT repo_content_readme_metadata_check;
--> statement-breakpoint
