import React, { useEffect, useState } from "react";
import { Redirect } from "expo-router";
import { useAuthStore } from "@nraialgo/shared/stores";
import { unlockPlan, type UnlockPlan } from "@/utils/deviceUnlock";

/**
 * Where a cold start belongs. A signed-in session is the easy case, but a phone holding today's session
 * behind a fingerprint goes to the unlock screen instead of asking for a password it does not need.
 */
export default function Index() {
  const isAuthenticated = useAuthStore((state) => state.isAuthenticated);
  const [plan, setPlan] = useState<UnlockPlan | null>(null);

  useEffect(() => {
    let live = true;
    unlockPlan().then((value) => {
      if (live) setPlan(value);
    });
    return () => {
      live = false;
    };
  }, []);

  // Held for the moment the secure-storage read takes; rendering the wrong redirect first would land the
  // trader on the password screen and then bounce them back.
  if (plan === null) return null;
  // A stored session outranks the hydrated user record: that record is only what this phone last *believed*,
  // and showing its screens before the finger has passed would put positions on screen with no sign-in.
  if (plan.canUnlock) return <Redirect href="/unlock" />;
  // A reason means this phone held today's session and can no longer use it, so the record's "signed in" is
  // already known to be stale. Sending the reason is what puts the sentence about the new day on the screen
  // the trader actually lands on, instead of a cached tab that 401s a moment later.
  if (plan.reason) return <Redirect href={`/login?reason=${plan.reason}`} />;
  return <Redirect href={isAuthenticated ? "/(tabs)/watchlist" : "/login"} />;
}
