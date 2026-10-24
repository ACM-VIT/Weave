import { useReducedMotion } from 'react-native-reanimated';
import { KeyboardForm } from '@/components/keyboard/keyboard-layout';
import React, { useState } from "react"
import { ActivityIndicator, Modal, Pressable, Text, TextInput, View, useWindowDimensions } from "react-native"
import { LogOut } from "lucide-react-native"
import { router, type Href } from "expo-router"
import { SafeAreaProvider, useSafeAreaInsets } from "react-native-safe-area-context"
import { useQuery } from "@tanstack/react-query"
import { API_URL } from "@/api/config"
import { apiV2 } from "@/api/client"
import { useProfileSections } from "@/hooks/useProfileSections"
import { ProfileHeader } from "@/components/profile/ProfileHeader"
import { ProfileContentLists } from "@/components/profile/ProfileContentLists"
import { ConnectionSheet, type ProfileStatType } from "@/components/connection-sheet"
import { useAuth } from "@/store/AuthContext"
import { getStorageItem } from "@/utils/storage"
import { formatCompactCount } from "@/utils/format-count"
import { isValidUsername, USERNAME_GUIDANCE } from "@/utils/username"
import { loadPinnedRepositories } from "@/services/pinnedRepositoryStorage"
import { GitHubUnlinkPanel } from '@/components/onboarding/GitHubUnlinkPanel'
import { GitHubImportPanel } from '@/components/onboarding/GitHubImportPanel'
import { APP_THEME, Fonts, Spacing } from '@/constants/theme'

function requestError(error: unknown, fallback: string) {
  if (error instanceof TypeError) return `Unable to connect to the local backend at ${API_URL}.`
  return error instanceof Error ? error.message : fallback
}

function boardHref(params: Record<string, string>): Href {
  // The route is introduced by the incoming merge; Expo's ignored generated
  // route declaration can remain stale until the next development server run.
  return { pathname: "/board", params } as unknown as Href
}

