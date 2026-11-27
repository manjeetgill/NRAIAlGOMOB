/**
 * The host this build was compiled to talk to - the same constant every request uses.
 *
 * Two screens need it: More prints it as the server's identity, and the broker screen puts it in every
 * instruction, because the actions that repair a dead broker session happen there rather than on the phone.
 */

import Constants from "expo-constants";

export function serverLine(): string {
  const url = Constants.API?.BASE_URL;
  if (!url) return "Not configured in this build";
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}
