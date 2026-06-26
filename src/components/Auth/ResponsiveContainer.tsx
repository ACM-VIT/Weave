import { View } from "react-native";

/**
 * Centers content and caps max width for tablet/desktop layouts.
 * On small screens it takes full width. On tablets it constrains to 480px and centers.
 */
export default function ResponsiveContainer({ children }: { children: React.ReactNode }) {
  return (
    <View className="flex-1 items-center bg-[#0A0C09]">
      <View
        style={{ width: "100%", maxWidth: 480 }}
        className="flex-1"
      >
        {children}
      </View>
    </View>
  );
}
