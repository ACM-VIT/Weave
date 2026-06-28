import { Stack } from "expo-router";
import { StatusBar } from "expo-status-bar";

export default function AuthLayout() {
  return (
    <>
      <StatusBar style="light" />
      <Stack initialRouteName="sign-up" screenOptions={{ headerShown: false }} />
    </>
  );
}
