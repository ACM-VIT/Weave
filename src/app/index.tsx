<<<<<<< HEAD
import { Redirect } from "expo-router";

export default function IndexScreen() {
  return <Redirect href="/home" />;
=======
import { Redirect } from 'expo-router';

export default function RootIndex() {
  return <Redirect href="/(auth)/sign-up" />;
>>>>>>> bf6c2bc13d95ef71baa15d4f361017f4fc9658eb
}
