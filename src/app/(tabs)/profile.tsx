import { useReducedMotion } from 'react-native-reanimated';
import { KeyboardForm } from '@/components/keyboard/keyboard-layout';
import React, { useState } from "react"
import { ActivityIndicator, Modal, Pressable, Text, TextInput, View, useWindowDimensions } from "react-native"
import { LogOut, SquarePen } from "lucide-react-native"
import { router, type Href } from "expo-router"
import { SafeAreaProvider, useSafeAreaInsets } from "react-native-safe-area-context"
import { useQuery } from "@tanstack/react-query"
import { API_URL } from "@/api/config"
import { apiV2 } from "@/api/client"
import { useProfileSections } from "@/hooks/useProfileSections"
import { ProfileContentLists } from "@/components/profile/ProfileContentLists"
import { ConnectionSheet, type ProfileStatType } from "@/components/connection-sheet"
import { useAuth } from "@/store/AuthContext"
import { getStorageItem } from "@/utils/storage"
import { formatCompactCount } from "@/utils/format-count"
import { isValidUsername, USERNAME_GUIDANCE } from "@/utils/username"
import { loadPinnedRepositories } from "@/services/pinnedRepositoryStorage"

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

  const contentGap = isCompact ? 10 : isTablet ? 16 : 13
  const avatarLetter = username.trim().charAt(0).toUpperCase() || name.charAt(0).toUpperCase() || "?"
  const usernameText = username ? `@${username}` : ""
  const horizontalPadding = isTablet ? 48 : 24
  const contentWidth = Math.min(Math.max(width - (horizontalPadding * 2), 0), isTablet ? 760 : 600)
  const avatarWidth = Math.min(contentWidth * (isTablet ? 0.31 : 0.25), 116)
  const headerGapWidth = contentWidth * 0.08
  const actionIconWidth = isCompact ? 21 : 26
  const detailsWidth = Math.max(contentWidth - avatarWidth - headerGapWidth - actionIconWidth, 1)
  const usernameWidth = Math.max(detailsWidth - (detailsWidth * 0.03) - (isCompact ? 17 : 20), 1)
  const fitSingleLineText = (value: string, baseSize: number, availableWidth: number) => {
    const widthUnits = Array.from(value).reduce((total, character) => {
      if (character === " ") return total + 0.32
      if (/[ilI1.,'`]/.test(character)) return total + 0.3
      if (/[MW@#%&]/.test(character)) return total + 0.9
      return total + 0.58
    }, 0)
    return Math.max(1, Math.min(baseSize, Math.floor((availableWidth * 0.94) / Math.max(widthUnits, 1))))
  }
  const primaryFontSize = fitSingleLineText(usernameText, isCompact ? 17 : isTablet ? 23 : 21, usernameWidth)
  const jobFontSize = fitSingleLineText(job, isCompact ? 12 : 15, detailsWidth)
  const fullNameFontSize = fitSingleLineText(name, isCompact ? 11 : 14, detailsWidth)

  const header = (
      <View className="w-full" style={{ maxWidth: isTablet ? 760 : 600, gap: isTablet ? 34 : 28 }}>
        <View className="w-full" style={{ gap: isTablet ? 34 : 28 }}>
          <View className="w-full" style={{ gap: isTablet ? 30 : 25 }}>
            <View className="w-full flex-row items-center" style={{ minHeight: isCompact ? 74 : isTablet ? 128 : 96, gap: "4%" }}>
              <View className="items-center justify-center bg-[#9B4FE4]" style={{ width: isTablet ? "31%" : "25%", maxWidth: 116, aspectRatio: 1, borderRadius: 999 }}><Text className="text-white font-nataBold" style={{ fontSize: isCompact ? 25 : isTablet ? 38 : 32 }}>{avatarLetter}</Text></View>
              <View className="flex-1 justify-center" style={{ minWidth: 0 }}>
                <View className="w-full flex-row items-start" style={{ gap: "3%" }}>
                  <Text selectable numberOfLines={1} adjustsFontSizeToFit minimumFontScale={0.05} className="flex-1 text-white font-nataBold" style={{ flexShrink: 1, fontSize: primaryFontSize, lineHeight: Math.ceil(primaryFontSize * 1.2) }}>{usernameText}</Text>
                  <Pressable accessibilityRole="button" accessibilityLabel="Edit profile" onPress={openEditor} style={{ minWidth: 48, minHeight: 48 }} className="items-center justify-center"><SquarePen size={isCompact ? 17 : 20} color="#97969C" /></Pressable>
                </View>
                <Text numberOfLines={1} adjustsFontSizeToFit minimumFontScale={0.05} className="text-[#8A898F] font-nata" style={{ flexShrink: 1, fontSize: jobFontSize, lineHeight: Math.ceil(jobFontSize * 1.25) }}>{job}</Text>
                <Text selectable numberOfLines={1} adjustsFontSizeToFit minimumFontScale={0.05} className="text-[#68676D] font-nata" style={{ flexShrink: 1, fontSize: fullNameFontSize, lineHeight: Math.ceil(fullNameFontSize * 1.25) }}>{name}</Text>
              </View>
              <Pressable accessibilityLabel="Log out" onPress={() => { setLogoutError(""); setLogoutVisible(true) }} hitSlop={12} className="self-start items-center justify-center" style={{ paddingTop: "3%" }}><LogOut size={isCompact ? 21 : 26} color="#96959B" /></Pressable>
            </View>

            <View
              className="w-full flex-row self-center"
              style={{
                maxWidth: isTablet ? 560 : 480,
                paddingVertical: isTablet ? 12 : 8,
                gap: isCompact ? 2 : 4,
              }}
            >
              {stats.slice(0, 2).map((stat) => <Pressable key={stat.label} accessibilityRole="button" onPress={stat.onPress} className="flex-1 items-center justify-center rounded-[10px]" style={({ pressed }) => ({ minWidth: 0, paddingVertical: 5, opacity: pressed ? 0.68 : 1, backgroundColor: pressed ? "#171717" : "transparent" })}>
                <Text className="text-white font-nataBold" style={{ fontSize: isCompact ? 15 : 19, fontVariant: ["tabular-nums"] }}>{stat.value}</Text>
                <Text numberOfLines={1} className="text-[#77767C] font-nata" style={{ fontSize: isCompact ? 9 : 12 }}>{stat.label}</Text>
              </Pressable>)}
              <View className="flex-[2] flex-row">
                {stats.slice(2).map((stat, index) => <Pressable key={stat.label} accessibilityRole="button" onPress={stat.onPress} className="flex-1 items-center justify-center rounded-[9px]" style={({ pressed }) => ({ minWidth: 0, paddingVertical: 4, opacity: pressed ? 0.68 : 1, backgroundColor: pressed ? "#202020" : "transparent", borderLeftWidth: index === 1 ? 0.5 : 0, borderLeftColor: "#292929" })}>
                  <Text className="text-white font-nataBold" style={{ fontSize: isCompact ? 15 : 19, fontVariant: ["tabular-nums"] }}>{stat.value}</Text>
                  <Text numberOfLines={1} className="text-[#77767C] font-nata" style={{ fontSize: isCompact ? 9 : 12 }}>{stat.label}</Text>
                </Pressable>)}
              </View>
            </View>
          </View>

          <View className="w-full" style={{ gap: isTablet ? 22 : 18 }}>
            <Text className="text-white font-nataBold" style={{ fontSize: isCompact ? 18 : 22 }}>Lists</Text>
          </View>
        </View>
      </View>

  )

  return (
    <View className="flex-1 bg-black">
      <ProfileContentLists
        viewer={user?.user_id}
        header={header}
        compact={isCompact}
        gap={contentGap}
        horizontalPadding={horizontalPadding}
        maxWidth={isTablet ? 760 : 600}
        paddingTop={Math.max(insets.top, 20) + (isTablet ? 28 : 16)}
        paddingBottom={Math.max(insets.bottom, 20) + (isTablet ? 28 : 16)}
        boards={sections.boards}
        collections={sections.collections}
        pinned={pinnedRepositoriesQuery}
        openList={params => router.push(boardHref(params))}
      />

      <ConnectionSheet
        onClose={() => setStatSheetType(null)}
        onFollowingCountChange={() => {
          void checkOnboardingStatus().catch(() => undefined)
        }}
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