export default function ProfileScreen() {
  const { width, height } = useWindowDimensions()
  const insets = useSafeAreaInsets()
  const { user, signOut, checkOnboardingStatus, updateUserProfile } = useAuth()
  const isTablet = width >= 768
  const isCompact = height < 750 || width < 360
  const reducedMotion = useReducedMotion()
  const [editVisible, setEditVisible] = useState(false)
  const [githubPreferencesVisible, setGithubPreferencesVisible] = useState(false)
  const [githubControlRevision, setGithubControlRevision] = useState(0)
  const [logoutVisible, setLogoutVisible] = useState(false)
  const [loggingOut, setLoggingOut] = useState(false)
  const [logoutError, setLogoutError] = useState("")
  const name = typeof user?.full_name === "string" ? user.full_name : ""
  const job = typeof user?.bio === "string" ? user.bio : ""
  const username = user?.username ?? ""
  const [draft, setDraft] = useState({ name, job, username })
  const [isSaving, setIsSaving] = useState(false)
  const [editError, setEditError] = useState("")
  const [statSheetType, setStatSheetType] = useState<ProfileStatType | null>(null)
  const sections = useProfileSections(user?.user_id)
  const pinnedRepositoriesQuery = useQuery({
    queryKey: ["pinned-repositories", user?.user_id],
    enabled: Boolean(user?.user_id),
    queryFn: () => loadPinnedRepositories(user!.user_id),
    staleTime: Infinity,
  })
  const openEditor = () => {
    setDraft({ name, job, username })
    setEditError("")
    setEditVisible(true)
  }

  const saveDetails = async () => {
    const next = { name: draft.name.trim(), job: draft.job.trim(), username: draft.username.trim() }
    if (!next.name) return setEditError("Name is required.")
    if (!next.job) return setEditError("Job role is required.")
    if (!isValidUsername(next.username)) return setEditError(USERNAME_GUIDANCE)

    setIsSaving(true)
    setEditError("")
    try {
      const accessToken = await getStorageItem("access_token")
      if (!accessToken) throw new Error("Your session has expired. Please log in again.")
      const updated = await apiV2<{
        full_name: string | null
        bio: string | null
        username: string
      }>("/users/me", {
        method: "PATCH",
        body: JSON.stringify({ username: next.username, full_name: next.name, bio: next.job }),
      }, accessToken)
      const updatedProfile = {
        name: updated.full_name ?? "",
        job: updated.bio ?? "",
        username: updated.username,
      }
      updateUserProfile({
        username: updated.username,
        full_name: updated.full_name,
        bio: updated.bio,
      })
      setDraft(updatedProfile)
      setEditVisible(false)
      void checkOnboardingStatus().catch((error) => {
        console.error("Failed to refresh the saved profile", error)
      })
    } catch (error) {
      setEditError(requestError(error, "Unable to update your profile."))
    } finally {
      setIsSaving(false)
    }
  }

  const confirmLogout = async () => {
    setLoggingOut(true)
    setLogoutError("")
    try {
      await signOut()
      setLogoutVisible(false)
      router.replace("/(auth)/login")
    } catch (error) {
      setLogoutError(error instanceof Error ? error.message : "Unable to log out.")
    } finally {
      setLoggingOut(false)
    }
  }

  const stats = [
    { value: formatCompactCount(user?.likes_given_count), label: "likes given", onPress: () => setStatSheetType("likes") },
    { value: formatCompactCount(user?.saved_repos_count), label: "saved", onPress: () => setStatSheetType("saved") },
    { value: formatCompactCount(user?.followers_count), label: "followers", onPress: () => setStatSheetType("followers") },
    { value: formatCompactCount(user?.following_count), label: "following", onPress: () => setStatSheetType("following") },
  ]

  const horizontalPadding = isTablet ? 48 : 24
  const header = (
      <View className="w-full" style={{ maxWidth: isTablet ? 760 : 600, gap: isTablet ? 34 : 28 }}>
        <View className="w-full" style={{ gap: isTablet ? 34 : 28 }}>
          <View className="w-full" style={{ gap: isTablet ? 30 : 25 }}>
            <ProfileHeader username={username} name={name} job={job} isTablet={isTablet} isCompact={isCompact} stats={stats} onEdit={openEditor} onLogout={() => { setLogoutError(""); setLogoutVisible(true) }} />
          </View>

          <View className="w-full" style={{ gap: isTablet ? 22 : 18 }}>
            <Pressable accessibilityRole="button" accessibilityLabel="GitHub activity preferences" accessibilityState={{ expanded: githubPreferencesVisible }}
              onPress={() => setGithubPreferencesVisible(value => !value)} style={{ minHeight: 48, justifyContent: 'center', paddingVertical: Spacing.two }}>
              <Text style={{ fontFamily: Fonts.sans, color: APP_THEME.primary, fontSize: 15 }}>GitHub activity preferences</Text>
            </Pressable>
            {githubPreferencesVisible && user ? <View><GitHubImportPanel key={`${user.user_id}:${githubControlRevision}`} userId={user.user_id} onSaved={checkOnboardingStatus} /><GitHubUnlinkPanel userId={user.user_id} onSaved={async () => { await checkOnboardingStatus(); setGithubControlRevision(value => value + 1) }} /></View> : null}
            <Text className="text-white font-nataBold" style={{ fontSize: isCompact ? 18 : 22 }}>Lists</Text>
          </View>
        </View>
      </View>

  )

  return (
    <View className="flex-1 bg-black">
      <ProfileContentLists
        viewer={user?.user_id} header={header} compact={isCompact}
        horizontalPadding={horizontalPadding} maxWidth={isTablet ? 760 : 600}
        paddingTop={Math.max(insets.top, 20) + (isTablet ? 28 : 16)}
        paddingBottom={Math.max(insets.bottom, 20) + (isTablet ? 28 : 16)}
        collections={sections.collections} pinned={pinnedRepositoriesQuery}
        openList={params => router.push(boardHref(params))}
      />

      <ConnectionSheet
        onClose={() => setStatSheetType(null)}
        onFollowingCountChange={() => {
          void checkOnboardingStatus().catch(() => undefined)
        }}
        onRepositoryPress={(href) => router.push(href)}
        type={statSheetType ?? "followers"}
        userId={user?.user_id}
        username={username}
        visible={statSheetType !== null}
      />

      <Modal visible={editVisible} animationType={reducedMotion ? "none" : "slide"} presentationStyle="pageSheet" onRequestClose={() => { if (!isSaving) setEditVisible(false) }}>
        <SafeAreaProvider>
        <KeyboardForm className="bg-[#080808]" contentContainerStyle={{ flexGrow: 1, justifyContent: "center", paddingHorizontal: "8%", paddingVertical: 24, gap: 16 }}>
          <Text accessibilityRole="header" className="text-white font-nataBold text-[27px]">Edit profile</Text>
          {[
            { key: "username" as const, label: "Username" },
            { key: "job" as const, label: "Bio" },
            { key: "name" as const, label: "Name" },
          ].map((field) => <View key={field.key} className="gap-2"><Text className="text-[#63E08A] font-nataMedium">{field.label}</Text><TextInput accessibilityLabel={field.label} editable={!isSaving} value={draft[field.key]} onChangeText={(value) => setDraft((current) => ({ ...current, [field.key]: value }))} autoCapitalize={field.key === "username" ? "none" : "sentences"} className="min-h-[54px] text-white bg-[#151515] rounded-[14px] px-[5%] font-nata text-base" /></View>)}
          {editError ? <Text accessibilityRole="alert" selectable className="text-[#FF6878] font-nata">{editError}</Text> : null}
          <Pressable accessibilityRole="button" accessibilityLabel="Save profile changes" accessibilityState={{ busy: isSaving }} disabled={isSaving} onPress={saveDetails} className="min-h-[54px] rounded-[14px] bg-[#63E08A] items-center justify-center" style={{ opacity: isSaving ? 0.7 : 1 }}>{isSaving ? <ActivityIndicator color="#071009" /> : <Text className="text-[#071009] font-nataBold text-base">Save changes</Text>}</Pressable>
          <Pressable disabled={isSaving} onPress={() => setEditVisible(false)} accessibilityRole="button" style={{ minHeight: 48, justifyContent: "center" }} className="items-center p-[3%]"><Text className="text-[#B8B8C0] font-nataMedium">Cancel</Text></Pressable>
        </KeyboardForm>
        </SafeAreaProvider>
      </Modal>

      <Modal visible={logoutVisible} transparent animationType="fade" onRequestClose={() => setLogoutVisible(false)}>
        <View className="flex-1 bg-black/80 items-center justify-center px-[8%]">
          <View className="w-full max-w-[420px] bg-[#151515] rounded-[22px] p-[7%] items-center gap-4" style={{ borderCurve: "continuous", boxShadow: "0 12px 40px rgba(0,0,0,0.55)" }}>
            <View className="w-[18%] max-w-[68px] aspect-square rounded-full bg-[#232323] items-center justify-center"><LogOut size={27} color="#63E08A" /></View>
            <Text className="text-white font-nataBold text-xl text-center">Log out?</Text>
            <Text className="text-[#8A898F] font-nata text-sm text-center">Are you sure you want to log out of your account?</Text>
            {logoutError ? <Text selectable className="text-[#FF6878] font-nata text-sm text-center">{logoutError}</Text> : null}
            <View className="w-full flex-row gap-3">
              <Pressable disabled={loggingOut} onPress={() => setLogoutVisible(false)} className="flex-1 min-h-[48px] rounded-[13px] bg-[#292929] items-center justify-center"><Text className="text-white font-nataSemiBold">Cancel</Text></Pressable>
              <Pressable disabled={loggingOut} onPress={confirmLogout} className="flex-1 min-h-[48px] rounded-[13px] bg-[#63E08A] items-center justify-center">{loggingOut ? <ActivityIndicator color="#071009" /> : <Text className="text-[#071009] font-nataBold">Log out</Text>}</Pressable>
            </View>
          </View>
        </View>
      </Modal>
    </View>
  )
}
