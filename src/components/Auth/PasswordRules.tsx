import { Text, View } from "react-native";


function Rule({ text, met }: { text: string; met: boolean }) {
  return (
    <View className="flex-row items-center mt-2">
      <View className={`w-3 h-3 rounded-full border border-[#6DA963] justify-center items-center ${met ? 'bg-[#6DA963]' : ''}`} />

      <Text
        className="text-[#9B9B9B] ml-3 text-[12px] font-nata"
      >
        {text}
      </Text>
    </View>
  );
}

export default function PasswordRules({ password = "" }: { password?: string }) {
  const hasMinLength = password.length >= 8;
  const hasNumber = /\d/.test(password);
  const hasUppercase = /[A-Z]/.test(password);

  return (
    <View className="mt-5">
      <Rule text="At least 8 characters" met={hasMinLength} />
      <Rule text="Includes a number" met={hasNumber} />
      <Rule text="Includes an uppercase letter" met={hasUppercase} />
    </View>
  );
}