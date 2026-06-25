import { View } from "react-native";
import { CameraIcon, SilhouetteIcon } from "./icons";

export default function ProfileAvatar() {
  return (
    <View className="items-center">
      <View className="relative w-[190px] h-[190px] justify-center items-center">
        <View className="absolute inset-0 rounded-full bg-[#1A281E]" />
        
        {/* Silhouette inside the big circle */}
        <SilhouetteIcon size={120} color="#3A5A40" />

        <View className="absolute bottom-2 right-2
        w-[55px] h-[55px]
        rounded-full border border-[#6DA963]
        bg-[#0A0C09] justify-center items-center">
          <CameraIcon size={24} color="#3A5A40" />
        </View>
      </View>
    </View>
  );
}