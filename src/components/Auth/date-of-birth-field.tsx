import AuthInput from './AuthInput';

interface DateOfBirthFieldProps {
  value: string;
  onChange: (value: string) => void;
}

export default function DateOfBirthField({ value, onChange }: DateOfBirthFieldProps) {
  return (
    <AuthInput
      placeholder="YYYY-MM-DD"
      value={value}
      onChangeText={onChange}
      keyboardType="numbers-and-punctuation"
      maxLength={10}
      autoComplete="birthdate-full"
    />
  );
}
