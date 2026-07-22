import { useMutation, useQueryClient } from "@tanstack/react-query";
import * as SecureStore from "../utils/storage";
import { createBoard } from "../api/boards";
import type { QueuedActivity } from "../api/activity";

export function useOptimisticMutations(userId?: string) {
  const queryClient = useQueryClient();

  const createBoardMutation = useMutation({
    mutationFn: async (boardName: string) => {
      if (!userId) throw new Error("No user id");
      const token = await SecureStore.getItemAsync("access_token");
      if (!token) throw new Error("No token");
      return createBoard(userId, boardName, token);
    },
    onMutate: async (newBoardName) => {
      // Cancel any outgoing refetches so they don't overwrite our optimistic update
      await queryClient.cancelQueries({ queryKey: ["boards", userId] });

      // Snapshot the previous value
      const previousBoards = queryClient.getQueryData(["boards", userId]);

      // Optimistically update to the new value
      queryClient.setQueryData(["boards", userId], (old: any) => {
        if (!old) return old;
        const newBoard = {
          board_id: `temp-${Date.now()}`,
          board_name: newBoardName,
          user_id: userId,
          visibility: "private",
          repos_count: 0,
        };
        
        // React Query Infinite data structure is { pages: [...], pageParams: [...] }
        const newPages = [...old.pages];
        if (newPages.length > 0) {
          newPages[0] = [newBoard, ...newPages[0]];
        } else {
          newPages.push([newBoard]);
        }

        return {
          ...old,
          pages: newPages,
        };
      });

      return { previousBoards };
    },
    onError: (err, newBoardName, context) => {
      // If the mutation fails, use the context returned from onMutate to roll back
      if (context?.previousBoards) {
        queryClient.setQueryData(["boards", userId], context.previousBoards);
      }
    },
    onSettled: () => {
      // Always refetch after error or success to ensure backend sync
      queryClient.invalidateQueries({ queryKey: ["boards", userId] });
    },
  });

  const addRepoToBoardMutation = useMutation({
    mutationFn: async ({ boardId, repoId, repoName: _repoName, serveId, position, event }: {
      boardId: string;
      repoId: string;
      repoName: string;
      serveId?: string | null;
      position?: number | null;
      event: QueuedActivity;
    }) => {
      if (!userId) throw new Error("No user id");
      const token = await SecureStore.getItemAsync("access_token");
      if (!token) throw new Error("No token");
      
      const { addRepoToBoardAtomic } = await import("../api/boards");
      return addRepoToBoardAtomic(
        userId,
        boardId,
        repoId,
        token,
        { serve_id: serveId, position },
        event,
      );
    },
    onMutate: async ({ repoId, repoName }) => {
      // Optimistically update both the board's repos (if we had a query for it) and the savedRepos list
      await queryClient.cancelQueries({ queryKey: ["savedRepos", userId] });
      const previousRepos = queryClient.getQueryData(["savedRepos", userId]);

      // Optimistically add to savedRepos since the backend transaction guarantees it will be saved
      queryClient.setQueryData(["savedRepos", userId], (old: any) => {
        if (!old) return old;
        
        const isSaved = old.pages.some((page: any[]) => page.some((item) => item.repo_id === repoId));
        if (isSaved) return old; // Already saved, no UI change needed for the lists view

        const newPages = [...old.pages];
        const newSavedItem = {
          activity_id: `temp-${Date.now()}`,
          user_id: userId,
          repo_id: repoId,
          is_saved: true,
          repo: { repo_id: repoId, name: repoName }
        };
        
        if (newPages.length > 0) {
          newPages[0] = [newSavedItem, ...newPages[0]];
        } else {
          newPages.push([newSavedItem]);
        }
        return { ...old, pages: newPages };
      });

      return { previousRepos };
    },
    onError: (_error, _variables, context) => {
      if (context?.previousRepos) {
        queryClient.setQueryData(["savedRepos", userId], context.previousRepos);
      }
    },
    onSuccess: async () => {
      await queryClient.resetQueries({ queryKey: ["feed", userId], exact: true });
    },
    onSettled: () => {
      // Invalidate both boards (their counts might have changed) and savedRepos
      queryClient.invalidateQueries({ queryKey: ["savedRepos", userId] });
      queryClient.invalidateQueries({ queryKey: ["boards", userId] });
      queryClient.invalidateQueries({ queryKey: ["profile-content", userId] });
    },
  });

  return {
    createBoardMutation,
    addRepoToBoardMutation,
  };
}
