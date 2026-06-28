import { View, Text } from "react-native"
import Svg, { Path, Circle } from "react-native-svg"
import RecentSaves from "./recentsaves"
import RecentPins from "./recentpins"

export default function Overview() {

  const recentsaves = [
    { id: 1, name: "Game development" },
    { id: 2, name: "UI / UX" },
    { id: 3, name: "Open Source" }
  ]

  const recentpins = [
    { id: 1, pin: "github-social-mobileapp" },
    { id: 2, pin: "weather-app" },
    { id: 3, pin: "task-manager" }
  ]

  return (
    <View style={{ width: '100%' }} className="relative flex-col justify-start">
      {/* Green timeline connector SVG */}
      <Svg
        style={{ position: 'absolute', left: -14, top: -35 }}
        width={26}
        height={409}
        viewBox="0 0 26 409"
        fill="none"
      >
        <Circle cx={4.00012} cy={4} r={3.5} stroke="#6DA963" />
        <Circle cx={4.0001} cy={4.0001} r={1.9} fill="white" stroke="#6DA963" />
        <Path d="M4.1403 165.087C4.1424 167.44 4.13971 164.423 4.1403 165.087ZM4.1403 165.087L4 8" stroke="#6DA963" />
        <Path d="M2 167C2.51325 167 3.09091 167 3.73848 167H26" stroke="#359030" />
        <Circle cx={4.00012} cy={167} r={3.5} stroke="#4A7947" />
        <Circle cx={4.0001} cy={167} r={2.4} fill="white" />
        <Path d="M4 171V388.127C4.52937 401.76 6.57275 406.671 15 408H26" stroke="#6DA963" />
      </Svg>

      <View 
        style={{ width: "100%", paddingBottom: 40 }}
        className="w-full"
      >
        {/* Recent Saves Box */}
        <View className="border border-[#6DA963] rounded-[10px] bg-[#191F18] px-4 pt-[24px] pb-[24px] w-full justify-start mt-0 mb-5">
          <View className="w-full px-1 flex-row justify-between items-center mb-[13px]">
            <Text className="text-[#6DA963] text-[12px] font-bold font-noto relative top-[-2px]">Recent Saves</Text>
            <Text className="text-[#6DA963] text-[10px] font-bold font-noto relative top-[-2px]">View All</Text>
          </View>
          {recentsaves.map((item) => (
            <RecentSaves key={item.id} title={item.name} />
          ))}
        </View>

        {/* Recent Pins Box */}
        <View className="border border-[#6DA963] rounded-[10px] bg-[#191F18] px-4 pt-[24px] pb-[24px] w-full justify-start">
          <View className="w-full px-1 mb-[13px]">
            <Text className="text-[#6DA963] text-[12px] font-bold font-noto relative top-[-2px]">Recent Pins</Text>
          </View>
          {recentpins.map((item) => (
            <RecentPins key={item.id} title={item.pin} isPinned={false} />
          ))}
        </View>
      </View>
    </View>
  )
}