import { View, Text, useWindowDimensions } from "react-native"
import RecentPins from "./recentpins"
import RecentSaves from "./recentsaves"

export default function Lists() {
  const { width } = useWindowDimensions();
  const isTablet = width >= 768;

  const pinnedLists = [
    { id: 1, pin: "meal-planner" },
    { id: 2, pin: "QuickNotes" },
    { id: 3, pin: "Travel-mate" }
  ]

  const savedCollections = [
    { id: 1, name: "Game Development" },
    { id: 2, name: "UI / UX" },
    { id: 3, name: "Open Source" },
    { id: 4, name: "App Development" }
  ]

  if (isTablet) {
    return (
      <View className="w-full border border-[#6DA963] rounded-[10px] bg-[#191F18] px-4 pt-[24px] pb-[24px] justify-start">
        <View className="w-full px-1 mb-3.5 items-center">
          <Text className="text-white text-[15px] font-nataBold relative top-[-2px]">Lists</Text>
        </View>
        <View style={{ width: '100%' }}>
          {pinnedLists.map((item) => (
            <RecentPins key={item.id} title={item.pin} isPinned={true} />
          ))}

          <View className="w-full px-1 mb-3.5 mt-4">
            <Text className="text-[#6DA963] text-[12px] font-noto-bold relative top-[-2px]">Saved Collections</Text>
          </View>
          {savedCollections.map((item) => (
            <RecentSaves key={item.id} title={item.name} />
          ))}
        </View>
      </View>
    )
  }

  return (
    // Lists Box
    <View className="w-full border border-[#6DA963] rounded-[10px] bg-[#191F18] px-4 pt-[24px] pb-[24px]">
      <View className="w-full px-1 mb-3.5 items-center">
        <Text className="text-white text-[15px] font-bold font-nata sans relative top-[-2px]">Lists</Text>
      </View>
      
      <View style={{ width: '100%' }}>
        {pinnedLists.map((item) => (
          <RecentPins key={item.id} title={item.pin} isPinned={true} />
        ))}

        <View className="w-full px-1 mb-3.5 mt-4">
          <Text className="text-[#6DA963] text-[12px] font-bold font-noto sans relative top-[-2px]">Saved Collections</Text>
        </View>

        {savedCollections.map((item) => (
          <RecentSaves key={item.id} title={item.name} />
        ))}
      </View>
    </View>
  )
}