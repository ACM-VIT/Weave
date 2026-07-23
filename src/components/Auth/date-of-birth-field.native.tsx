import DateTimePicker, { type DateTimePickerEvent } from '@react-native-community/datetimepicker';
import { useMemo, useState } from 'react';
import { Platform, Pressable, Text, View } from 'react-native';

import { formatDateOfBirth } from '@/utils/date-of-birth';

interface DateOfBirthFieldProps {
  value: string;
  onChange: (value: string) => void;
}

function initialPickerDate(value: string): Date {
  const parsed = /^\d{4}-\d{2}-\d{2}$/.test(value)
    ? new Date(`${value}T12:00:00`)
    : null;
  if (parsed && !Number.isNaN(parsed.getTime())) return parsed;
  const fallback = new Date();
  fallback.setFullYear(fallback.getFullYear() - 18);
  return fallback;
}

export default function DateOfBirthField({ value, onChange }: DateOfBirthFieldProps) {
  const [showPicker, setShowPicker] = useState(false);
  const maximumDate = useMemo(() => new Date(), []);
  const minimumDate = useMemo(() => new Date(1900, 0, 1), []);

  const handleChange = (event: DateTimePickerEvent, selectedDate?: Date) => {
    if (Platform.OS === 'android') setShowPicker(false);
    if (event.type === 'set' && selectedDate) onChange(formatDateOfBirth(selectedDate));
  };

  return (
    <View>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Select date of birth"
        onPress={() => setShowPicker(true)}
        className="h-[46px] border border-[rgba(255,255,255,0.14)] rounded-xl bg-[#1C1C1E] px-4 justify-center"
      >
        <Text className={`font-nata text-[13px] ${value ? 'text-white' : 'text-[rgba(235,235,245,0.3)]'}`}>
          {value || 'Select your date of birth'}
        </Text>
      </Pressable>

      {showPicker ? (
        <View className="mt-2">
          <DateTimePicker
            value={initialPickerDate(value)}
            mode="date"
            display={Platform.OS === 'ios' ? 'spinner' : 'default'}
            minimumDate={minimumDate}
            maximumDate={maximumDate}
            onChange={handleChange}
            themeVariant="dark"
          />
          {Platform.OS === 'ios' ? (
            <Pressable onPress={() => setShowPicker(false)} className="items-end px-2 py-2">
              <Text className="font-nataSemiBold text-[#63E08A] text-[15px]">Done</Text>
            </Pressable>
          ) : null}
        </View>
      ) : null}
    </View>
  );
}
