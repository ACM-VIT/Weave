import { View, Text, useWindowDimensions } from "react-native"
import Svg, { Path, Circle } from "react-native-svg"
import RecentPins from "./recentpins"

export default function Repositories() {
  const { width } = useWindowDimensions();
  const isTablet = width >= 768;

  const pinnedRepos = [
    { id: 1, pin: "github-social-mobileapp" },
    { id: 2, pin: "weather-app" },
    { id: 3, pin: "task-manager" }
  ]

  const allRepos = [
    { id: 4, pin: "notes-app" },
    { id: 5, pin: "calculator-app" },
    { id: 6, pin: "no-name-app" },
    { id: 7, pin: "stocks-app" }
  ]

  if (isTablet) {
    return (
      <View className="w-full border border-[#6DA963] rounded-[10px] bg-[#191F18] px-4 pt-[24px] pb-[24px] justify-start relative overflow-visible">
        {/* Right segment (aligned to left of Repositories tab) */}
        <Svg
          pointerEvents="none"
          style={{
            position: 'absolute',
            left: '50%',
            marginLeft: -16,
            top: -42,
            width: 20,
            height: 30
          }}
          viewBox="0 0 20 30"
          fill="none"
        >
          <Circle cx={16} cy={4} r={3.5} stroke="#6DA963" />
          <Circle cx={16} cy={4} r={1.9} fill="white" stroke="#6DA963" />
          <Path d="M16 7.5 L16 22 Q16 28 10 28 L0 28" stroke="#6DA963" strokeWidth="1.5" fill="none" />
        </Svg>

        {/* Floating middle line */}
        <View
          pointerEvents="none"
          style={{
            position: 'absolute',
            left: 32,
            right: '50%',
            marginRight: 16,
            top: -14.5,
            height: 1.5,
            backgroundColor: '#6DA963'
          }}
        />

        {/* Left segment (floating dot and vertical drop) */}
        <Svg
          pointerEvents="none"
          style={{
            position: 'absolute',
            left: 24,
            top: -18,
            width: 16,
            height: 20
          }}
          viewBox="0 0 16 20"
          fill="none"
        >
          <Circle cx={8} cy={4} r={3.5} stroke="#6DA963" />
          <Circle cx={8} cy={4} r={1.9} fill="white" stroke="#6DA963" />
          <Path d="M8 7.5 L8 20" stroke="#6DA963" strokeWidth="1.5" fill="none" />
        </Svg>

        <View style={{ width: '100%' }}>
          {pinnedRepos.map((item) => (
            <RecentPins key={item.id} title={item.pin} isPinned={true} />
          ))}

          <View className="w-full px-1 mb-3.5 mt-4">
            <Text className="text-[#6DA963] text-[12px] font-bold font-noto relative top-[-2px]">All Repositories</Text>
          </View>

          {allRepos.map((item) => (
            <RecentPins key={item.id} title={item.pin} isPinned={false} />
          ))}
        </View>
      </View>
    )
  }

  return (
    // Repositories Box
    <View className="w-full border border-[#6DA963] rounded-[10px] bg-[#191F18] px-4 pt-[24px] pb-[24px] relative overflow-visible">
        {/* Right segment (aligned to left of Repositories tab) */}
        <Svg
          pointerEvents="none"
          style={{
            position: 'absolute',
            left: '50%',
            marginLeft: -16,
            top: -42,
            width: 20,
            height: 30
          }}
          viewBox="0 0 20 30"
          fill="none"
        >
          <Circle cx={16} cy={4} r={3.5} stroke="#6DA963" />
          <Circle cx={16} cy={4} r={1.9} fill="white" stroke="#6DA963" />
          <Path d="M16 7.5 L16 22 Q16 28 10 28 L0 28" stroke="#6DA963" strokeWidth="1.5" fill="none" />
        </Svg>

        {/* Floating middle line */}
        <View
          pointerEvents="none"
          style={{
            position: 'absolute',
            left: 32,
            right: '50%',
            marginRight: 16,
            top: -14.5,
            height: 1.5,
            backgroundColor: '#6DA963'
          }}
        />

        {/* Left segment (floating dot and vertical drop) */}
        <Svg
          pointerEvents="none"
          style={{
            position: 'absolute',
            left: 24,
            top: -18,
            width: 16,
            height: 20
          }}
          viewBox="0 0 16 20"
          fill="none"
        >
          <Circle cx={8} cy={4} r={3.5} stroke="#6DA963" />
          <Circle cx={8} cy={4} r={1.9} fill="white" stroke="#6DA963" />
          <Path d="M8 7.5 L8 20" stroke="#6DA963" strokeWidth="1.5" fill="none" />
        </Svg>
        
      <View style={{ width: '100%' }}>
        {pinnedRepos.map((item) => (
          <RecentPins key={item.id} title={item.pin} isPinned={true} />
        ))}

        <View className="w-full px-1 mb-[13px] mt-4">
          <Text className="text-[#6DA963] text-[12px] font-bold font-noto relative top-[-2px]">All Repositories</Text>
        </View>

        {allRepos.map((item) => (
          <RecentPins key={item.id} title={item.pin} isPinned={false} />
        ))}
      </View>
    </View>
  )
}