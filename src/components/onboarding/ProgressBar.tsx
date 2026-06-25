import { View } from "react-native";

type ProgressBarProps = {
  step: number;
  totalSteps: number;
};

export default function ProgressBar({
  step,
  totalSteps,
}: ProgressBarProps) {
  return (
    <View className="flex-row justify-between mt-2">
      {Array.from({ length: totalSteps }).map((_, index) => (
        <View
          key={index}
          className={`h-2 flex-1 rounded-full mx-1 ${
            index < step
              ? "bg-[#6DA963]"
              : "bg-[#5A5A5A]"
          }`}
        />
      ))}
    </View>
  );
}