import { View, Text, Image } from "react-native"

export default function RecentSaves({ title }: { title: string }) {
  return (
    // Row Dimensions: 307 x 39
    <View 
      className="w-full h-[39px] flex-row items-center rounded-[10px] overflow-hidden bg-[#3E433C] mb-[13px]"
    >
      <Image 
        source={require('../../assets/images/nebula.png')} 
        className="w-[39px] h-[39px] rounded-[10px]"
      />
      <Text className="text-white text-[16px] font-normal flex-1 font-noto ml-3 relative top-[-2px]">{title}</Text>
    </View>
  )
}