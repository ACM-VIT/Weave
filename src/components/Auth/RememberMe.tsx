import { useState } from "react";
import { Text, View, TouchableOpacity } from "react-native";
import Svg, { Path } from "react-native-svg";

export default function RememberMe() {
  const [isChecked, setIsChecked] = useState(false);

  return (
    <View className="flex-row justify-between items-center mt-5">
      <TouchableOpacity 
        activeOpacity={0.7} 
        onPress={() => setIsChecked(!isChecked)}
        className="flex-row items-center"
      >
        <View className={`w-4 h-4 border border-[#6DA963] rounded-[3px] justify-center items-center ${isChecked ? 'bg-[#6DA963]' : ''}`}>
          {isChecked && (
            <Svg width="10" height="10" viewBox="0 0 24 24" fill="none">
              <Path d="M20 6L9 17l-5-5" stroke="#0A0C09" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" />
            </Svg>
          )}
        </View>

        <Text
          className="text-[#8A8A8A] text-[13px] ml-3 font-nata"
        >
          Remember me
        </Text>
      </TouchableOpacity>
    </View>
  );
}