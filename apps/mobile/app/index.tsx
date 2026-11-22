import { Redirect } from "expo-router";
import { useAuthStore } from "@nraialgo/shared/stores";

export default function Index() {
  const isAuthenticated = useAuthStore((state) => state.isAuthenticated);
  return <Redirect href={isAuthenticated ? "/(tabs)/watchlist" : "/login"} />;
}
