import React, { useState } from "react"
import { View, Pressable, Text, Modal, TextInput, useWindowDimensions } from "react-native"
import Svg, { Path } from "react-native-svg"
import { SafeAreaView } from "react-native-safe-area-context"
import Overview from "@/components/overview"
import Repositories from "@/components/repositories"
import Lists from "@/components/lists"
import {
  HeartIcon,
  FollowerUserIcon,
  BookmarkIcon,
  GroupFollowersIcon,
  PencilIcon,
  ProfileAvatarIcon,
} from "@/components/icons"
import { getResponsiveContentWidth } from "@/components/responsive-layout"

type TabName = "Overview" | "Repositories" | "Lists"

export default function ProfileScreen() {
  const { width } = useWindowDimensions()

  // Responsive breakpoints
  const isTablet = width >= 768
  const isSmallPhone = width < 360

  const contentMaxWidth = getResponsiveContentWidth(width) ?? width

  const [modal, setModal] = useState(false)
  const [name, setName] = useState("Navyaa Batra")
  const [job, setJob] = useState("Full Stack Developer")
  const [username, setUsername] = useState("navyaabatra")
  const [activetab, setActivetab] = useState<TabName>("Lists")

  const stats = [
    { id: "likes", value: "1.2K", label: "Likes given" },
    { id: "followers", value: "300", label: "Followers" },
    { id: "saved", value: "156", label: "Saved" },
    { id: "following", value: "289", label: "Following" },
  ]

  const getStatIcon = (id: string) => {
    const iconSize = isTablet ? 26 : isSmallPhone ? 18 : 22
    switch (id) {
      case "likes":
        return <HeartIcon width={iconSize} height={iconSize - 3} fill="#6DA963" />
      case "followers":
        return <GroupFollowersIcon width={iconSize} height={iconSize - 3} fill="#6DA963" />
      case "saved":
        return <BookmarkIcon width={iconSize - 7} height={iconSize - 3} fill="#6DA963" />
      case "following":
        return <FollowerUserIcon width={iconSize} height={iconSize} fill="#6DA963" />
      default:
        return null
    }
  }

  const avatarSize = isTablet ? 110 : isSmallPhone ? 72 : 92
  const nameFontSize = isTablet ? 22 : isSmallPhone ? 15 : 18
  const jobFontSize = isTablet ? 14 : 12
  const statValueSize = isTablet ? 16 : isSmallPhone ? 12 : 14
  const statLabelSize = isTablet ? 11 : isSmallPhone ? 9 : 10
  const tabFontSize = isTablet ? 16 : 14
  const tabGap = isTablet ? 80 : isSmallPhone ? 32 : 56
  const topMargin = isTablet ? 40 : isSmallPhone ? 20 : 32

  return (
    <View style={{ flex: 1, backgroundColor: "#090D0A" }}>
      <SafeAreaView style={{ flex: 1, backgroundColor: "#090D0A" }}>
        <View
          style={{
            flex: 1,
            alignItems: "center",
            paddingBottom: isTablet ? 20 : 20,
          }}
        >
          {/* ── Main Layout Container ── */}
          <View
            style={{
              width: "100%",
              maxWidth: contentMaxWidth,
              paddingHorizontal: isTablet ? 32 : 20,
              flexDirection: "column",
              flex: 1,
            }}
          >
            {/* ── Left Column (Header & Stats) ── */}
            <View
              style={{
                width: "100%",
                paddingTop: topMargin,
              }}
            >
              {/* Header: Avatar + Name/Job/Username */}
              <View
                style={{
                  flexDirection: isTablet ? "column" : "row",
                  alignItems: "center",
                }}
              >
                <View
                  style={{
                    width: avatarSize,
                    height: avatarSize,
                    justifyContent: "center",
                    alignItems: "center",
                  }}
                >
                  <ProfileAvatarIcon width={avatarSize} height={avatarSize} />
                </View>

                <View
                  style={{
                    marginLeft: isTablet ? 0 : 16,
                    marginTop: isTablet ? 16 : 0,
                    flex: isTablet ? undefined : 1,
                    alignItems: isTablet ? "center" : "flex-start",
                  }}
                >
                  <View style={{ flexDirection: "row", alignItems: "center" }}>
                    <Text
                      style={{
                        color: "white",
                        fontSize: nameFontSize,
                        fontWeight: "700",
                        letterSpacing: 0.5,
                        fontFamily: "NotoSans_400Regular",
                      }}
                    >
                      {name}
                    </Text>
                    <Pressable
                      style={{ marginLeft: 8, padding: 4 }}
                      onPress={() => setModal(true)}
                      hitSlop={8}
                    >
                      <PencilIcon size={isTablet ? 14 : 11} fill="#6DA963" />
                    </Pressable>
                  </View>

                  <Text
                    style={{
                      color: "#6DA963",
                      fontSize: jobFontSize,
                      fontWeight: "600",
                      marginTop: 2,
                      fontFamily: "NotoSans_400Regular",
                    }}
                  >
                    {job}
                  </Text>
                  <Text
                    style={{
                      color: "white",
                      fontSize: jobFontSize,
                      marginTop: 2,
                      fontFamily: "NotoSans_400Regular",
                    }}
                  >
                    @{username}
                  </Text>
                </View>
              </View>

              {/* Stats Row */}
              <View
                style={{
                  flexDirection: "row",
                  justifyContent: "space-between",
                  marginTop: isTablet ? 32 : 24,
                  alignItems: "center",
                }}
              >
                {stats.map((stat, index) => (
                  <React.Fragment key={stat.id}>
                    {index !== 0 && (
                      <Svg width={1} height={isTablet ? 72 : 62} viewBox="0 0 1 62" fill="none">
                        <Path
                          opacity={0.4}
                          d="M0.5 0C0.466667 1.03333 0.435 2.06667 0.405 3.1C0.135 12.4 0 21.7 0 31C0 40.3 0.135 49.6 0.405 58.9C0.435 59.9333 0.466667 60.9667 0.5 62C0.533333 60.9667 0.565 59.9333 0.595 58.9C0.865 49.6 1 40.3 1 31C1 21.7 0.865 12.4 0.595 3.1C0.565 2.06667 0.533333 1.03333 0.5 0Z"
                          fill="white"
                        />
                      </Svg>
                    )}
                    <View style={{ alignItems: "center", flex: 1 }}>
                      <View style={{ height: isTablet ? 32 : 28, justifyContent: "center", alignItems: "center" }}>
                        {getStatIcon(stat.id)}
                      </View>
                      <Text
                        style={{
                          color: "white",
                          fontSize: statValueSize,
                          fontWeight: "700",
                          marginTop: 4,
                          fontFamily: "NotoSans_400Regular",
                        }}
                      >
                        {stat.value}
                      </Text>
                      <Text
                        style={{
                          color: "rgba(255,255,255,0.8)",
                          fontSize: statLabelSize,
                          marginTop: 2,
                          textAlign: "center",
                          fontWeight: "500",
                          fontFamily: "NotoSans_400Regular",
                        }}
                      >
                        {stat.label}
                      </Text>
                    </View>
                  </React.Fragment>
                ))}
              </View>
            </View>

            {/* ── Right Column (Tabs & Content) ── */}
            <View
              style={{
                width: "100%",
                flex: 1,
                paddingTop: 0,
              }}
            >
              {/* Navigation Tabs */}
              <View
                style={{
                  flexDirection: "row",
                  justifyContent: "center",
                  gap: tabGap,
                  marginTop: isTablet ? 40 : 48,
                  marginBottom: 24,
                  paddingBottom: 2,
                }}
              >
                <Pressable onPress={() => setActivetab(activetab === "Overview" ? "Lists" : "Overview")} hitSlop={8}>
                  <Text
                    style={{
                      fontSize: tabFontSize,
                      fontWeight: "600",
                      letterSpacing: 0.5,
                      paddingBottom: 4,
                      fontFamily: "NotoSans_400Regular",
                      color: activetab === "Overview" ? "#6DA963" : "white",
                      borderBottomWidth: activetab === "Overview" ? 2 : 0,
                      borderBottomColor: "#6DA963",
                    }}
                  >
                    Overview
                  </Text>
                </Pressable>

                <Pressable onPress={() => setActivetab(activetab === "Repositories" ? "Lists" : "Repositories")} hitSlop={8}>
                  <Text
                    style={{
                      fontSize: tabFontSize,
                      fontWeight: "600",
                      letterSpacing: 0.5,
                      paddingBottom: 4,
                      fontFamily: "NotoSans_400Regular",
                      color: activetab === "Repositories" ? "#6DA963" : "white",
                      borderBottomWidth: activetab === "Repositories" ? 2 : 0,
                      borderBottomColor: "#6DA963",
                    }}
                  >
                    Repositories
                  </Text>
                </Pressable>
              </View>

              {/* Tab Content */}
              <View style={{ flex: 1, width: "100%" }}>
                {activetab === "Overview" && <Overview />}
                {activetab === "Repositories" && <Repositories />}
                {activetab === "Lists" && <Lists />}
              </View>
            </View>
          </View>
        </View>
      </SafeAreaView>

      {/* ── Edit Profile Modal ── */}
      <Modal visible={modal} animationType="slide" transparent={false}>
        <View style={{ flex: 1, backgroundColor: "#090D0A", justifyContent: "center", alignItems: "center", padding: 24 }}>
          <View style={{ width: "100%", maxWidth: isTablet ? 480 : 360 }}>
            <Text
              style={{
                color: "white",
                fontSize: isTablet ? 24 : 20,
                fontWeight: "700",
                marginBottom: 24,
                borderBottomWidth: 1,
                borderBottomColor: "#232D25",
                paddingBottom: 8,
                textAlign: "center",
                fontFamily: "NotoSans_400Regular",
              }}
            >
              Edit Profile
            </Text>

            {[
              { label: "Full Name", value: name, setter: setName },
              { label: "Job Role", value: job, setter: setJob },
              { label: "Username", value: username, setter: setUsername },
            ].map((field, i, arr) => (
              <View key={field.label}>
                <Text
                  style={{
                    color: "#6DA963",
                    fontSize: 12,
                    fontWeight: "700",
                    marginBottom: 6,
                    textTransform: "uppercase",
                    fontFamily: "NotoSans_400Regular",
                  }}
                >
                  {field.label}
                </Text>
                <TextInput
                  style={{
                    backgroundColor: "#141915",
                    color: "white",
                    borderRadius: 12,
                    padding: isTablet ? 16 : 14,
                    borderWidth: 1,
                    borderColor: "#232D25",
                    marginBottom: i === arr.length - 1 ? 32 : 16,
                    fontSize: isTablet ? 16 : 14,
                    fontFamily: "NotoSans_400Regular",
                  }}
                  value={field.value}
                  onChangeText={field.setter}
                  placeholderTextColor="#444"
                />
              </View>
            ))}

            <Pressable
              style={{ backgroundColor: "#6DA963", paddingVertical: isTablet ? 18 : 16, borderRadius: 12, alignItems: "center" }}
              onPress={() => setModal(false)}
            >
              <Text
                style={{
                  fontWeight: "700",
                  color: "#090D0A",
                  textTransform: "uppercase",
                  letterSpacing: 1,
                  fontSize: 12,
                  fontFamily: "NotoSans_400Regular",
                }}
              >
                Save Details
              </Text>
            </Pressable>

            <Pressable style={{ marginTop: 16, alignItems: "center" }} onPress={() => setModal(false)}>
              <Text style={{ color: "#6DA963", fontSize: 14, fontFamily: "NotoSans_400Regular" }}>Cancel</Text>
            </Pressable>
          </View>
        </View>
      </Modal>
    </View>
  )
}
