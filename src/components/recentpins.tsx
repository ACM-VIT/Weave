import { View, Text } from "react-native"
import { GitBranchDocIcon, PushPinIcon } from "./icons"

export default function RecentPins({ title, isPinned }: { title: string, isPinned?: boolean }) {
  return (
    // Row Dimensions: 307 x 39
    <View 
      className="w-full h-[39px] flex-row items-center rounded-[10px] overflow-hidden pr-3 bg-[#3E433C] mb-[13px]"
    >
      <View className="w-[39px] h-[39px] items-center justify-center mr-3">
        <GitBranchDocIcon width={17} height={20} fill="#6DA963" />
      </View>
      <Text className="text-white text-[16px] font-normal flex-1 font-noto relative top-[-2px]">{title}</Text>
      {isPinned && <PushPinIcon width={14} height={13} fill="#6DA963" />}
    </View>
  )
}