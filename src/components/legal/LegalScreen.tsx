import { useRouter } from 'expo-router';
import { Pressable, ScrollView, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

export type LegalSection = {
  heading: string;
  paragraphs: string[];
};

export default function LegalScreen({
  title,
  updated,
  sections,
}: {
  title: string;
  updated: string;
  sections: LegalSection[];
}) {
  const router = useRouter();
  const insets = useSafeAreaInsets();

  return (
    <ScrollView
      className="flex-1 bg-black"
      contentContainerStyle={{
        paddingTop: Math.max(insets.top, 20) + 16,
        paddingBottom: Math.max(insets.bottom, 20) + 32,
        paddingHorizontal: 24,
      }}
    >
      <View className="w-full max-w-[720px] self-center">
        <Pressable accessibilityRole="button" onPress={() => router.back()} className="self-start py-3 pr-6">
          <Text className="text-[#63E08A] font-nataSemiBold">Back</Text>
        </Pressable>
        <Text className="text-white text-[30px] font-nataBold mt-5">{title}</Text>
        <Text className="text-[#77767C] text-[13px] font-nata mt-2 mb-8">Last updated {updated}</Text>
        {sections.map((section) => (
          <View key={section.heading} className="mb-7">
            <Text className="text-white text-[19px] font-nataBold mb-3">{section.heading}</Text>
            {section.paragraphs.map((paragraph) => (
              <Text key={paragraph} className="text-[#B3B2B8] text-[14px] leading-6 font-nata mb-3">
                {paragraph}
              </Text>
            ))}
          </View>
        ))}
      </View>
    </ScrollView>
  );
}
